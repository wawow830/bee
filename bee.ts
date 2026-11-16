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
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { version } from "./package.json";

console.log = console.error; // stdout carries the protocol and nothing else

// ── Sessions ────────────────────────────────────────────────────────────────
// A session is a file of lines. Each line follows a parent, named by its line
// number, and the conversation is the chain from the last line back to line 0.
// Lines are only ever appended, so compacting and rewinding are the same act:
// append after an earlier line. Nothing about a session lives anywhere else.

type Line = { parent: number | null; message?: Message; [setting: string]: unknown };

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee");
const SESSIONS = join(HOME, "sessions");
const file = (sid: string) => join(SESSIONS, sid + ".jsonl");
const user = (content: unknown): Message => ({ role: "user", content, timestamp: Date.now() }) as Message;

function read(sid: string): Line[] {
  if (!/^[\w-]+$/.test(sid) || !existsSync(file(sid)))
    throw Object.assign(new Error(`No session ${sid}`), { code: -32002 });
  return readFileSync(file(sid), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

function append(sid: string, { parent, ...rest }: Partial<Line>) {
  appendFileSync(file(sid), JSON.stringify({ parent: parent ?? read(sid).length - 1, ...rest }) + "\n");
}

function create(cwd: string): string {
  const sid = randomUUID();
  const message = { role: "system", content: prompt(cwd), toolsAdded: [PYTHON], timestamp: Date.now() };
  appendFileSync(file(sid), JSON.stringify({ parent: null, cwd, message }) + "\n");
  return sid;
}

function messages(lines: Line[]): Message[] {
  const chain: Message[] = [];
  for (let n: number | null = lines.length - 1; n !== null; n = lines[n].parent)
    if (lines[n].message) chain.unshift(lines[n].message!);
  return chain;
}

/** Settings are lines too: the latest one in the file wins. */
const setting = (lines: Line[], key: string) => lines.findLast((line) => key in line)?.[key] as string | undefined;

// ── The model ───────────────────────────────────────────────────────────────

const PYTHON = {
  name: "python",
  description:
    "Runs Python in a persistent session. Returns stdout and stderr, and the value of a final expression. " +
    "Output is truncated to 20,000 characters.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

const COMPACT = "Context is nearly full. Reply with a summary to continue from.";

const prompt = (cwd: string) => `You are an agent in the bee harness.
cwd: ${cwd}

This session is a JSONL file. Each line is {parent, message}. parent is the number of the line it follows. Line 0 is \
this prompt. Your context is the chain from the last line back to line 0.

\`bee\` in python:
bee.file                  Path of that file.
bee.branch(parent, text)  When the call returns, appends text as a user message after line parent.
                          bee.branch(0, summary) compacts.

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
  const wanted = [setting(lines, "model"), process.env.BEE_MODEL].map((r) => available.find((m) => ref(m) === r));
  const found = wanted.find(Boolean) ?? available[0];
  if (!found) throw new Error("No model available: set a provider key such as ANTHROPIC_API_KEY.");
  return found;
}

const thinking = (lines: Line[]) =>
  clampThinkingLevel(model(lines), (setting(lines, "thinking") ?? process.env.BEE_THINKING ?? "medium") as never);

/** Tokens in the conversation, as counted by the model's last reply. */
function tokens(lines: Line[]): number {
  const complete = (m: Message) => m.role === "assistant" && !["error", "aborted"].includes(m.stopReason);
  const usage = (messages(lines).findLast(complete) as AssistantMessage | undefined)?.usage;
  return usage ? usage.input + usage.cacheRead + usage.cacheWrite + usage.output : 0;
}

/** Where to compact: BEE_LIMIT tokens, or four fifths of the model's context window. */
const limit = (lines: Line[]) => Number(process.env.BEE_LIMIT) || Math.floor(model(lines).contextWindow * 0.8);

/** One reply from the model: streamed to the editor, appended to the session. */
async function ask(sid: string, signal: AbortSignal): Promise<AssistantMessage> {
  const lines = read(sid);
  const level = thinking(lines);
  const options = { signal, sessionId: sid, reasoning: level === "off" ? undefined : level };
  const stream = models.streamSimple(model(lines), { messages: messages(lines) }, options);
  for await (const event of stream) {
    if (event.type === "text_delta") say(sid, "agent_message", event.delta);
    if (event.type === "thinking_delta") say(sid, "agent_thought", event.delta);
  }
  const reply = await stream.result();
  append(sid, { message: reply });
  const now = read(sid);
  const cost = now.reduce((sum, line) => sum + ((line.message as AssistantMessage)?.usage?.cost.total ?? 0), 0);
  const size = model(now).contextWindow;
  update(sid, { sessionUpdate: "usage_update", used: tokens(now), size, cost: { amount: cost, currency: "USD" } });
  if (reply.stopReason === "error") throw new Error(reply.errorMessage);
  return reply;
}

/** Ask once, and run what the reply asks for. */
async function step(sid: string, signal: AbortSignal): Promise<AssistantMessage> {
  const reply = await ask(sid, signal);
  const calls = reply.stopReason === "toolUse" ? reply.content.filter((block) => block.type === "toolCall") : [];
  const branches = [];
  for (const call of calls) branches.push(...(await run(sid, call, signal)));
  for (const branch of branches) append(sid, branch);
  return reply;
}

/** Ask for a summary, then start over from it. The model may also branch there itself. */
async function compact(sid: string, signal: AbortSignal) {
  append(sid, { message: user(COMPACT) });
  const reply = await step(sid, signal);
  if (reply.stopReason === "stop") append(sid, { parent: 0, message: user(text(reply.content)) });
}

/** The loop: step until the model has nothing more to run. */
async function turn(sid: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    const lines = read(sid);
    if (tokens(lines) > limit(lines)) await compact(sid, signal);
    const reply = await step(sid, signal);
    if (signal.aborted) return append(sid, { message: user("[The user interrupted.]") }), "cancelled";
    if (reply.stopReason !== "toolUse") return reply.stopReason === "length" ? "max_tokens" : "end_turn";
  }
}

// ── The tool ────────────────────────────────────────────────────────────────
// Each session gets one Python process, a child of this one, started at its
// first call. It takes a line of code and answers with a line of output.

type Result = { output: string; failed: boolean; branch?: { parent: number; text: string } };

const pythons = new Map<string, { child: ChildProcess; replies: AsyncIterator<string> }>();

async function python(sid: string, code: string, signal: AbortSignal): Promise<Result> {
  let note = "";
  if (!pythons.has(sid)) {
    const lines = read(sid);
    const kernel = [join(import.meta.dir, "kernel.py"), file(sid)];
    const child = spawn("python3", kernel, { cwd: lines[0].cwd as string, stdio: ["pipe", "pipe", "inherit"] });
    for (const end of ["exit", "error"]) child.once(end, () => pythons.delete(sid));
    pythons.set(sid, { child, replies: createInterface({ input: child.stdout! })[Symbol.asyncIterator]() });
    const ran = lines.some((line) => line.message?.role === "toolResult");
    if (ran) note = "[New Python session: earlier variables are gone.]\n";
  }
  const { child, replies } = pythons.get(sid)!;
  const interrupt = () => child.kill("SIGINT");
  signal.addEventListener("abort", interrupt);
  child.stdin!.write(JSON.stringify({ code }) + "\n");
  const reply = (await replies.next()).value;
  signal.removeEventListener("abort", interrupt);
  if (!reply) return pythons.delete(sid), { output: "The Python session died.", failed: true };
  const result = JSON.parse(reply);
  return { ...result, output: note + result.output };
}

/** Run one tool call, if the editor allows it. Returns the line the code asked to branch to, if any. */
async function run(sid: string, call: ToolCall, signal: AbortSignal): Promise<Partial<Line>[]> {
  showCall(sid, call);
  const allow = { optionId: "allow", name: "Allow", kind: "allow_once" };
  const reject = { optionId: "reject", name: "Reject", kind: "reject_once" };
  const permission = { sessionId: sid, toolCall: { toolCallId: call.id }, options: [allow, reject] };
  const { outcome } = await request("session/request_permission", permission);
  let result: Result = { output: "Not run: the user declined.", failed: true };
  if (outcome?.optionId === "allow" && !signal.aborted) {
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: call.id, status: "in_progress" });
    result = await python(sid, code(call), signal);
  }
  const content = [{ type: "text", text: result.output }];
  const message = { role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError: result.failed };
  append(sid, { message: { ...message, timestamp: Date.now() } as Message });
  showResult(sid, call, message as ToolResultMessage);
  return result.branch ? [{ parent: result.branch.parent, message: user(result.branch.text) }] : [];
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
  for (const message of messages(read(sid))) {
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
  const levels = getSupportedThinkingLevels(model(lines)).map((level) => [level, level]);
  const all = available.map((m) => [ref(m), m.name]);
  const current = [ref(model(lines)), thinking(lines)];
  return [select("model", "model", current[0], all), select("thinking", "thought_level", current[1], levels)];
}

/** Prompt blocks from the editor, as content for the model. */
const parts = (blocks: any[]) =>
  blocks.map((block) =>
    block.type === "image"
      ? { type: "image", data: block.data, mimeType: block.mimeType }
      : block.type === "resource"
        ? { type: "text", text: `<file uri="${block.resource.uri}">\n${block.resource.text ?? ""}\n</file>` }
        : { type: "text", text: block.text ?? block.uri ?? "" },
  );

const running = new Map<string, AbortController>();

function open(sessionId: string) {
  const configOptions = options(sessionId);
  const availableCommands = [{ name: "compact", description: "Summarise the session and continue from the summary" }];
  setTimeout(() => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands }));
  return { sessionId, configOptions };
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
      if (text(prompt).trim() === "/compact") return await compact(sessionId, abort.signal), { stopReason: "end_turn" };
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
