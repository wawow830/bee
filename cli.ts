#!/usr/bin/env bun
// bee in a terminal. It runs bee.ts and talks to it over ACP, as an editor would.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const out = process.stdout;
const sgr = (on: number | string, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
const [dim, italic, red, green, cyan] = [sgr(2, 22), sgr(3, 23), sgr(31, 39), sgr(32, 39), sgr(36, 39)];
const band = sgr("48;5;236", 49);
const width = () => out.columns - 1;

const wrap = (text: string, size = width() - 2) =>
  text.split("\n").flatMap((line) => line.match(new RegExp(`.{1,${size}}(?=\\s|$)\\s*|.{1,${size}}`, "g")) ?? [""]);

// Markdown, a row at a time. Bold and code can open on one row and close on a later one.
const codes: Record<string, number> = { "**": 1, "`": 36 };
let open: string[] = [];
function markdown(row: string, keep = true) {
  if (/^\s*```/.test(row)) return dim(row);
  let now = open;
  const style = () => `\x1b[0;${now.map((mark) => codes[mark]).join(";")}m`;
  const flip = (mark: string) => ((now = now.includes(mark) ? now.filter((m) => m !== mark) : [...now, mark]), style());
  const styled = style() + row.replace(/^#+ /, "\x1b[1m").replace(/^(\s*)[-*] /, "$1• ").replace(/\*\*|`/g, flip);
  if (keep) open = now;
  return styled + "\x1b[0m";
}

/** Code: its first rows that do something. What it printed: the last. */
const clip = (rows: string[], end = false) =>
  rows.length <= 3 ? rows : end ? ["⋯", ...rows.slice(-3)] : [...rows.slice(0, 3), "⋯"];

function tool(mark: string, code: string, output = "", look = dim) {
  const doing = code.split("\n").filter((line) => line.trim() && !/^(import|from) /.test(line));
  const lines = clip(wrap((doing.length ? doing : [code.trim()]).join("\n"))).map((row, n) => (n ? "  " : mark + " ") + cyan(row.trimEnd()));
  return [...lines, ...(output.trim() ? clip(wrap(output.trimEnd()), true).map((row) => "  " + look(row.trimEnd())) : [])];
}

// ── Screen ──────────────────────────────────────────────────────────────────
// Finished rows are printed once. The bottom is redrawn: the row being written, running code, a spinner with
// what bee is thinking, the input, and a footer.

let [typed, cursor] = ["", 0];
let writing = { row: "", rows: 0 };
let [running, thinking] = ["", ""];
let options: { id: string; currentValue: string; options: { value: string }[] }[] = [];
let [started, frame, usage, at, empty] = [0, 0, "", 0, true];

const clear = () => "\r" + (at ? `\x1b[${at}A` : "") + "\x1b[J";
const field = (text: string, size: number) =>
  text.split("\n").flatMap((line) => line.match(new RegExp(`.{1,${size}}`, "g")) ?? [""]);

function draw(printed: string[] = []) {
  const w = width();
  const [input, before] = [field(typed, w - 2), field(typed.slice(0, cursor), w - 2)];
  const filling = writing.row.trim() ? ["  " + markdown(writing.row.trimEnd(), false)] : [];
  const thought = thinking.trim().split("\n").at(-1)!.slice(0, w - 12);
  const seconds = `${Math.floor((Date.now() - started) / 1000)}s`;
  const spinner = started ? cyan("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10]) + " " + dim(seconds + "  " + italic(thought)) : "";
  const right = [...options.map((option) => option.currentValue.split("/").at(-1)), usage].join("  ");
  const left = process.cwd().replace(homedir(), "~").slice(0, Math.max(0, w - right.length - 2));
  const code = running ? ["", ...tool(dim("●"), running)] : [];
  const bottom = [
    ...filling,
    ...code,
    spinner,
    dim("─".repeat(w)),
    ...input.map((row, n) => (n ? "  " : cyan("› ")) + row),
    dim("─".repeat(w)),
    dim("  " + left.padEnd(w - right.length - 2) + right),
  ];
  const row = filling.length + code.length + 1 + before.length;
  const up = bottom.length - 1 - row;
  const place = (up ? `\x1b[${up}A` : "") + `\x1b[${3 + before.at(-1)!.length}G`;
  out.write(`\x1b[?2026h${clear()}${printed.map((row) => row + "\n").join("")}${bottom.join("\n")}${place}\x1b[?2026l`);
  at = row;
}

function print(rows: string[], block = true) {
  draw([...(block && !empty ? [""] : []), ...rows]);
  empty = false;
}

function stream(text: string) {
  const rows = wrap(writing.row + text);
  const first = !writing.rows;
  writing = { row: rows.pop()!, rows: writing.rows + rows.length };
  thinking = "";
  rows.length ? print(rows.map((row) => "  " + markdown(row.trimEnd())), first) : draw();
}

function end() {
  const { row, rows } = writing;
  writing = { row: "", rows: 0 };
  if (row.trim()) print(["  " + markdown(row.trimEnd())], !rows);
  open = [];
}

const user = (text: string) => (end(), print(wrap(text).map((row) => band(`  ${row.trimEnd()}`.padEnd(width())))));
const note = (text: string, look = dim) => (end(), print(wrap(text).map((row) => "  " + look(row))));

const updates: Record<string, (update: any) => void> = {
  user_message_chunk: ({ content }) => user(content.text),
  agent_message_chunk: ({ content }) => stream(content.text),
  agent_thought_chunk: ({ content }) => ((thinking += content.text), draw()),
  tool_call: ({ rawInput }) => (end(), ([running, thinking] = [rawInput.code, ""]), draw()),
  tool_call_update: ({ status, rawOutput }) => {
    if (status !== "completed" && status !== "failed") return;
    const failed = status === "failed";
    const code = running;
    running = "";
    print(tool(failed ? red("●") : green("●"), code, rawOutput ?? "", failed ? red : dim));
  },
  usage_update: ({ used, size }) => ((usage = `${Math.ceil((100 * used) / size)}%`), draw()),
};

// ── bee ─────────────────────────────────────────────────────────────────────

const bee = spawn(process.execPath, [join(import.meta.dir, "bee.ts")], { stdio: ["pipe", "pipe", "ignore"] });
bee.on("exit", (code) => quit(code ?? 1));

const send = (message: object) => bee.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const waiting = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
let requests = 0;
const call = (method: string, params: object) =>
  new Promise<any>((resolve, reject) => {
    waiting.set(++requests, { resolve, reject });
    send({ id: requests, method, params });
  });

createInterface({ input: bee.stdout! }).on("line", (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  if (method) return updates[params.update?.sessionUpdate]?.(params.update);
  error ? waiting.get(id)?.reject(new Error(error.message)) : waiting.get(id)?.resolve(result);
  waiting.delete(id);
});

function quit(code = 0, message = "") {
  out.write(clear() + "\x1b[?2004l" + message);
  process.exit(code);
}

// ── Session ─────────────────────────────────────────────────────────────────

const cwd = process.cwd();
const must = (method: string, params: object) => call(method, params).catch((error) => quit(1, error.message + "\n"));
await must("initialize", { protocolVersion: 1, clientCapabilities: {} });
const latest = process.argv.includes("-c") && (await must("session/list", { cwd })).sessions.find((s: any) => s.title);
const session = await must(latest ? "session/load" : "session/new", { sessionId: latest?.sessionId, cwd, mcpServers: [] });
const sessionId: string = session.sessionId;
options = session.configOptions;

async function prompt(text: string) {
  user(text);
  [started, thinking] = [Date.now(), ""];
  const spin = setInterval(() => (frame++, draw()), 80);
  const done = () => ((started = 0), (thinking = ""), clearInterval(spin), end());
  const { stopReason } = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }).finally(done);
  if (stopReason !== "end_turn") note(stopReason);
}

// `/model` lists the models, `/model <id>` picks one. The same goes for every setting bee has.
async function set(text: string) {
  const [id, value] = text.slice(1).split(/\s+/);
  const option = options.find((option) => option.id === id);
  if (!option) return note(options.map((option) => "/" + option.id).join("  "));
  if (!option.options.some((o) => o.value === value))
    return note(option.options.map((o) => (o.value === option.currentValue ? o.value : dim(o.value))).join("\n"), (row) => row);
  options = (await call("session/set_config_option", { sessionId, configId: id, value })).configOptions;
  draw();
}

let queue = Promise.resolve();
const submit = (text: string) =>
  (queue = queue.then(() => (text.startsWith("/") ? set(text) : prompt(text))).catch((error) => note(error.message, red)));

// ── Keyboard ────────────────────────────────────────────────────────────────

const history: string[] = [];
let back = 0;

const edit = (text: string, at: number) => ([typed, cursor] = [text, Math.max(0, Math.min(text.length, at))]);
const insert = (text: string) => edit(typed.slice(0, cursor) + text + typed.slice(cursor), cursor + text.length);
const recall = (step: number) => {
  back = Math.max(0, Math.min(history.length, back + step));
  edit(history.at(-back) ?? "", Infinity);
};

const keys: Record<string, () => unknown> = {
  "\r": () => {
    if (!typed.trim()) return;
    history.push(typed.trim());
    submit(typed.trim());
    back = 0;
    edit("", 0);
  },
  "\x1b\r": () => insert("\n"),
  "\x7f": () => cursor && edit(typed.slice(0, cursor - 1) + typed.slice(cursor), cursor - 1),
  "\x1b[D": () => edit(typed, cursor - 1),
  "\x1b[C": () => edit(typed, cursor + 1),
  "\x1b[A": () => recall(1),
  "\x1b[B": () => recall(-1),
  "\x1b": () => started && send({ method: "session/cancel", params: { sessionId } }),
  "\x03": () => (typed ? edit("", 0) : quit()),
};

let pasting = false;
process.stdin.setRawMode(true).setEncoding("utf8").on("data", (data: string) => {
  for (const [key] of data.matchAll(/\x1b\[[\d;]*[^\d;]|\x1b[^]|[^]/g)) {
    if (/^\x1b\[20[01]~$/.test(key)) pasting = key === "\x1b[200~";
    else if (pasting) insert(key === "\r" ? "\n" : key);
    else if (keys[key]) keys[key]();
    else if (key >= " ") insert(key);
  }
  draw();
});
out.write("\x1b[?2004h");
out.on("resize", () => draw());
draw();
const words = process.argv.slice(2).filter((arg) => arg !== "-c").join(" ");
if (words) submit(words);
