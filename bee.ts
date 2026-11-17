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
  writeFileSync,
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
// A session is a file of lines, written as things happen, and its messages are
// the conversation. Nothing about a session lives anywhere else.

type Settings = { model?: string; thinking?: string; cache?: string };
type Line = Settings & { message?: Message; cwd?: string };

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

/** The lines. One that is not JSON is empty. */
function read(sid: string): Line[] {
  const parse = (json: string) => {
    try {
      return JSON.parse(json) ?? {};
    } catch {
      return {};
    }
  };
  return text(sid).trimEnd().split("\n").map(parse);
}

/** Append a line. With its first message, a new session becomes a file. */
function append(sid: string, line: Settings | { message: Message }) {
  const kept = unwritten.get(sid);
  if (kept && "message" in line) {
    unwritten.delete(sid);
    writeFileSync(file(sid), kept);
  }
  const before = text(sid);
  const added = (before.endsWith("\n") ? "" : "\n") + JSON.stringify(line) + "\n";
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
    content: system(cwd),
    toolsAdded: [BASH],
    timestamp: Date.now(),
  };
  unwritten.set(sid, JSON.stringify({ ...defaults, cwd, message }) + "\n");
  return sid;
}

/** The conversation: the messages in the file. */
function conversation(lines: Line[]): Message[] {
  return lines.flatMap((line) => (line.message ? [line.message] : []));
}

// ── The model ───────────────────────────────────────────────────────────────

const BASH = {
  name: "bash",
  description:
    "Runs a command in a new bash in the working directory. Returns what it wrote to stdout and stderr cut to " +
    "20,000 characters, or the image.",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

const system = (cwd: string) => `
You are an agent in the bee harness.

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
  const stream = models.streamSimple(model, { messages: conversation(lines) }, request);
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

/** A turn under way: how to stop it, what the user has said that it has not read yet, and how it ends. */
type Turn = { abort: AbortController; said: UserMessage[]; done?: Promise<string> };

/**
 * The loop: read what the user said, ask, run what it asks for, repeat until it has nothing to run and nothing more
 * was said. A prompt sent during a turn joins it, so the model reads it once the commands it is running end.
 */
async function turn(sid: string, { abort: { signal }, said }: Turn): Promise<string> {
  try {
    for (;;) {
      for (const message of said.splice(0)) {
        append(sid, { message });
        say(sid, "user_message", plain(message.content));
      }
      if (signal.aborted) {
        append(sid, { message: user("[The user interrupted.]") });
        return "cancelled";
      }
      const reply = await ask(sid, signal);
      const calls = reply.stopReason === "toolUse" ? reply.content.filter((block) => block.type === "toolCall") : [];
      append(sid, { message: reply });
      for (const call of calls) if (!signal.aborted) append(sid, { message: await run(sid, call, signal) });
      if (reply.stopReason === "error") throw new Error(reply.errorMessage);
      if (!calls.length && !said.length && !signal.aborted)
        return reply.stopReason === "length" ? "max_tokens" : "end_turn";
    }
  } finally {
    running.delete(sid); // in the same step as the last look at what was said, so nothing said is left behind
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

type Output = { content: ToolResultMessage["content"]; failed: boolean };

/** Run a call's command. Returns what it wrote, as an image or as text cut to its two ends, and whether it failed. */
async function bash(sid: string, call: ToolCall, signal: AbortSignal): Promise<Output> {
  const { command } = validateToolCall([BASH], call);
  // Written to a file, not a pipe, so the call ends when the command does, whatever it left running.
  const path = join(tmpdir(), `bee-${randomUUID()}`);
  const out = openSync(path, "w");
  const child = spawn("bash", ["-c", command], {
    cwd: read(sid)[0].cwd,
    stdio: ["ignore", out, out],
    detached: true, // its own process group, so an interrupt stops all of it
  });
  const interrupt = () => process.kill(-child.pid!, "SIGINT");
  signal.addEventListener("abort", interrupt);
  try {
    const [status] = await once(child, "exit");
    const failed = status !== 0;
    const written = readFileSync(path);
    const start = written.subarray(0, 12).toString("latin1");
    const mimeType = Object.keys(IMAGES).find((type) => IMAGES[type].test(start));
    if (mimeType) return { content: [{ type: "image", data: written.toString("base64"), mimeType }], failed };
    const text = written.toString("utf8");
    const cut = text.length - SHOWN;
    const shown = cut <= 0 ? text : `${text.slice(0, SHOWN / 2)}\n[${cut} characters cut]\n${text.slice(-SHOWN / 2)}`;
    return { content: [{ type: "text", text: shown }], failed };
  } finally {
    signal.removeEventListener("abort", interrupt);
    closeSync(out);
    rmSync(path);
  }
}

/** Run one tool call, shown to the editor. Returns its result. */
async function run(sid: string, call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
  showCall(sid, call);
  const refused = (error: Error): Output => ({ content: [{ type: "text", text: error.message }], failed: true });
  const { content, failed } = await bash(sid, call, signal).catch(refused);
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

/** A message's content, as plain text. */
const plain = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");

/** A code block, fenced by more backticks than it holds. */
function fenced(body: string, language = "") {
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((ticks) => ticks[0].length + 1)));
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${body.trim()}\n${fence}` } };
}

const source = (call: ToolCall) => String(call.arguments.command ?? "");

function showCall(sid: string, call: ToolCall) {
  const title = source(call).trim().split("\n")[0].replace(/^#\s*/, "").slice(0, 80) || "bash";
  const content = [fenced(source(call), "bash")];
  const shown = { toolCallId: call.id, title, kind: "execute", status: "in_progress", content };
  update(sid, { sessionUpdate: "tool_call", ...shown, rawInput: call.arguments });
}

function showResult(sid: string, call: ToolCall, result: ToolResultMessage) {
  const status = result.isError ? "failed" : "completed";
  const output = plain(result.content).trim();
  const shown = result.content.filter((block) => block.type === "image" || block.text.trim());
  const blocks = shown.map((block) => (block.type === "image" ? { type: "content", content: block } : fenced(block.text)));
  const content = [fenced(source(call), "bash"), ...blocks];
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: call.id, status, content, rawOutput: output });
}

/** Show the editor a conversation it has not seen. */
function replay(sid: string) {
  const calls = new Map<string, ToolCall>();
  for (const message of conversation(read(sid))) {
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

const running = new Map<string, Turn>();

/** A session the editor opens, and how full its context was at the last reply. */
function open(sessionId: string) {
  const last = conversation(read(sessionId)).findLast((message) => message.role === "assistant");
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
  "session/cancel": ({ sessionId }) => running.get(sessionId)?.abort.abort(),
  "session/prompt": async ({ sessionId, prompt }) => {
    const message = user(parts(prompt));
    let under = running.get(sessionId);
    if (under) under.said.push(message);
    else {
      under = { abort: new AbortController(), said: [message] };
      running.set(sessionId, under);
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
