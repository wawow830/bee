#!/usr/bin/env bun
// bee: minimal ACP agent harness over stdio.
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { version } from "./package.json";
import { BASH_TOOL, runBash } from "./src/bash";
import { isRetryable, loadModels, MAX_RETRIES, sanitizeHistory, streamReply } from "./src/providers";
import { createSessionStore } from "./src/sessions";
import {
  extractText,
  firstLine,
  isEmptyContent,
  makeToolResult,
  makeUserMessage,
  notice,
  parseJson,
  rpcError,
  type SessionLine,
  type StreamCallback,
  type ToolCall,
  type ToolResult,
  type Usage,
  type UserMessage,
} from "./src/types";

// stdout is reserved for ACP JSON-RPC framing.
console.log = console.error;

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee", "agent");
const models = await loadModels(HOME);
const sessions = createSessionStore(HOME, models, [BASH_TOOL]);

// ── ACP Notifications ───────────────────────────────────────────────────────

let clientSupportsCursors = false;

const sendRpc = (payload: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
const sendUpdate = (sessionId: string, update: object) =>
  sendRpc({ method: "session/update", params: { sessionId, update } });
const sendChunk = (
  sid: string,
  kind: "user_message" | "agent_message" | "agent_thought",
  text: string,
  messageId?: string,
) => text && sendUpdate(sid, { sessionUpdate: `${kind}_chunk`, messageId, content: { type: "text", text } });

const totalTokens = ({ input, output, cacheRead, cacheWrite }: Usage) => input + output + cacheRead + cacheWrite;
const callCommand = (call: ToolCall) => String(call.arguments.command ?? "");

function codeBlock(body: string, language = "") {
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${body.trim()}\n${fence}` } };
}

function emitUserMessage(sid: string, msg: UserMessage, cursor: number) {
  const messageId = randomUUID();
  sendChunk(sid, "user_message", extractText(msg.content), messageId);
  if (!clientSupportsCursors) return;
  sendUpdate(sid, {
    sessionUpdate: "cursor_update",
    cursorId: String(cursor),
    capabilities: { fork: {} },
    anchor: { type: "user_message", messageId, position: "before" },
  });
}

function emitSessionMeta(sid: string) {
  const title = sessions.title(sid);
  const used = sessions
    .read(sid)
    .map((line) => (line.reply ? totalTokens(line.reply.usage) : 0))
    .findLast(Boolean);
  const size = sessions.model(sid)?.contextWindow;
  if (title) sendUpdate(sid, { sessionUpdate: "session_info_update", title });
  if (used && size) sendUpdate(sid, { sessionUpdate: "usage_update", used, size });
}

function emitToolStart(sid: string, call: ToolCall) {
  sendUpdate(sid, {
    sessionUpdate: "tool_call",
    toolCallId: call.id,
    title: firstLine(callCommand(call)),
    kind: "execute",
    status: "in_progress",
    content: [codeBlock(callCommand(call), "bash")],
    rawInput: call.arguments,
  });
}

function emitToolResult(sid: string, call: ToolCall, result: ToolResult) {
  const output = result.content.map((block) =>
    block.type === "image" ? { type: "content", content: block } : codeBlock(block.text),
  );
  sendUpdate(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.id,
    status: result.failed ? "failed" : "completed",
    content: [codeBlock(callCommand(call), "bash"), ...output],
    rawOutput: extractText(result.content),
  });
}

function replaySession(sid: string) {
  const calls = new Map<string, ToolCall>();
  for (const [index, { user, reply, result }] of sessions.read(sid).entries()) {
    if (user) emitUserMessage(sid, user, index);
    if (result) {
      const call = calls.get(result.call)!;
      emitToolStart(sid, call);
      emitToolResult(sid, call, result);
    }
    for (const block of reply?.content ?? []) {
      if (block.type === "text") sendChunk(sid, "agent_message", block.text);
      if (block.type === "thinking") sendChunk(sid, "agent_thought", block.text);
      if (block.type === "call") calls.set(block.id, block);
    }
  }
}

function persist(sid: string, ...added: SessionLine[]) {
  sessions.append(sid, ...added);
  emitSessionMeta(sid);
}

// ── Agent Loop ──────────────────────────────────────────────────────────────

type ActiveTurn = { abort: AbortController; queued: UserMessage[]; done?: Promise<string> };
const activeTurns = new Map<string, ActiveTurn>();

function flushUserMessages(sid: string, queue: UserMessage[]) {
  for (const msg of queue.splice(0).filter((m) => !isEmptyContent(m.content))) {
    const cursor = sessions.read(sid).length;
    persist(sid, { user: msg });
    if (clientSupportsCursors) emitUserMessage(sid, msg, cursor);
  }
}

function needsReply(sid: string) {
  const last = sanitizeHistory(sessions.history(sid)).at(-1);
  return Boolean(last && !("reply" in last));
}

async function executeToolCall(sid: string, call: ToolCall, signal: AbortSignal) {
  emitToolStart(sid, call);
  const { content, failed } = await runBash(sessions.header(sid).cwd, call, signal).catch((error: Error) => ({
    content: [{ type: "text" as const, text: notice(error.message) }],
    failed: true,
  }));
  const result = makeToolResult(call, content, failed);
  emitToolResult(sid, call, result);
  return result;
}

async function requestReply(sid: string, signal: AbortSignal) {
  const { model, thinking, cache } = sessions.resolveConfig(sid);
  const onDelta: StreamCallback = (kind, delta) =>
    sendChunk(sid, kind === "text" ? "agent_message" : "agent_thought", delta);
  return streamReply(
    model,
    sessions.header(sid),
    sessions.history(sid),
    { origin: sessions.origin(sid), thinking, cache, signal },
    onDelta,
  );
}

async function runTurn(sid: string, { abort: { signal }, queued }: ActiveTurn): Promise<string> {
  let lastResults: ToolResult[] = [];
  let retries = 0;
  try {
    for (;;) {
      flushUserMessages(sid, queued);
      if (signal.aborted) return "cancelled";
      if (!needsReply(sid)) return "end_turn";

      const reply = await requestReply(sid, signal);
      // If tool output caused a 400/413 refusal, persist the refusal so sanitizeHistory replaces those results on retry.
      const retryRefusal = reply.end === "refused" && lastResults.length > 0;
      const calls = reply.end ? [] : reply.content.filter((block) => block.type === "call");
      lastResults = [];
      for (const call of calls) if (!signal.aborted) lastResults.push(await executeToolCall(sid, call, signal));

      // Write reply and its tool results in one append so tool calls and results never interleave with other writes.
      persist(sid, { reply }, ...lastResults.map((result) => ({ result })));
      if (retryRefusal) continue;

      retries = isRetryable(reply) ? retries + 1 : 0;
      if (retries && retries <= MAX_RETRIES) {
        await sleep(1000 * 2 ** (retries - 1), null, { signal }).catch(() => {});
        continue;
      }
      if (reply.end === "failed" || reply.end === "refused") throw new Error(reply.why);
      if (!calls.length && !queued.length && !signal.aborted) return reply.end === "cut" ? "max_tokens" : "end_turn";
    }
  } finally {
    // Delete turn before flushing so a write error can't leave a zombie turn absorbing future prompts.
    activeTurns.delete(sid);
    flushUserMessages(sid, queued);
  }
}

// ── ACP Handlers & Entrypoint ───────────────────────────────────────────────

function saveTempImage(bytes: Buffer, mimeType: string) {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const path = join(tmpdir(), `bee-${hash}.${mimeType.split("/")[1]}`);
  writeFileSync(path, bytes);
  return path;
}

const parsePromptBlocks = (blocks: any[]): UserMessage["content"] =>
  blocks.map((block) =>
    block.type === "image"
      ? { type: "text", text: saveTempImage(Buffer.from(block.data, "base64"), block.mimeType) }
      : block.type === "resource"
        ? { type: "text", text: `<file uri="${block.resource.uri}">\n${block.resource.text ?? ""}\n</file>` }
        : { type: "text", text: block.text ?? block.uri ?? "" },
  );

function openSession(sessionId: string) {
  emitSessionMeta(sessionId);
  return { sessionId, configOptions: sessions.configOptions(sessionId) };
}

const handlers: Record<string, (params: any) => unknown> = {
  initialize: ({ clientCapabilities }) => {
    clientSupportsCursors = Boolean(clientCapabilities?.session?.cursors);
    return {
      protocolVersion: 1,
      agentInfo: { name: "bee", title: "bee", version },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, fork: {} },
      },
    };
  },
  "session/new": ({ cwd }) => openSession(sessions.create(cwd)),
  "session/resume": ({ sessionId }) => openSession(sessionId),
  "session/load": ({ sessionId }) => {
    replaySession(sessionId);
    return openSession(sessionId);
  },
  "session/fork": ({ sessionId, cursorId }) => openSession(sessions.fork(sessionId, cursorId)),
  "session/list": ({ cwd }) => ({ sessions: sessions.list(cwd) }),
  "session/set_config_option": ({ sessionId, configId, value }) => {
    sessions.validateConfig(sessionId, configId, value);
    persist(sessionId, { [configId]: value });
    return { configOptions: sessions.configOptions(sessionId) };
  },
  "session/cancel": ({ sessionId }) => activeTurns.get(sessionId)?.abort.abort(),
  "session/prompt": async ({ sessionId, prompt }) => {
    const msg = makeUserMessage(parsePromptBlocks(prompt));
    let active = activeTurns.get(sessionId);
    if (active) active.queued.push(msg);
    else {
      active = { abort: new AbortController(), queued: [msg] };
      activeTurns.set(sessionId, active);
      active.done = runTurn(sessionId, active);
    }
    return { stopReason: await active.done };
  },
};

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const running = [...activeTurns.values()];
  for (const active of running) active.abort.abort();
  await Promise.allSettled(running.map((active) => active.done));
  process.exit();
}

for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(sig, shutdown);
process.stdout.on("error", () => {});

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = parseJson(line);
  if (!method) continue;
  const respond = (payload: object) => id !== undefined && sendRpc({ id, ...payload });
  const unknownMethod = () => Promise.reject(rpcError(-32601, `No method ${method}`));
  Promise.resolve(params ?? {})
    .then(Object.hasOwn(handlers, method) ? handlers[method] : unknownMethod)
    .then(
      (result) => respond({ result: result ?? {} }),
      (error) =>
        respond({ error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } }),
    );
}
await shutdown();
