#!/usr/bin/env bun
// bee in a terminal. An editor like any other: it starts bee.ts and speaks ACP to it.
// A row is printed once it is full and then scrolls away. Only the bottom is drawn again.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const out = process.stdout;
const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
const [bold, italic, gray, red, cyan] = [sgr(1, 22), sgr(3, 23), sgr(90, 39), sgr(31, 39), sgr(36, 39)];

/** Markdown, a row at a time. `**` and `` ` `` switch bold and code, and what is on carries to the next row. */
const marks: Record<string, number> = { "**": 1, "`": 36 };
let on: string[] = []; // the marks on after the last row printed
function markdown(row: string, keep = true) {
  if (/^\s*```/.test(row)) return gray(row);
  let now = on;
  const style = () => `\x1b[0;${now.map((mark) => marks[mark]).join(";")}m`;
  const flip = (mark: string) => ((now = now.includes(mark) ? now.filter((m) => m !== mark) : [...now, mark]), style());
  const styled = style() + row.replace(/^#+ /, "\x1b[1m").replace(/\*\*|`/g, flip) + "\x1b[0m";
  if (keep) on = now;
  return styled;
}

/** Each kind of block has a mark for its first row, and a look for every row. */
const kinds: Record<string, [string, (row: string, keep?: boolean) => string]> = {
  user: [cyan("›"), bold],
  agent: ["●", markdown],
  thought: [gray("●"), (row) => gray(italic(row))],
  code: [cyan("●"), cyan],
  output: [gray("⎿"), gray],
  failed: [red("⎿"), red],
  note: [" ", gray],
};

/** Rows that fit the terminal, broken at spaces where they can be. */
const wrap = (text: string, size = out.columns - 3) =>
  text.split("\n").flatMap((line) => line.match(new RegExp(`.{1,${size}}(?=\\s|$)\\s*|.{1,${size}}`, "g")) ?? [""]);

const rows = (kind: string, rows: string[], first = true, keep = true) =>
  rows.map((row, n) => `${first && !n ? kinds[kind][0] : " "} ${kinds[kind][1](row.trimEnd(), keep)}`);

// ── The screen ──────────────────────────────────────────────────────────────

let [typed, cursor] = ["", 0]; // your input
let writing = { kind: "", row: "", rows: 0 }; // the block bee is writing: its row still filling, and how many are out
let options: { id: string; currentValue: string; options: { value: string }[] }[] = [];
let [busy, frame, usage, at, quiet] = [false, 0, "", 0, true]; // at: the row of the bottom the cursor is on

const clear = () => "\r" + (at ? `\x1b[${at}A` : "") + "\x1b[J";

/** Your input in rows of `size`. The rows of what is before the cursor end where it is. */
const field = (text: string, size: number) =>
  text.split("\n").flatMap((line) => line.match(new RegExp(`.{1,${size}}`, "g")) ?? [""]);

/** Print finished rows, then draw the bottom again: the row filling, your input, and the status. */
function draw(printed: string[] = []) {
  const [width, size] = [out.columns - 1, out.columns - 3];
  const [input, before] = [field(typed, size), field(typed.slice(0, cursor), size)];
  const doing = busy ? "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10] + " esc to stop" : "";
  const status = [process.cwd().replace(homedir(), "~"), ...options.map((option) => option.currentValue), usage, doing];
  const filling = writing.row.trim() ? rows(writing.kind, [writing.row], !writing.rows, false) : [];
  const bottom = [
    ...filling,
    gray("─".repeat(width)),
    ...input.map((row, n) => (n ? "  " : cyan("› ")) + row),
    gray("─".repeat(width)),
    gray(status.filter(Boolean).join(" · ").slice(0, width)),
  ];
  const row = filling.length + before.length;
  const up = bottom.length - 1 - row;
  const place = (up ? `\x1b[${up}A` : "") + `\x1b[${3 + before.at(-1)!.length}G`;
  out.write(`\x1b[?2026h${clear()}${printed.map((row) => row + "\n").join("")}${bottom.join("\n")}${place}\x1b[?2026l`);
  at = row;
}

/** Print rows for good, a row apart from what came before if they start a block. */
function print(lines: string[], apart: boolean) {
  draw([...(apart && !quiet ? [""] : []), ...lines]);
  quiet = false;
}

/** A whole block at once. */
function say(kind: string, text: string, apart = true) {
  end();
  print(rows(kind, wrap(text.trim())), apart);
}

/** Text that comes in pieces: each row is printed once it is full. */
function stream(kind: string, text: string) {
  if (writing.kind !== kind) end();
  const full = wrap(writing.row + text);
  const first = !writing.rows;
  writing = { kind, row: full.pop()!, rows: writing.rows + full.length };
  full.length ? print(rows(kind, full, first), first) : draw();
}

function end() {
  const { kind, row, rows: out } = writing;
  writing = { kind: "", row: "", rows: 0 };
  if (row.trim()) print(rows(kind, [row], !out), !out);
  on = [];
}

const tail = (text: string, lines = text.trimEnd().split("\n")) =>
  (lines.length > 10 ? `… ${lines.length - 10} lines above\n` : "") + lines.slice(-10).join("\n");

const updates: Record<string, (update: any) => void> = {
  user_message_chunk: ({ content }) => say("user", content.text), // from a loaded session
  agent_message_chunk: ({ content }) => stream("agent", content.text),
  agent_thought_chunk: ({ content }) => stream("thought", content.text),
  tool_call: ({ rawInput }) => say("code", rawInput.code),
  tool_call_update: ({ status, rawOutput }) =>
    rawOutput?.trim() && say(status === "failed" ? "failed" : "output", tail(rawOutput), false),
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

createInterface({ input: bee.stdout! }).on("line", (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  if (method) return updates[params.update?.sessionUpdate]?.(params.update);
  error ? waiting.get(id)?.reject(new Error(error.message)) : waiting.get(id)?.resolve(result);
  waiting.delete(id);
});

function quit(message?: string) {
  out.write(clear() + "\x1b[?2004l" + (message ? red(message) + "\n" : ""));
  process.exit(message ? 1 : 0);
}

// ── The session ─────────────────────────────────────────────────────────────

const cwd = process.cwd();
const must = (method: string, params: object) => call(method, params).catch((error) => quit(error.message));
await must("initialize", { protocolVersion: 1, clientCapabilities: {} });
const latest = process.argv.includes("-c") && (await must("session/list", { cwd })).sessions.find((s: any) => s.title);
const session = await must(latest ? "session/load" : "session/new", { sessionId: latest?.sessionId, cwd, mcpServers: [] });
const sessionId: string = session.sessionId;
options = session.configOptions;

async function prompt(text: string) {
  say("user", text);
  busy = true;
  const spin = setInterval(() => (frame++, draw()), 80);
  const done = () => ((busy = false), clearInterval(spin), end());
  const { stopReason } = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }).finally(done);
  if (stopReason !== "end_turn") say("note", stopReason);
}

/** Each setting bee offers is a command: `/model <value>` sets it, and `/model` lists the values. */
async function set(text: string) {
  const [id, value] = text.slice(1).split(/\s+/);
  const option = options.find((option) => option.id === id);
  if (!option) return say("note", options.map((option) => `/${option.id}`).join("  "));
  if (!option.options.some((o) => o.value === value))
    return say("note", option.options.map((o) => (o.value === option.currentValue ? "● " : "  ") + o.value).join("\n"));
  options = (await call("session/set_config_option", { sessionId, configId: id, value })).configOptions;
}

// What you send while bee works waits its turn.
let queue = Promise.resolve();
const submit = (text: string) =>
  (queue = queue.then(() => (text.startsWith("/") ? set(text) : prompt(text))).catch((error) => say("failed", error.message)));

// ── The keyboard ────────────────────────────────────────────────────────────

const history: string[] = [];
let back = 0; // how far back in history the input is

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
  "\x1b\r": () => insert("\n"), // Alt-Enter
  "\x7f": () => cursor && edit(typed.slice(0, cursor - 1) + typed.slice(cursor), cursor - 1),
  "\x1b[D": () => edit(typed, cursor - 1),
  "\x1b[C": () => edit(typed, cursor + 1),
  "\x1b[A": () => recall(1),
  "\x1b[B": () => recall(-1),
  "\x1b": () => busy && send({ method: "session/cancel", params: { sessionId } }),
  "\x03": () => (typed ? edit("", 0) : quit()),
};

// Input is read a key at a time. A paste comes between markers, and in it every key is text.
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
