#!/usr/bin/env bun
// bee: a minimal agent harness. ACP on stdio, one tool, one append-only file per session.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type SystemMessage,
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

// ── Sessions ────────────────────────────────────────────────────────────────
// A session is a file of lines. Each line follows a parent, named by its line
// number, and the conversation is the chain from the last line back to line 0.
// Lines are only ever appended, so compacting and rewinding are the same act:
// append after an earlier line. The model can append too. The file is the
// whole interface, and nothing about a session lives anywhere else.

type Settings = { model?: string; thinking?: string; cache?: string };
type Line = Settings & { parent: number | null; message?: Message; cwd?: string };

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee", "agent");
const SESSIONS = join(HOME, "sessions");
const file = (sid: string) => join(SESSIONS, sid + ".jsonl");

/**
 * The one thing about a session that is not in its file: a new session's text, kept here until its first message,
 * so that a session never used leaves no file.
 */
const unwritten = new Map<string, string>();

/** A session, as the text of its file. */
function text(sid: string): string {
  const kept = unwritten.get(sid);
  if (kept) return kept;
  if (!/^[\w-]+$/.test(sid) || !existsSync(file(sid))) throw failure(-32002, `No session ${sid}`);
  return readFileSync(file(sid), "utf8");
}

/** The lines. One that is not JSON is empty, and one that names no earlier line follows the line before it. */
function read(sid: string): Line[] {
  const parse = (json: string) => {
    try {
      return JSON.parse(json) ?? {};
    } catch {
      return {};
    }
  };
  return text(sid).trimEnd().split("\n").map(parse).map((line, n) => {
    const earlier = Number.isInteger(line.parent) && line.parent >= 0 && line.parent < n;
    return { ...line, parent: earlier ? line.parent : n ? n - 1 : null };
  });
}

/** Append a line after the last one. With its first message, a new session becomes a file. */
function append(sid: string, line: Settings | { message: Message }) {
  const kept = unwritten.get(sid);
  if (kept && "message" in line) {
    unwritten.delete(sid);
    writeFileSync(file(sid), kept);
  }
  const before = text(sid);
  const parent = before.trimEnd().split("\n").length - 1;
  const added = (before.endsWith("\n") ? "" : "\n") + JSON.stringify({ parent, ...line }) + "\n";
  if (unwritten.has(sid)) unwritten.set(sid, before + added);
  else appendFileSync(file(sid), added);
}

/** settings.json is a setting line, {"model": ..., "thinking": ..., "cache": ...}. Every new session starts with it. */
const SETTINGS = join(HOME, "settings.json");

function create(cwd: string): string {
  const sid = randomUUID();
  const defaults: Settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf8")) : {};
  const message: SystemMessage = {
    role: "system",
    content: system(cwd, file(sid)),
    toolsAdded: [PYTHON],
    timestamp: Date.now(),
  };
  unwritten.set(sid, JSON.stringify({ ...defaults, parent: null, cwd, message }) + "\n");
  return sid;
}

/** The conversation: the messages from line 0 to the last line, by way of each line's parent. */
function chain(lines: Line[]): Message[] {
  const messages = [];
  for (let line = lines.at(-1); line; line = lines[line.parent ?? -1])
    if (line.message) messages.push(line.message);
  return messages.reverse();
}

// ── The model ───────────────────────────────────────────────────────────────

const PYTHON = {
  name: "python",
  description:
    "Runs Python in a persistent session that starts in cwd. A line that starts with ! runs in the shell. " +
    "Returns stdout and stderr, and the value of a final expression. Output is truncated to 20,000 characters.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

const system = (cwd: string, path: string) => `
You are an agent in the bee harness.
cwd: ${cwd}
session: ${path}
Your context is the session file, followed by parent from its last line. You can append to it.

${instructions(cwd)}`.trim();

/** AGENTS.md from ~/.bee/agent, then from every directory down to cwd. */
function instructions(cwd: string): string {
  const dirs = [cwd];
  while (dirs[0] !== dirname(dirs[0])) dirs.unshift(dirname(dirs[0]));
  return [HOME, ...dirs]
    .map((dir) => join(dir, "AGENTS.md"))
    .filter(existsSync)
    .map((path) => `<file path="${path}">\n${readFileSync(path, "utf8").trim()}\n</file>`)
    .join("\n\n");
}

/** models.json, as pi writes it: {"providers": {"anthropic": {"baseUrl": "...", "apiKey": "..."}}}. */
const MODELS = join(HOME, "models.json");
const providers: Record<string, { baseUrl?: string; apiKey?: string }> = existsSync(MODELS)
  ? JSON.parse(readFileSync(MODELS, "utf8")).providers
  : {};

const models = builtinModels();
for (const [id, { apiKey, baseUrl }] of Object.entries(providers)) {
  const provider = models.getProvider(id);
  const resolve = async () => ({ auth: { apiKey, baseUrl }, source: MODELS });
  if (provider) models.setProvider({ ...provider, auth: { apiKey: { name: MODELS, resolve } } });
}
const available = await models.getAvailable();
const ref = (m: Model<Api>) => `${m.provider}/${m.id}`;

/**
 * Settings are lines too, and for each the latest line that makes sense holds. Without one, the model is the first
 * there is a key for, thinking is medium, and the prompt stays cached for five minutes. ("long" is an hour.)
 */
function settings(lines: Line[]) {
  if (!available.length) throw failure(-32000, "No provider key is set.");
  const latest = <T>(pick: (line: Line) => T | undefined) => lines.map(pick).findLast(Boolean);
  const model = latest((line) => available.find((m) => ref(m) === line.model)) ?? available[0];
  const level = latest((line) => MODEL_THINKING_LEVELS.find((level) => level === line.thinking)) ?? "medium";
  const cache = latest((line) => CACHE_RETENTIONS.find((retention) => retention === line.cache)) ?? "short";
  return { model, thinking: clampThinkingLevel(model, level), cache };
}

/** One reply from the model, streamed to the editor. */
async function ask(sid: string, signal: AbortSignal): Promise<AssistantMessage> {
  const lines = read(sid);
  const { model, thinking, cache } = settings(lines);
  const reasoning = thinking === "off" ? undefined : thinking;
  const request = { signal, sessionId: sid, reasoning, cacheRetention: cache };
  const stream = models.streamSimple(model, { messages: chain(lines) }, request);
  for await (const event of stream) {
    if (event.type === "text_delta") say(sid, "agent_message", event.delta);
    if (event.type === "thinking_delta") say(sid, "agent_thought", event.delta);
  }
  const reply = await stream.result();
  usage(sid, reply);
  return reply;
}

/** How full the context is: the tokens in the conversation, as the model counted them in a reply. */
function usage(sid: string, reply: AssistantMessage) {
  const { input, output, cacheRead, cacheWrite } = reply.usage;
  const size = settings(read(sid)).model.contextWindow;
  update(sid, { sessionUpdate: "usage_update", used: input + output + cacheRead + cacheWrite, size });
}

const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: Date.now() });

/** The loop: ask, run what it asks for, repeat until it has nothing to run. */
async function turn(sid: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    const reply = await ask(sid, signal);
    const calls = reply.stopReason === "toolUse" ? reply.content.filter((block) => block.type === "toolCall") : [];
    const results = [];
    for (const call of calls) if (!signal.aborted) results.push(await run(sid, call, signal));
    // Written only now, so that the exchange follows any line its own code appended.
    for (const message of [reply, ...results]) append(sid, { message });
    if (reply.stopReason === "error") throw new Error(reply.errorMessage);
    if (signal.aborted) {
      append(sid, { message: user("[The user interrupted.]") });
      return "cancelled";
    }
    if (!calls.length) return reply.stopReason === "length" ? "max_tokens" : "end_turn";
  }
}

// ── The tool ────────────────────────────────────────────────────────────────
// Each session gets one Python process, a child of this one, started at its
// first call. It takes a line of code and answers with a line of output.

type Kernel = { child: ChildProcess; replies: AsyncIterator<string> };

const kernels = new Map<string, Kernel>();

function start(sid: string): Kernel {
  const PYTHONPATH = [HOME, process.env.PYTHONPATH].filter(Boolean).join(delimiter); // ~/.bee/agent is importable
  const child = spawn("python3", [join(import.meta.dir, "kernel.py"), file(sid)], {
    cwd: read(sid)[0].cwd,
    env: { ...process.env, PYTHONPATH },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const kernel = { child, replies: createInterface({ input: child.stdout! })[Symbol.asyncIterator]() };
  for (const end of ["exit", "error"]) child.once(end, () => kernels.delete(sid));
  kernels.set(sid, kernel);
  return kernel;
}

/** Run a call's code in the session's Python. Returns what it wrote, and whether it raised. */
async function python(sid: string, call: ToolCall, signal: AbortSignal): Promise<{ output: string; failed: boolean }> {
  const { code } = validateToolCall([PYTHON], call);
  const { child, replies } = kernels.get(sid) ?? start(sid);
  const interrupt = () => child.kill("SIGINT");
  signal.addEventListener("abort", interrupt);
  child.stdin!.write(JSON.stringify({ code }) + "\n");
  const { value } = await replies.next();
  signal.removeEventListener("abort", interrupt);
  if (value) return JSON.parse(value);
  kernels.delete(sid);
  return { output: "The Python session died.", failed: true };
}

/** Run one tool call, shown to the editor. Returns its result. */
async function run(sid: string, call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
  showCall(sid, call);
  const refused = (error: Error) => ({ output: error.message, failed: true }); // not a call Python can be given
  const { output, failed } = await python(sid, call, signal).catch(refused);
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: output }],
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

/** A message's content, as plain text. */
const plain = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");

/** A code block, fenced by more backticks than it holds. */
function fenced(body: string, language = "") {
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((ticks) => ticks[0].length + 1)));
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${body.trim()}\n${fence}` } };
}

const source = (call: ToolCall) => String(call.arguments.code ?? "");

function showCall(sid: string, call: ToolCall) {
  const title = source(call).trim().split("\n")[0].replace(/^#\s*/, "").slice(0, 80) || "python";
  const content = [fenced(source(call), "python")];
  const shown = { toolCallId: call.id, title, kind: "execute", status: "in_progress", content };
  update(sid, { sessionUpdate: "tool_call", ...shown, rawInput: call.arguments });
}

function showResult(sid: string, call: ToolCall, result: ToolResultMessage) {
  const status = result.isError ? "failed" : "completed";
  const output = plain(result.content).trim();
  const content = [fenced(source(call), "python"), ...(output ? [fenced(output)] : [])];
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: call.id, status, content, rawOutput: output });
}

/** Show the editor a conversation it has not seen. */
function replay(sid: string) {
  const calls = new Map<string, ToolCall>();
  for (const message of chain(read(sid))) {
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
  const { model, thinking } = settings(read(sid));
  const all = available.map((m) => ({ value: ref(m), name: m.name }));
  const levels = getSupportedThinkingLevels(model).map((level) => ({ value: level, name: level }));
  return [
    { id: "model", name: "Model", category: "model", currentValue: ref(model), options: all },
    { id: "thinking", name: "Thinking", category: "thought_level", currentValue: thinking, options: levels },
  ].map((option) => ({ type: "select", ...option }));
}

/** The sessions, latest first. One's title is the start of what the user first said in it. */
function list(cwd?: string) {
  const sessions = readdirSync(SESSIONS)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const sessionId = name.slice(0, -".jsonl".length);
      const lines = read(sessionId);
      const first = lines.find((line) => line.message?.role === "user")?.message?.content ?? "";
      const updatedAt = statSync(file(sessionId)).mtime.toISOString();
      return { sessionId, cwd: lines[0].cwd, title: plain(first).slice(0, 80) || undefined, updatedAt };
    });
  return sessions
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

const running = new Map<string, AbortController>();

/** A session the editor opens, and how full its context was at the last reply. */
function open(sessionId: string) {
  const last = chain(read(sessionId)).findLast((message) => message.role === "assistant");
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
  "session/new": ({ cwd }) => open(create(cwd)),
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
  "session/cancel": ({ sessionId }) => running.get(sessionId)?.abort(),
  "session/prompt": async ({ sessionId, prompt }) => {
    const abort = new AbortController();
    running.set(sessionId, abort);
    try {
      append(sessionId, { message: user(parts(prompt)) });
      return { stopReason: await turn(sessionId, abort.signal) };
    } finally {
      running.delete(sessionId);
    }
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
process.exit(); // the editor hung up; the Python sessions go with us
