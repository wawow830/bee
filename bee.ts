#!/usr/bin/env bun
// bee: a minimal agent harness. ACP on stdio, one tool, one append-only file per session.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ThinkingLevel,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
  validateToolCall,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { version } from "./package.json";

console.log = console.error; // stdout carries the protocol and nothing else

// ── Sessions ────────────────────────────────────────────────────────────────
// A session is a file of lines. Each line follows a parent, named by its line
// number, and the conversation is the chain from the last line back to line 0.
// Lines are only ever appended, so compacting and rewinding are the same act:
// append after an earlier line. The model can append too. The file is the
// whole interface, and nothing about a session lives anywhere else.

type Line = { parent: number | null; message?: Message; cwd?: string; model?: string; thinking?: string };

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee", "agent");
const SESSIONS = join(HOME, "sessions");
const file = (sid: string) => join(SESSIONS, sid + ".jsonl");
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: Date.now() });

/** The lines. One that is not JSON is empty, and one that names no earlier line follows the line before it. */
function read(sid: string): Line[] {
  if (!/^[\w-]+$/.test(sid) || !existsSync(file(sid)))
    throw Object.assign(new Error(`No session ${sid}`), { code: -32002 });
  const parse = (text: string) => {
    try {
      return JSON.parse(text) ?? {};
    } catch {
      return {};
    }
  };
  return readFileSync(file(sid), "utf8").trimEnd().split("\n").map(parse).map((line, n) => {
    const earlier = Number.isInteger(line.parent) && line.parent >= 0 && line.parent < n;
    return { ...line, parent: n === 0 ? null : earlier ? line.parent : n - 1 };
  });
}

/** Append a line, after the last one unless it names a parent. */
function append(sid: string, { parent, ...rest }: Partial<Line>) {
  const line = JSON.stringify({ parent: parent ?? read(sid).length - 1, ...rest });
  const ended = readFileSync(file(sid), "utf8").endsWith("\n");
  appendFileSync(file(sid), (ended ? "" : "\n") + line + "\n");
}

function create(cwd: string): string {
  const sid = randomUUID();
  const message = { role: "system", content: prompt(cwd, file(sid)), toolsAdded: [PYTHON], timestamp: Date.now() };
  appendFileSync(file(sid), JSON.stringify({ parent: null, cwd, message }) + "\n");
  return sid;
}

function chain(lines: Line[]): Message[] {
  const messages: Message[] = [];
  for (let n: number | null = lines.length - 1; n !== null; n = lines[n].parent)
    if (lines[n].message) messages.unshift(lines[n].message!);
  return messages;
}

/** Settings are lines too. For each, the latest line that makes sense holds. */
function latest<T>(lines: Line[], pick: (line: Line) => T | undefined | false): T | undefined {
  for (const line of lines.toReversed()) {
    const value = pick(line);
    if (value) return value;
  }
}

// ── The model ───────────────────────────────────────────────────────────────

const PYTHON = {
  name: "python",
  description:
    "Runs Python in a persistent session. Returns stdout and stderr, and the value of a final expression. " +
    "Output is truncated to 20,000 characters.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

const prompt = (cwd: string, path: string) => `\nYou are an agent in the bee harness.
cwd: ${cwd}
session: ${path}
Your context is the session file. You can append to it.

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

/** The session's model: the latest one named in the file, else the first there is a key for. */
const model = (lines: Line[]) =>
  latest(lines, (line) => available.find((m) => ref(m) === line.model)) ?? available[0];

function thinking(lines: Line[]) {
  const wanted = latest(lines, (line) => line.thinking) ?? process.env.BEE_THINKING ?? "medium";
  return clampThinkingLevel(model(lines), wanted as ThinkingLevel);
}

/** Tokens in the conversation after a reply, as the model counted them. */
const count = ({ usage }: AssistantMessage) => usage.input + usage.cacheRead + usage.cacheWrite + usage.output;

/** One reply from the model, streamed to the editor. */
async function ask(sid: string, signal: AbortSignal): Promise<AssistantMessage> {
  const lines = read(sid);
  const [using, level] = [model(lines), thinking(lines)];
  const reasoning = level === "off" ? undefined : level;
  const options = { signal, sessionId: sid, reasoning, cacheRetention: "long" as const }; // cached for an hour
  const stream = models.streamSimple(using, { messages: chain(lines) }, options);
  for await (const event of stream) {
    if (event.type === "text_delta") say(sid, "agent_message", event.delta);
    if (event.type === "thinking_delta") say(sid, "agent_thought", event.delta);
  }
  const reply = await stream.result();
  update(sid, { sessionUpdate: "usage_update", used: count(reply), size: using.contextWindow });
  return reply;
}

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
    if (signal.aborted) return append(sid, { message: user("[The user interrupted.]") }), "cancelled";
    if (!calls.length) return reply.stopReason === "length" ? "max_tokens" : "end_turn";
  }
}

// ── The tool ────────────────────────────────────────────────────────────────
// Each session gets one Python process, a child of this one, started at its
// first call. It takes a line of code and answers with a line of output.

type Result = { output: string; failed: boolean };
type Python = { child: ChildProcess; replies: AsyncIterator<string> };

const pythons = new Map<string, Python>();

function start(sid: string): Python {
  const kernel = join(import.meta.dir, "kernel.py");
  const child = spawn("python3", [kernel, file(sid)], { cwd: read(sid)[0].cwd, stdio: ["pipe", "pipe", "inherit"] });
  const python = { child, replies: createInterface({ input: child.stdout! })[Symbol.asyncIterator]() };
  for (const end of ["exit", "error"]) child.once(end, () => pythons.delete(sid));
  pythons.set(sid, python);
  return python;
}

async function python(sid: string, call: ToolCall, signal: AbortSignal): Promise<Result> {
  const { code } = validateToolCall([PYTHON], call);
  const { child, replies } = pythons.get(sid) ?? start(sid);
  const interrupt = () => child.kill("SIGINT");
  signal.addEventListener("abort", interrupt);
  child.stdin!.write(JSON.stringify({ code }) + "\n");
  const { value } = await replies.next();
  signal.removeEventListener("abort", interrupt);
  return value ? JSON.parse(value) : (pythons.delete(sid), { output: "The Python session died.", failed: true });
}

/** Run one tool call. Returns its result. */
async function run(sid: string, call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
  showCall(sid, call);
  const failure = (error: Error) => ({ output: error.message, failed: true });
  const result: Result = await python(sid, call, signal).catch(failure);
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: result.output }],
    isError: result.failed,
    timestamp: Date.now(),
  };
  showResult(sid, call, message);
  return message;
}

// ── The editor ──────────────────────────────────────────────────────────────
// ACP: JSON-RPC, one message per line, on stdin and stdout.

const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId: string, update: object) => send({ method: "session/update", params: { sessionId, update } });

const text = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");

const say = (sid: string, who: "user_message" | "agent_message" | "agent_thought", text: string) =>
  text && update(sid, { sessionUpdate: `${who}_chunk`, content: { type: "text", text } });

function fenced(text: string, language = "") {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${text.trim()}\n${fence}` } };
}

const code = (call: ToolCall) => String(call.arguments.code ?? "");

function showCall(sid: string, call: ToolCall) {
  const title = code(call).trim().split("\n")[0].replace(/^#\s*/, "").slice(0, 80) || "python";
  const content = [fenced(code(call), "python")];
  const shown = { toolCallId: call.id, title, kind: "execute", status: "in_progress", content };
  update(sid, { sessionUpdate: "tool_call", ...shown, rawInput: call.arguments });
}

function showResult(sid: string, call: ToolCall, result: ToolResultMessage) {
  const status = result.isError ? "failed" : "completed";
  const output = text(result.content).trim();
  const content = [fenced(code(call), "python"), ...(output ? [fenced(output)] : [])];
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: call.id, status, content, rawOutput: output });
}

function replay(sid: string) {
  const calls = new Map<string, ToolCall>();
  for (const message of chain(read(sid))) {
    if (message.role === "user") say(sid, "user_message", text(message.content));
    if (message.role === "toolResult") showResult(sid, calls.get(message.toolCallId)!, message);
    if (message.role === "assistant")
      for (const block of message.content) {
        if (block.type === "text") say(sid, "agent_message", block.text);
        if (block.type === "thinking") say(sid, "agent_thought", block.thinking);
        if (block.type === "toolCall") calls.set(block.id, block), showCall(sid, block);
      }
  }
}

/** The settings, as the editor shows them. Each one's id is its key in a line. */
function options(sid: string) {
  if (!available.length) throw Object.assign(new Error("No provider key is set."), { code: -32000 });
  const lines = read(sid);
  const select = (id: string, category: string, currentValue: string, values: string[][]) => {
    const options = values.map(([value, name]) => ({ value, name }));
    return { id, name: id[0].toUpperCase() + id.slice(1), category, type: "select", currentValue, options };
  };
  const all = available.map((m) => [ref(m), m.name]);
  const levels = getSupportedThinkingLevels(model(lines)).map((level) => [level, level]);
  return [
    select("model", "model", ref(model(lines)), all),
    select("thinking", "thought_level", thinking(lines), levels),
  ];
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

const open = (sessionId: string) => ({ sessionId, configOptions: options(sessionId) });

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
  "session/load": ({ sessionId }) => (replay(sessionId), open(sessionId)),
  "session/list": ({ cwd }) => ({
    sessions: readdirSync(SESSIONS)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const sessionId = name.slice(0, -6);
        const lines = read(sessionId);
        const title = text(lines.find((line) => line.message?.role === "user")?.message?.content ?? "").slice(0, 80);
        const updatedAt = statSync(file(sessionId)).mtime.toISOString();
        return { sessionId, cwd: lines[0].cwd, title: title || undefined, updatedAt };
      })
      .filter((session) => !cwd || session.cwd === cwd)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }),
  "session/set_config_option": ({ sessionId, configId, value }) => {
    if (!options(sessionId).some((option) => option.id === configId)) throw new Error(`No option ${configId}`);
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
  const unknown = () => Promise.reject(Object.assign(new Error(`No method ${method}`), { code: -32601 }));
  Promise.resolve(params ?? {})
    .then(handlers[method] ?? unknown)
    .then(
      (result) => reply({ result: result ?? {} }),
      (error) => reply({ error: { code: error.code ?? -32603, message: error.message } }),
    );
}
process.exit(); // the editor hung up; the Python sessions go with us
