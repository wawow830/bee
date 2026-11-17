#!/usr/bin/env bun
// bee: a minimal agent harness. ACP on stdio, one tool, one append-only file per session.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
  validateToolCall,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { CACHE_RETENTIONS, MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { version } from "./package.json";

console.log = console.error; // stdout carries the protocol and nothing else

/** An error the editor is told of, with its JSON-RPC code. */
const failure = (code: number, message: string) => Object.assign(new Error(message), { code });

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee", "agent");
const read = (path: string, otherwise = "") => (existsSync(path) ? readFileSync(path, "utf8") : otherwise);

// ── Models ──────────────────────────────────────────────────────────────────

/** models.json, as pi writes it: {"providers": {"anthropic": {"baseUrl": "...", "apiKey": "..."}}}. */
const MODELS = join(HOME, "models.json");
const models = builtinModels();
for (const [id, { apiKey, baseUrl }] of Object.entries<any>(JSON.parse(read(MODELS, "{}")).providers ?? {})) {
  const provider = models.getProvider(id);
  const resolve = async () => ({ auth: { apiKey, baseUrl }, source: MODELS });
  if (provider) models.setProvider({ ...provider, auth: { apiKey: { name: MODELS, resolve } } });
}
const available = await models.getAvailable();
const ref = (model: Model<Api>) => `${model.provider}/${model.id}`;

// ── Sessions ────────────────────────────────────────────────────────────────
// A session is a file of lines, written as things happen: messages, and the
// settings chosen. Lines are only appended, so every request begins with the
// last one, and the provider's cache of it holds. The first line is how the
// session began: its directory, the prompt and the tool, and the settings in
// settings.json.

type Settings = { model?: string; thinking?: string; cache?: string };
type Line = Settings & { message?: Message; cwd?: string };

const SESSIONS = join(HOME, "sessions");
const file = (sid: string) => join(SESSIONS, sid + ".jsonl");

const BASH = {
  name: "bash",
  description:
    "Runs a command in a new bash in the working directory. Returns what it wrote to stdout and stderr, cut to " +
    "20,000 characters, or the image it wrote.",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

/** AGENTS.md from ~/.bee/agent, then from every directory down to cwd. */
function instructions(cwd: string) {
  const dirs = [cwd];
  while (dirs[0] !== dirname(dirs[0])) dirs.unshift(dirname(dirs[0]));
  return [HOME, ...dirs]
    .map((dir) => join(dir, "AGENTS.md"))
    .filter(existsSync)
    .map((path) => `<file path="${path}">\n${read(path).trim()}\n</file>`)
    .join("\n\n");
}

/** How a session begins. */
const beginning = (cwd: string): Line => ({
  ...JSON.parse(read(join(HOME, "settings.json"), "{}")),
  cwd,
  message: {
    role: "system",
    content: `You are an agent in the bee harness.\n\n${instructions(cwd)}`.trim(),
    toolsAdded: [BASH],
    timestamp: Date.now(),
  },
});

/** A session's lines. One that is not JSON is empty. */
function lines(sid: string): Line[] {
  if (!/^[\w-]+$/.test(sid) || !existsSync(file(sid))) throw failure(-32002, `No session ${sid}`);
  const parse = (json: string) => {
    try {
      return JSON.parse(json) ?? {};
    } catch {
      return {};
    }
  };
  return read(file(sid)).trimEnd().split("\n").map(parse);
}

const append = (sid: string, line: Line) => appendFileSync(file(sid), JSON.stringify(line) + "\n");
const cwdOf = (sid: string) => lines(sid)[0].cwd!;

const conversation = (sid: string) => lines(sid).flatMap((line) => (line.message ? [line.message] : []));

/**
 * For each setting, the latest line that makes sense holds. Without one, the model is the first there is a key for,
 * thinking is medium, and the prompt stays cached for five minutes. ("long" is an hour.)
 */
function settings(sid: string) {
  if (!available.length) throw failure(-32000, "No provider key is set.");
  const all = lines(sid);
  const latest = <T>(pick: (line: Line) => T | undefined) => all.map(pick).findLast(Boolean);
  const model = latest((line) => available.find((one) => ref(one) === line.model)) ?? available[0];
  const level = latest((line) => MODEL_THINKING_LEVELS.find((level) => level === line.thinking)) ?? "medium";
  const cache = latest((line) => CACHE_RETENTIONS.find((retention) => retention === line.cache)) ?? "short";
  return { model, thinking: clampThinkingLevel(model, level), cache };
}

// ── The turn ────────────────────────────────────────────────────────────────

/** One reply from the model, streamed to the editor. */
async function ask(sid: string, signal: AbortSignal): Promise<AssistantMessage> {
  const { model, thinking, cache } = settings(sid);
  const reasoning = thinking === "off" ? undefined : thinking;
  const stream = models.streamSimple(
    model,
    { messages: conversation(sid) },
    {
      signal,
      sessionId: sid,
      reasoning,
      cacheRetention: cache,
    },
  );
  for await (const event of stream) {
    if (event.type === "text_delta") say(sid, "agent_message", event.delta);
    if (event.type === "thinking_delta") say(sid, "agent_thought", event.delta);
  }
  const reply = await stream.result();
  usage(sid, reply);
  return reply;
}

const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: Date.now() });

/** A turn under way: how to stop it, what the user said that it has not read, and how it ends. */
type Turn = { abort: AbortController; said: UserMessage[]; done?: Promise<string> };
const turns = new Map<string, Turn>();

/**
 * Read what the user said, ask, run what it asks for, and again until it has nothing to run and nothing more was
 * said. A prompt sent during a turn joins it, and the model reads it once the commands it is running end.
 */
async function turn(sid: string, { abort: { signal }, said }: Turn): Promise<string> {
  try {
    for (;;) {
      for (const message of said.splice(0)) append(sid, { message });
      if (signal.aborted) return "cancelled";
      const reply = await ask(sid, signal);
      const calls = reply.stopReason === "toolUse" ? reply.content.filter((block) => block.type === "toolCall") : [];
      append(sid, { message: reply });
      for (const call of calls) if (!signal.aborted) append(sid, { message: await run(sid, call, signal) });
      if (reply.stopReason === "error") throw new Error(reply.errorMessage);
      if (!calls.length && !said.length && !signal.aborted)
        return reply.stopReason === "length" ? "max_tokens" : "end_turn";
    }
  } finally {
    turns.delete(sid); // in the same step as the last look at what was said, so nothing said is left behind
  }
}

// ── The tool ────────────────────────────────────────────────────────────────

const SHOWN = 20_000; // characters of output the model sees per call

/** The images a model can see, by how their bytes begin. */
const IMAGES: Record<string, RegExp> = {
  "image/png": /^\x89PNG/,
  "image/jpeg": /^\xff\xd8\xff/,
  "image/gif": /^GIF8/,
  "image/webp": /^RIFF....WEBP/s,
};

/** Run a command. Returns what it wrote, as an image or as text cut to its two ends, and whether it failed. */
async function bash(sid: string, command: string, signal: AbortSignal) {
  // Written to a file, not a pipe, so the call ends when the command does, whatever it left running.
  const path = join(tmpdir(), `bee-${randomUUID()}`);
  const out = openSync(path, "w");
  // In its own process group, so an interrupt stops all of it.
  const child = spawn("bash", ["-c", command], { cwd: cwdOf(sid), stdio: ["ignore", out, out], detached: true });
  const interrupt = () => process.kill(-child.pid!, "SIGINT");
  signal.addEventListener("abort", interrupt);
  try {
    const [status] = await once(child, "exit");
    const written = readFileSync(path);
    const start = written.subarray(0, 12).toString("latin1");
    const mimeType = Object.keys(IMAGES).find((type) => IMAGES[type].test(start));
    const text = written.toString("utf8");
    const cut = text.length - SHOWN;
    const content: ToolResultMessage["content"] = mimeType
      ? [{ type: "image", data: written.toString("base64"), mimeType }]
      : [
          {
            type: "text",
            text: cut <= 0 ? text : `${text.slice(0, SHOWN / 2)}\n[${cut} characters cut]\n${text.slice(-SHOWN / 2)}`,
          },
        ];
    return { content, failed: status !== 0 };
  } finally {
    signal.removeEventListener("abort", interrupt);
    closeSync(out);
    rmSync(path);
  }
}

/** Run one tool call, shown to the editor. A call that is not a command is told why. */
async function run(sid: string, call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
  showCall(sid, call);
  const { content, failed } = await Promise.resolve()
    .then(() => bash(sid, validateToolCall([BASH], call).command, signal))
    .catch((error: Error) => ({ content: [{ type: "text" as const, text: error.message }], failed: true }));
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: failed,
    timestamp: Date.now(),
  };
  showResult(sid, call, result);
  return result;
}

// ── The editor ──────────────────────────────────────────────────────────────
// ACP: JSON-RPC, one message per line, on stdin and stdout.

const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId: string, fields: object) =>
  send({ method: "session/update", params: { sessionId, update: fields } });

const say = (sid: string, who: "user_message" | "agent_message" | "agent_thought", words: string) =>
  words && update(sid, { sessionUpdate: `${who}_chunk`, content: { type: "text", text: words } });

/** How full the context is: the tokens in the conversation, as the model counted them in a reply. */
const usage = (sid: string, reply: AssistantMessage) =>
  update(sid, {
    sessionUpdate: "usage_update",
    used: reply.usage.totalTokens,
    size: settings(sid).model.contextWindow,
  });

/** A message's content, as plain text. */
const plain = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");

/** A code block, fenced by more backticks than it holds. */
function fenced(body: string, language = "") {
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((ticks) => ticks[0].length + 1)));
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${body.trim()}\n${fence}` } };
}

const command = (call: ToolCall) => String(call.arguments.command ?? "");

function showCall(sid: string, call: ToolCall) {
  const shown = { toolCallId: call.id, title: command(call).trim().split("\n")[0].slice(0, 80), kind: "execute" };
  const content = [fenced(command(call), "bash")];
  update(sid, { sessionUpdate: "tool_call", ...shown, status: "in_progress", content, rawInput: call.arguments });
}

function showResult(sid: string, call: ToolCall, result: ToolResultMessage) {
  const status = result.isError ? "failed" : "completed";
  const output = result.content.map((block) =>
    block.type === "image" ? { type: "content", content: block } : fenced(block.text),
  );
  const content = [fenced(command(call), "bash"), ...output];
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.id,
    status,
    content,
    rawOutput: plain(result.content),
  });
}

/** Show the editor a conversation it has not seen. */
function replay(sid: string) {
  const calls = new Map<string, ToolCall>();
  for (const message of conversation(sid)) {
    if (message.role === "user") say(sid, "user_message", plain(message.content));
    if (message.role === "toolResult") showResult(sid, calls.get(message.toolCallId)!, message);
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text") say(sid, "agent_message", block.text);
      if (block.type === "thinking") say(sid, "agent_thought", block.thinking);
      if (block.type === "toolCall") {
        calls.set(block.id, block);
        showCall(sid, block);
      }
    }
  }
}

/** The settings the editor can change. Each one's id is its key in a line. */
function options(sid: string) {
  const { model, thinking } = settings(sid);
  const all = available.map((one) => ({ value: ref(one), name: one.name }));
  const levels = getSupportedThinkingLevels(model).map((level) => ({ value: level, name: level }));
  return [
    { id: "model", name: "Model", category: "model", currentValue: ref(model), options: all },
    { id: "thinking", name: "Thinking", category: "thought_level", currentValue: thinking, options: levels },
  ].map((option) => ({ type: "select", ...option }));
}

/** The sessions, latest first. One's title is the start of what the user first said in it. */
function list(cwd?: string) {
  return readdirSync(SESSIONS)
    .map((name) => name.slice(0, -".jsonl".length))
    .map((sessionId) => {
      const first = conversation(sessionId).find((message) => message.role === "user")?.content ?? "";
      const updatedAt = statSync(file(sessionId)).mtime.toISOString();
      return { sessionId, cwd: cwdOf(sessionId), title: plain(first).slice(0, 80) || undefined, updatedAt };
    })
    .filter((session) => !cwd || session.cwd === cwd)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Prompt blocks from the editor, as content for the model. */
const parts = (blocks: any[]): UserMessage["content"] =>
  blocks.map((block) =>
    block.type === "image"
      ? { type: "image", data: block.data, mimeType: block.mimeType }
      : block.type === "resource"
        ? { type: "text", text: `<file uri="${block.resource.uri}">\n${block.resource.text ?? ""}\n</file>` }
        : { type: "text", text: block.text ?? block.uri ?? "" },
  );

/** A session the editor opens, and how full its context was at the last reply. */
function open(sessionId: string) {
  const last = conversation(sessionId).findLast((message) => message.role === "assistant");
  if (last) usage(sessionId, last);
  return { sessionId, configOptions: options(sessionId) };
}

const handlers: Record<string, (params: any) => unknown> = {
  initialize: () => ({
    protocolVersion: 1,
    agentInfo: { name: "bee", title: "bee", version },
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {} },
    },
  }),
  "session/new": ({ cwd }) => {
    const sessionId = randomUUID();
    append(sessionId, beginning(cwd));
    return open(sessionId);
  },
  "session/resume": ({ sessionId }) => open(sessionId),
  "session/load": ({ sessionId }) => {
    replay(sessionId);
    return open(sessionId);
  },
  "session/list": ({ cwd }) => ({ sessions: list(cwd) }),
  "session/set_config_option": ({ sessionId, configId, value }) => {
    const choices = options(sessionId).find((option) => option.id === configId)?.options ?? [];
    if (!choices.some((choice) => choice.value === value)) throw failure(-32602, `No ${configId} ${value}`);
    append(sessionId, { [configId]: value });
    return { configOptions: options(sessionId) };
  },
  "session/cancel": ({ sessionId }) => turns.get(sessionId)?.abort.abort(),
  "session/prompt": async ({ sessionId, prompt }) => {
    const message = user(parts(prompt));
    let under = turns.get(sessionId);
    if (under) under.said.push(message);
    else {
      under = { abort: new AbortController(), said: [message] };
      turns.set(sessionId, under);
      under.done = turn(sessionId, under);
    }
    return { stopReason: await under.done };
  },
};

mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (!method) continue; // a reply, and we ask nothing
  const reply = (answer: object) => id !== undefined && send({ id, ...answer });
  const unknown = () => Promise.reject(failure(-32601, `No method ${method}`));
  Promise.resolve(params ?? {})
    .then(handlers[method] ?? unknown)
    .then(
      (result) => reply({ result: result ?? {} }),
      (error) => reply({ error: { code: error.code ?? -32603, message: error.message } }),
    );
}
process.exit(); // the editor hung up
