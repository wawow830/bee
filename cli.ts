// bee in a terminal. An editor like any other: it starts bee.ts and speaks ACP to it.
// What is finished is printed once and scrolls away as usual. Only what still changes is
// drawn again at the bottom: the line being written, the status, and your input.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { version } from "./package.json";

const paint = (code: string) => (text: string) => text.replace(/^.*$/gm, (line) => `\x1b[${code}m${line}\x1b[0m`);
const [plain, bold, gray, red, cyan] = [(text: string) => text, paint("1"), paint("90"), paint("31"), paint("36")];
const styles: Record<string, (text: string) => string> = { agent: plain, thought: paint("3;90") };

// ── The screen ──────────────────────────────────────────────────────────────

const out = process.stdout;
let typed = ""; // your input
let line = { kind: "", text: "" }; // the line bee is writing
let options: { id: string; currentValue: string; options: { value: string }[] }[] = []; // bee's settings
let [busy, frame, usage, drawn, last] = [false, 0, "", 0, ""]; // last: the kind of block printed last

const fit = (text: string, room = out.columns - 3) => (text.length > room ? "…" + text.slice(1 - room) : text);
const clear = () => (drawn > 1 ? `\r\x1b[${drawn - 1}A` : "\r") + "\x1b[J";

/** Redraw the bottom, after printing what is finished, if anything. */
function draw(printed = "") {
  const where = process.cwd().replace(homedir(), "~");
  const doing = busy ? "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10] + " esc to stop" : "";
  const live = [
    ...(line.text ? [styles[line.kind](fit(line.text))] : []),
    gray(fit([where, ...options.map((option) => option.currentValue), usage, doing].filter(Boolean).join(" · "))),
    bold("› ") + fit(typed.replaceAll("\n", "↵")),
  ];
  out.write(`\x1b[?2026h${clear()}${printed}${live.join("\n")}\x1b[?2026l`);
  drawn = live.length;
}

/** Print a finished block, apart from the one before unless it continues it. */
function print(kind: string, text: string) {
  if (line.text && line.kind !== kind) end();
  draw((last && kind !== last ? "\n" : "") + text + "\n");
  last = kind;
}

/** Text arrives in pieces. Each line is printed once it is whole. */
function stream(kind: string, text: string) {
  if (line.kind !== kind) end();
  const lines = (line.text + text).split("\n");
  line = { kind, text: lines.pop()! };
  lines.length ? print(kind, styles[kind](lines.join("\n"))) : draw();
}

function end() {
  const { kind, text } = line;
  line = { kind: "", text: "" };
  if (text) print(kind, styles[kind](text));
}

/** The last lines of long output. The model sees all of it. */
function tail(text: string, keep = 10) {
  const lines = text.trimEnd().split("\n");
  return [...(lines.length > keep ? [`… ${lines.length - keep} lines above`] : []), ...lines.slice(-keep)].join("\n");
}

const updates: Record<string, (update: any) => void> = {
  user_message_chunk: ({ content }) => print("user", bold(`› ${content.text?.trim()}`)), // a loaded session
  agent_message_chunk: ({ content }) => stream("agent", content.text ?? ""),
  agent_thought_chunk: ({ content }) => stream("thought", content.text ?? ""),
  tool_call: ({ toolCallId, rawInput }) => print(toolCallId, cyan(String(rawInput?.code ?? "").trim())),
  tool_call_update: ({ toolCallId, status, rawOutput }) =>
    rawOutput?.trim() && print(toolCallId, (status === "failed" ? red : gray)(tail(rawOutput))),
  usage_update: ({ used, size }) => ((usage = `${Math.ceil((100 * used) / size)}%`), draw()),
};

// ── bee ─────────────────────────────────────────────────────────────────────

const bee = spawn(process.execPath, [join(import.meta.dir, "bee.ts")], { stdio: ["pipe", "pipe", "ignore"] });
bee.on("exit", () => quit("bee stopped."));

const send = (message: object) => bee.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const waiting = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
let requests = 0;
const call = (method: string, params: object) =>
  new Promise<any>((resolve, reject) => {
    waiting.set(++requests, { resolve, reject });
    send({ id: requests, method, params });
  });

createInterface({ input: bee.stdout! }).on("line", (text) => {
  const { id, method, params, result, error } = JSON.parse(text);
  if (method === "session/update") return updates[params.update.sessionUpdate]?.(params.update);
  if (method) return send({ id, error: { code: -32601, message: `No method ${method}` } });
  const { resolve, reject } = waiting.get(id)!;
  waiting.delete(id);
  error ? reject(new Error(error.message)) : resolve(result);
});

function quit(message?: string) {
  out.write(clear() + (message ? red(message) + "\n" : ""));
  process.exit(message ? 1 : 0);
}

// ── The session ─────────────────────────────────────────────────────────────

const must = (method: string, params: object) => call(method, params).catch((error) => quit(error.message));
const cwd = process.cwd();
await must("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "bee", version } });
const resume = process.argv.includes("-c") && (await must("session/list", { cwd })).sessions.find((s: any) => s.title);
const session = await must(resume ? "session/load" : "session/new", { sessionId: resume?.sessionId, cwd, mcpServers: [] });
const sessionId: string = session.sessionId;
options = session.configOptions;

async function prompt(text: string) {
  print("user", bold(`› ${text}`));
  busy = true;
  const spin = setInterval(() => (frame++, draw()), 80);
  try {
    const { stopReason } = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    if (stopReason !== "end_turn") print("stop", gray(`[${stopReason}]`));
  } catch (error: any) {
    print("error", red(error.message));
  } finally {
    busy = false;
    clearInterval(spin);
    end();
    draw();
  }
}

/** Each setting bee offers is a command: `/model <value>` sets it, `/model` lists the values. */
async function set(text: string) {
  const [id, value] = text.slice(1).split(/\s+/);
  const option = options.find((option) => option.id === id);
  if (!option) return print("note", gray(options.map((option) => `/${option.id}`).join("  ")));
  if (!option.options.some((o) => o.value === value))
    return print("note", gray(option.options.map((o) => (o.value === option.currentValue ? "● " : "  ") + o.value).join("\n")));
  options = (await call("session/set_config_option", { sessionId, configId: id, value })).configOptions;
  draw();
}

let queue: Promise<unknown> = Promise.resolve(); // what you send while bee works waits its turn
const submit = (text: string) =>
  (queue = queue.then(() => (text.startsWith("/") ? set(text) : prompt(text))).catch((error) => print("error", red(error.message))));

// ── The keyboard ────────────────────────────────────────────────────────────
// Esc stops bee, Ctrl-C clears or quits, and a return at the end sends. A paste arrives
// in one piece, so the returns inside it are just new lines.

process.stdin.setRawMode(true).setEncoding("utf8").on("data", (key: string) => {
  if (key === "\x03") return typed ? ((typed = ""), draw()) : quit();
  if (key === "\x1b") return busy && send({ method: "session/cancel", params: { sessionId } });
  if (key === "\x7f") typed = [...typed].slice(0, -1).join("");
  else if (!key.startsWith("\x1b")) typed += key.replaceAll("\r", "\n").replace(/[^\P{Cc}\n]/gu, "");
  if (typed.endsWith("\n")) {
    if (typed.trim()) submit(typed.trim());
    typed = "";
  }
  draw();
});
out.on("resize", () => draw());

const words = process.argv.slice(2).filter((arg) => arg !== "-c").join(" ");
if (words) submit(words);
draw();
await new Promise(() => {}); // bee.ts waits on this module, so it never starts the harness here
