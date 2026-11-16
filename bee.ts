#!/usr/bin/env bun
// bee: a minimal agent harness. ACP on stdio, one tool, one append-only file per session.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
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
// A session is a file of lines. Every line hangs under a parent, and the
// conversation is the path from the last line back to the root. Lines are only
// ever appended, so compacting, rewinding and forking are all the same act:
// append under an earlier parent. Nothing about a session lives anywhere else.

type Line = { id: string; parent: string | null; message?: Message; [setting: string]: unknown };

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee");
const SESSIONS = join(HOME, "sessions");
const stem = (sid: string) => join(SESSIONS, sid); // .jsonl the lines, .sock and .out the Python session
const id = () => randomUUID().slice(0, 8);
const user = (content: unknown): Message => ({ role: "user", content, timestamp: Date.now() }) as Message;

function read(sid: string): Line[] {
  if (!/^[\w-]+$/.test(sid) || !existsSync(stem(sid) + ".jsonl"))
    throw Object.assign(new Error(`No session ${sid}`), { code: -32002 });
  return readFileSync(stem(sid) + ".jsonl", "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

function append(sid: string, { parent, ...rest }: Partial<Line>) {
  const line = { id: id(), parent: parent ?? read(sid).at(-1)!.id, ...rest };
  appendFileSync(stem(sid) + ".jsonl", JSON.stringify(line) + "\n");
}

function create(cwd: string): string {
  const [sid, root] = [randomUUID(), id()];
  const message = { role: "system", content: prompt(cwd, root), toolsAdded: [PYTHON], timestamp: Date.now() };
  appendFileSync(stem(sid) + ".jsonl", JSON.stringify({ id: root, parent: null, cwd, message }) + "\n");
  return sid;
}

function messages(lines: Line[]): Message[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const path: Message[] = [];
  for (let line = lines.at(-1); line; line = byId.get(line.parent!)) if (line.message) path.unshift(line.message);
  return path;
}

/** Settings are lines too: the latest one in the file wins. */
const setting = (lines: Line[], key: string) => lines.findLast((line) => key in line)?.[key] as string | undefined;

// ── The model ───────────────────────────────────────────────────────────────

const PYTHON = {
  name: "python",
  description:
    "Run Python in a session that stays open: variables, imports, functions and processes persist between calls. " +
    "Returns what the code and its child processes write to stdout and stderr. The value of a final expression is " +
    "printed, as in a REPL. Output over 20,000 characters is cut in the middle; bee.out holds all of it.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "Python source. The user sees its first line as the title." } },
    required: ["code"],
  },
};

const COMPACT =
  "Your context is nearly full. Reply with only a summary of this conversation that you could continue the work " +
  "from: what the user asked for, what is done, what remains, and which files and which variables in your Python " +
  "session matter. Do not call the tool.";

const prompt = (cwd: string, root: string) => `You are an agent in the bee harness.
cwd: ${cwd}

\`bee\` is the harness, as an object in your Python session.

bee.file
    This session: a JSONL file, one line per message, each {id, parent, message}.
    The first line is this prompt, id "${root}". Your context is the path from the last line back to the first.
    Lines are only ever added.

bee.append(text=None, parent=None, **settings)
    Adds a line when the current call returns. The session continues from it.
    text      a user message
    parent    id of the line to add under; by default the last line
    settings  model="provider/id", thinking="off|minimal|low|medium|high"; they hold until changed
    bee.append(summary, parent="${root}") compacts: your context becomes this prompt and the summary.

bee.tokens, bee.limit
    Tokens in your context, and the number at which bee compacts it for you.

bee.mcp
    MCP servers the editor offers.

bee.out
    All the output of the last call.

${instructions(cwd)}`.trim();

/** AGENTS.md from ~/.bee, then from every directory down to cwd. */
function instructions(cwd: string): string {
  const dirs = [cwd];
  while (dirs[0] !== dirname(dirs[0])) dirs.unshift(dirname(dirs[0]));
  return [HOME, ...dirs]
    .map((dir) => join(dir, "AGENTS.md"))
    .filter(existsSync)
    .map((file) => `<file path="${file}">\n${readFileSync(file, "utf8").trim()}\n</file>`)
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

/** Ask for a summary, then start over from it under the root. */
async function compact(sid: string, signal: AbortSignal) {
  const root = read(sid)[0].id;
  append(sid, { message: user(COMPACT) });
  const reply = await ask(sid, signal);
  if (reply.stopReason === "stop") append(sid, { parent: root, message: user(text(reply.content)) });
}

/** The loop: ask, run what it asks for, repeat until it has nothing to run. */
async function turn(sid: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    const lines = read(sid);
    if (tokens(lines) > limit(lines)) await compact(sid, signal);
    const reply = await ask(sid, signal);
    const calls = reply.stopReason === "toolUse" ? reply.content.filter((block) => block.type === "toolCall") : [];
    const next = [];
    for (const call of calls) next.push(...(await run(sid, call, signal)));
    for (const line of next) append(sid, line);
    if (next.length) update(sid, { sessionUpdate: "config_option_update", configOptions: options(sid) });
    if (signal.aborted) return append(sid, { message: user("[The user interrupted.]") }), "cancelled";
    if (!calls.length) return reply.stopReason === "length" ? "max_tokens" : "end_turn";
  }
}

// ── The tool ────────────────────────────────────────────────────────────────
// The Python session is its own process, so that it outlives this one. Each
// call is one connection: it greets with its pid, takes the code, and answers
// with the output and any lines the code asked to append.

type Result = { output: string; failed: boolean; lines: { text?: string; parent?: string }[] };

function dial(sid: string, launched = false): Promise<ReturnType<typeof connect>> {
  return new Promise((resolve, reject) => {
    const socket = connect(stem(sid) + ".sock");
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => {
      if (launched) return reject(error);
      // Its own systemd scope where there is one, so that stopping the editor's agent leaves it running.
      const scope = 'systemd-run --user --scope --quiet --collect --unit="bee-$0"';
      const kernel = ["python3", join(import.meta.dir, "kernel.py"), stem(sid)];
      const launch = `${scope} -- "$@" 2>/dev/null || exec "$@"`;
      spawnSync("sh", ["-c", launch, sid, ...kernel], { cwd: read(sid)[0].cwd as string, stdio: "ignore" });
      dial(sid, true).then(resolve, reject);
    });
  });
}

async function python(sid: string, code: string, signal: AbortSignal): Promise<Result> {
  const socket = await dial(sid);
  const replies = createInterface({ input: socket })[Symbol.asyncIterator]();
  const { pid } = JSON.parse((await replies.next()).value ?? "{}");
  const interrupt = () => process.kill(pid, "SIGINT");
  signal.addEventListener("abort", interrupt);
  const lines = read(sid);
  const bee = { tokens: tokens(lines), limit: limit(lines), mcp: mcp.get(sid) };
  socket.write(JSON.stringify({ code, bee }) + "\n");
  const reply = (await replies.next()).value;
  signal.removeEventListener("abort", interrupt);
  socket.end();
  return reply ? JSON.parse(reply) : { output: "The Python session died.", failed: true, lines: [] };
}

/** Run one tool call, if the editor allows it. Returns the lines the code asked to append. */
async function run(sid: string, call: ToolCall, signal: AbortSignal): Promise<Partial<Line>[]> {
  showCall(sid, call);
  const allow = { optionId: "allow", name: "Allow", kind: "allow_once" };
  const reject = { optionId: "reject", name: "Reject", kind: "reject_once" };
  const permission = { sessionId: sid, toolCall: { toolCallId: call.id }, options: [allow, reject] };
  const { outcome } = await request("session/request_permission", permission);
  let result: Result = { output: "Not run: the user declined.", failed: true, lines: [] };
  if (outcome?.optionId === "allow" && !signal.aborted) {
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: call.id, status: "in_progress" });
    result = await python(sid, code(call), signal);
  }
  const content = [{ type: "text", text: result.output }];
  const message = { role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError: result.failed };
  append(sid, { message: { ...message, timestamp: Date.now() } as Message });
  showResult(sid, call, message as ToolResultMessage);
  return result.lines.map(({ text, parent, ...settings }) => ({
    ...settings,
    parent: parent ?? undefined,
    message: text ? user(text) : undefined,
  }));
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
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${text.trimEnd()}\n${fence}` } };
}

const code = (call: ToolCall) => String(call.arguments.code ?? "");

function showCall(sid: string, call: ToolCall) {
  const title = code(call).trim().split("\n")[0].replace(/^#\s*/, "").slice(0, 80) || "python";
  const content = [fenced(code(call).trim(), "python")];
  const shown = { toolCallId: call.id, title, kind: "execute", status: "pending", rawInput: call.arguments, content };
  update(sid, { sessionUpdate: "tool_call", ...shown });
}

function showResult(sid: string, call: ToolCall, result: ToolResultMessage) {
  const status = result.isError ? "failed" : "completed";
  const output = text(result.content).trim();
  const content = [fenced(code(call).trim(), "python"), ...(output ? [fenced(output)] : [])];
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

const mcp = new Map<string, unknown[]>(); // what the editor offers this connection
const running = new Map<string, AbortController>();

function open(sessionId: string, servers: unknown[] = []) {
  const configOptions = options(sessionId);
  mcp.set(sessionId, servers);
  const availableCommands = [{ name: "compact", description: "Summarise the conversation and continue from that" }];
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
  "session/new": ({ cwd, mcpServers }) => open(create(cwd), mcpServers),
  "session/resume": ({ sessionId, mcpServers }) => open(sessionId, mcpServers),
  "session/load": ({ sessionId, mcpServers }) => (replay(sessionId), open(sessionId, mcpServers)),
  "session/list": ({ cwd }) => ({
    sessions: readdirSync(SESSIONS)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => {
        const sessionId = file.slice(0, -6);
        const lines = read(sessionId);
        const title = text(lines.find((line) => line.message?.role === "user")?.message?.content ?? "").slice(0, 80);
        const updatedAt = statSync(join(SESSIONS, file)).mtime.toISOString();
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
