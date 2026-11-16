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
// append after an earlier line. Nothing about a session lives anywhere else.

type Settings = { model: string; thinking: string; limit: number; output: number };
type Line = { parent: number | null; message?: Message; cwd?: string } & Partial<Settings>;

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee");
const SESSIONS = join(HOME, "sessions");
const file = (sid: string) => join(SESSIONS, sid + ".jsonl");
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: Date.now() });

function read(sid: string): Line[] {
  if (!/^[\w-]+$/.test(sid) || !existsSync(file(sid)))
    throw Object.assign(new Error(`No session ${sid}`), { code: -32002 });
  return readFileSync(file(sid), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

/** Append a line, after the last one unless it names a parent. */
function append(sid: string, { parent, ...rest }: Partial<Line>) {
  appendFileSync(file(sid), JSON.stringify({ parent: parent ?? read(sid).length - 1, ...rest }) + "\n");
}

function create(cwd: string): string {
  const sid = randomUUID();
  const message = { role: "system", content: prompt(cwd), toolsAdded: [PYTHON], timestamp: Date.now() };
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
    "Runs Python in a persistent session. Returns stdout and stderr, and the value of a final expression, " +
    "truncated to bee.output characters.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

const FULL = "Context is nearly full: it is past bee.limit tokens. Compact, or raise bee.limit.";

const prompt = (cwd: string) => `You are an agent in the bee harness.
cwd: ${cwd}

This session is a JSONL file. Each line is {parent, message}. parent is the number of the line it follows. Line 0 is \
this prompt. Your context is the chain from the last line back to line 0.

\`bee\` is a python module, already imported.
bee.file                  Path of that file.
bee.branch(parent, text)  Appends text as a user message after line parent, and this call after that.
bee.model, bee.thinking, bee.limit, bee.output
                          Settings. Assign to change one.

To compact, bee.branch(0, summary). Your context is then this prompt, the summary and that call.

${instructions(cwd)}`.trim();

/** AGENTS.md from ~/.bee, then from every directory down to cwd. */
function instructions(cwd: string): string {
  const dirs = [cwd];
  while (dirs[0] !== dirname(dirs[0])) dirs.unshift(dirname(dirs[0]));
  return [HOME, ...dirs]
    .map((dir) => join(dir, "AGENTS.md"))
    .filter(existsSync)
    .map((path) => `<file path="${path}">\n${readFileSync(path, "utf8").trim()}\n</file>`)
    .join("\n\n");
}

const models = builtinModels();
const baseUrl = (m: Model<Api>) => process.env[`${m.provider.toUpperCase().replace(/\W/g, "_")}_BASE_URL`];
const available = (await models.getAvailable()).map((m) => ({ ...m, baseUrl: baseUrl(m) ?? m.baseUrl }));
const ref = (m: Model<Api>) => `${m.provider}/${m.id}`;

function model(lines: Line[]): Model<Api> {
  const named = (name?: string) => available.find((m) => ref(m) === name);
  const found = latest(lines, (line) => named(line.model)) ?? named(process.env.BEE_MODEL) ?? available[0];
  if (!found) throw new Error("No model available: set a provider key such as ANTHROPIC_API_KEY.");
  return found;
}

function thinking(lines: Line[]) {
  const wanted = latest(lines, (line) => line.thinking) ?? process.env.BEE_THINKING ?? "medium";
  return clampThinkingLevel(model(lines), wanted as ThinkingLevel);
}

const positive = (value: unknown) => Number(value) > 0 && Number(value);

/** Tokens of context at which the model is told it is nearly full. */
const limit = (lines: Line[]) =>
  latest(lines, (line) => positive(line.limit)) ||
  positive(process.env.BEE_LIMIT) ||
  Math.floor(model(lines).contextWindow * 0.8);

/** Characters of a call's output that go back to the model. */
const output = (lines: Line[]) => latest(lines, (line) => positive(line.output)) || 20_000;

const settings = (lines: Line[]): Settings => ({
  model: ref(model(lines)),
  thinking: thinking(lines),
  limit: limit(lines),
  output: output(lines),
});

/** Tokens in the conversation after a reply, as the model counted them. */
const count = ({ usage }: AssistantMessage) => usage.input + usage.cacheRead + usage.cacheWrite + usage.output;

/** One reply from the model, streamed to the editor. */
async function ask(sid: string, signal: AbortSignal): Promise<AssistantMessage> {
  const lines = read(sid);
  const level = thinking(lines);
  const options = { signal, sessionId: sid, reasoning: level === "off" ? undefined : level };
  const stream = models.streamSimple(model(lines), { messages: chain(lines) }, options);
  for await (const event of stream) {
    if (event.type === "text_delta") say(sid, "agent_message", event.delta);
    if (event.type === "thinking_delta") say(sid, "agent_thought", event.delta);
  }
  const reply = await stream.result();
  update(sid, { sessionUpdate: "usage_update", used: count(reply), size: model(lines).contextWindow });
  return reply;
}

/** The loop: ask, run what it asks for, repeat until it has nothing to run. */
async function turn(sid: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    const reply = await ask(sid, signal);
    const calls = reply.stopReason === "toolUse" ? reply.content.filter((block) => block.type === "toolCall") : [];
    const results = [];
    for (const call of calls) results.push(await run(sid, call, signal));
    // What the code asked for goes in first, so that the exchange that asked for it continues after it.
    const asked = results.flatMap((result) => result.lines ?? []);
    for (const { text, ...line } of asked) append(sid, text === undefined ? line : { ...line, message: user(text) });
    for (const message of [reply, ...results.map((result) => result.message)]) append(sid, { message });
    if (asked.length) update(sid, { sessionUpdate: "config_option_update", configOptions: options(sid) });
    if (reply.stopReason === "error") throw new Error(reply.errorMessage);
    if (signal.aborted) return append(sid, { message: user("[The user interrupted.]") }), "cancelled";
    // Say once when the context is nearly full. After a branch its size is not known until the next reply.
    const lines = read(sid);
    const told = chain(lines).some((message) => message.role === "user" && message.content === FULL);
    const branched = asked.some((line) => line.parent !== undefined);
    if (count(reply) > limit(lines) && !told && !branched) append(sid, { message: user(FULL) });
    if (!calls.length) return reply.stopReason === "length" ? "max_tokens" : "end_turn";
  }
}

// ── The tool ────────────────────────────────────────────────────────────────
// Each session gets one Python process, a child of this one, started at its
// first call. It takes code and the settings, and answers with the output and
// the lines the code asked for: a branch, changed settings.

type Asked = Partial<Line> & { text?: string };
type Result = { output: string; failed: boolean; lines?: Asked[] };
type Python = { child: ChildProcess; replies: AsyncIterator<string> };

const pythons = new Map<string, Python>();

function start(sid: string): Python {
  const kernel = [join(import.meta.dir, "kernel.py"), file(sid)];
  const child = spawn("python3", kernel, { cwd: read(sid)[0].cwd, stdio: ["pipe", "pipe", "inherit"] });
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
  child.stdin!.write(JSON.stringify({ code, settings: settings(read(sid)) }) + "\n");
  const { value } = await replies.next();
  signal.removeEventListener("abort", interrupt);
  return value ? JSON.parse(value) : (pythons.delete(sid), { output: "The Python session died.", failed: true });
}

/** Run one tool call, if the editor allows it. Returns its result, and the lines the code asked for. */
async function run(sid: string, call: ToolCall, signal: AbortSignal) {
  showCall(sid, call);
  const allow = { optionId: "allow", name: "Allow", kind: "allow_once" };
  const reject = { optionId: "reject", name: "Reject", kind: "reject_once" };
  const permission = { sessionId: sid, toolCall: { toolCallId: call.id }, options: [allow, reject] };
  const { outcome } = await request("session/request_permission", permission);
  const allowed = outcome?.optionId === "allow" && !signal.aborted;
  if (allowed) update(sid, { sessionUpdate: "tool_call_update", toolCallId: call.id, status: "in_progress" });
  const failure = (error: Error) => ({ output: error.message, failed: true });
  const result: Result = allowed
    ? await python(sid, call, signal).catch(failure)
    : failure(Error("Not run: the user declined."));
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: result.output }],
    isError: result.failed,
    timestamp: Date.now(),
  };
  showResult(sid, call, message);
  return { message, lines: result.lines };
}

// ── The editor ──────────────────────────────────────────────────────────────
// ACP: JSON-RPC, one message per line, on stdin and stdout.

const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId: string, update: object) => send({ method: "session/update", params: { sessionId, update } });

const waiting = new Map<number, (result: any) => void>();
let requests = 0;
const request = (method: string, params: object) =>
  new Promise<any>((resolve) => {
    waiting.set(++requests, resolve);
    send({ id: requests, method, params });
  });

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
  const shown = { toolCallId: call.id, title, kind: "execute", status: "pending", rawInput: call.arguments, content };
  update(sid, { sessionUpdate: "tool_call", ...shown });
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
  const { id, method, params, result } = JSON.parse(line);
  if (!method) {
    waiting.get(id)?.(result ?? {}); // a reply to a request of ours
    waiting.delete(id);
    continue;
  }
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
