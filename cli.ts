#!/usr/bin/env bun
// bee in a terminal. It runs bee.ts and talks to it over ACP, as an editor would.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const out = process.stdout;
const sgr = (on: string, off: string) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
const [bold, dim, italic, red, green, cyan] = [sgr("1", "22"), sgr("2", "22"), sgr("3", "23"), sgr("31", "39"), sgr("32", "39"), sgr("36", "39")];
const band = sgr("48;5;236", "49");

const wrap = (text: string, size = out.columns - 3) =>
  text.split("\n").flatMap((line) => line.match(new RegExp(`.{1,${size}}(?=\\s|$)\\s*|.{1,${size}}`, "g")) ?? [""]);
const last = (rows: string[]) => (rows.length > 3 ? ["⋯", ...rows.slice(-3)] : rows);
const markdown = (row: string) =>
  row
    .replace(/^#+ (.*)/, (_, text) => bold(text))
    .replace(/^(\s*)[-*] /, "$1• ")
    .replace(/\*\*(.+?)\*\*/g, (_, text) => bold(text))
    .replace(/`([^`]+)`/g, (_, text) => cyan(text));

const tool = (mark: string, code: string, output = "", look = dim) => [
  ...last(wrap(code.trim())).map((row, n) => (n ? "  " : mark + " ") + cyan(row)),
  ...(output.trim() ? last(wrap(output.trimEnd())).map((row) => "  " + look(row)) : []),
];

// ── Screen ──────────────────────────────────────────────────────────────────
// Finished rows are printed once. Below them the rest is redrawn: the row being written, running code, a spinner,
// the input and a footer.

let [typed, cursor, row, rows, code, thought, usage] = ["", 0, "", 0, "", "", ""];
let [frame, busy, at, empty] = [0, false, 0, true];
let options: { id: string; currentValue: string; options: { value: string }[] }[] = [];

const clear = () => "\r" + (at ? `\x1b[${at}A` : "") + "\x1b[J";
const field = (text: string) => text.split("\n").flatMap((line) => line.match(new RegExp(`.{1,${out.columns - 3}}`, "g")) ?? [""]);

function draw(printed: string[] = []) {
  const rule = dim("─".repeat(out.columns - 1));
  const right = [...options.map((option) => option.currentValue.split("/").at(-1)), usage].join("  ");
  const left = process.cwd().replace(homedir(), "~").slice(0, out.columns - right.length - 5).padEnd(out.columns - right.length - 3);
  const [input, before] = [field(typed), field(typed.slice(0, cursor))];
  const live = [
    ...(row.trim() ? ["  " + markdown(row)] : []),
    ...(code ? ["", ...tool(dim("●"), code)] : []),
    busy ? cyan("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10]) + " " + dim(italic(thought.trim().split("\n").at(-1)!.slice(0, out.columns - 4))) : "",
  ];
  const bottom = [...live, rule, ...input.map((row, n) => (n ? "  " : cyan("› ")) + row), rule, dim(`  ${left}${right}`)];
  const up = bottom.length - live.length - before.length - 1;
  const cursorAt = (up ? `\x1b[${up}A` : "") + `\x1b[${3 + before.at(-1)!.length}G`;
  out.write(`\x1b[?2026h${clear()}${printed.map((row) => row + "\n").join("")}${bottom.join("\n")}${cursorAt}\x1b[?2026l`);
  at = live.length + before.length;
}

function print(lines: string[], block = true) {
  draw([...(block && !empty ? [""] : []), ...lines]);
  empty = false;
}

/** Text arrives in pieces. A row is printed once it is full. */
function stream(text: string) {
  const full = wrap(row + text);
  [row, thought] = [full.pop()!, ""];
  if (full.length) print(full.map((line) => "  " + markdown(line)), !rows);
  rows += full.length;
  draw();
}

function end() {
  const [rest, first] = [row, !rows];
  [row, rows] = ["", 0];
  if (rest.trim()) print(["  " + markdown(rest)], first);
}

const block = (text: string, look: (row: string) => string) => (end(), print(wrap(text).map(look)));
const user = (text: string) => block(text, (row) => band(`  ${row}`.padEnd(out.columns - 1)));
const note = (text: string, look = dim) => block(text, (row) => "  " + look(row));

const updates: Record<string, (update: any) => void> = {
  user_message_chunk: ({ content }) => user(content.text),
  agent_message_chunk: ({ content }) => stream(content.text),
  agent_thought_chunk: ({ content }) => ((thought += content.text), draw()),
  tool_call: ({ rawInput }) => (end(), ([code, thought] = [rawInput.code, ""]), draw()),
  tool_call_update: ({ status, rawOutput }) => {
    if (status !== "completed" && status !== "failed") return;
    const failed = status === "failed";
    const ran = code;
    code = "";
    print(tool(failed ? red("●") : green("●"), ran, rawOutput, failed ? red : dim));
  },
  usage_update: ({ used, size }) => ((usage = `${Math.ceil((100 * used) / size)}%`), draw()),
};

// ── bee ─────────────────────────────────────────────────────────────────────

const bee = spawn(process.execPath, [join(import.meta.dir, "bee.ts")], { stdio: ["pipe", "pipe", "ignore"] });
bee.on("exit", (status) => quit(status ?? 1));

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

function quit(status = 0, message = "") {
  out.write(clear() + "\x1b[?2004l" + message);
  process.exit(status);
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
  busy = true;
  const spin = setInterval(() => (frame++, draw()), 80);
  const done = () => ((busy = false), (thought = ""), clearInterval(spin), end());
  const { stopReason } = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }).finally(done);
  if (stopReason !== "end_turn") note(stopReason);
}

// `/model` lists the models and `/model <id>` picks one. So does every other setting bee has.
async function set(text: string) {
  const [id, value] = text.slice(1).split(/\s+/);
  const option = options.find((option) => option.id === id);
  if (!option) return note(options.map((option) => "/" + option.id).join("  "));
  if (!option.options.some((o) => o.value === value)) return note(option.options.map((o) => o.value).join("\n"));
  options = (await call("session/set_config_option", { sessionId, configId: id, value })).configOptions;
  draw();
}

let queue = Promise.resolve();
const submit = (text: string) =>
  (queue = queue.then(() => (text.startsWith("/") ? set(text) : prompt(text))).catch((error) => note(error.message, red)));

// ── Keyboard ────────────────────────────────────────────────────────────────

const history: string[] = [];
let back = 0;

const edit = (text: string, to: number) => ([typed, cursor] = [text, Math.max(0, Math.min(text.length, to))]);
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
  "\x1b": () => busy && send({ method: "session/cancel", params: { sessionId } }),
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
