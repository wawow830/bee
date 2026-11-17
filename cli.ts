#!/usr/bin/env bun
// bee in a terminal. It runs bee.ts and talks to it over ACP, as an editor would.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith("-") && arg !== "-c")) {
  console.log("bee            new session");
  console.log("bee -c         continue the latest session here");
  console.log('bee "…"        start with a prompt');
  process.exit();
}

// ── Look ────────────────────────────────────────────────────────────────────

const out = process.stdout;
const color = (code: number) => (text: string) => `\x1b[38;5;${code}m${text}\x1b[39m`;
const [amber, light, gray, dark, red] = [214, 250, 245, 239, 203].map(color);
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const italic = (text: string) => `\x1b[3m${text}\x1b[23m`;

/** Text as rows: each of its lines, cut wherever `row` matches. */
const cut = (text: string, row: string) =>
  text.split("\n").flatMap((line) => line.match(new RegExp(row, "g")) ?? [""]);

/** Rows no wider than `size`, broken at a space where there is one. */
const wrap = (text: string, size = out.columns - 3) => cut(text, `.{1,${size}}(?=\\s|$)\\s*|.{1,${size}}`);

/** As much markdown as a row can show by itself. */
const markdown = (row: string) =>
  row
    .replace(/^#+ (.*)/, (_, text) => bold(text))
    .replace(/^(\s*)[-*] /, (_, indent) => indent + gray("• "))
    .replace(/\*\*(.+?)\*\*/g, (_, text) => bold(text))
    .replace(/`([^`]+)`/g, (_, text) => amber(text));

/** Code and what it printed, each cut to its last rows, behind a bar. */
function tool(code: string, output = "", tint = gray) {
  const barred = (text: string, look: (row: string) => string) => {
    const all = wrap(text, out.columns - 5);
    return (all.length > 4 ? ["⋯", ...all.slice(-4)] : all).map((row) => `  ${dark("│")} ${look(row)}`);
  };
  return [...barred(code.replace(/^\s*\n/gm, "").trim(), light), ...barred(output.trimEnd(), tint)];
}

// ── Screen ──────────────────────────────────────────────────────────────────
// Finished rows are printed once. Below them the rest is redrawn: what bee is writing, running or thinking,
// what you have queued, and the prompt.

let typed = ""; // the prompt, and where the cursor is in it
let cursor = 0;
let reply = ""; // the row bee is writing, until it is full
let begun = false; // whether rows of that reply are printed already
let thought = ""; // what bee is thinking
let usage = ""; // how full its context is
let busy = false; // a turn is under way
let printed = false; // whether anything is, yet
let at = 0; // how many rows the cursor is below the top of what is redrawn
let options: { id: string; currentValue: string; options: { value: string }[] }[] = [];
const running = new Map<string, string>(); // the code of the calls bee is waiting on
const queued: string[] = []; // sent while bee works, waiting their turn

const up = (rows: number) => (rows ? `\x1b[${rows}A` : "");
const clear = () => "\r" + up(at) + "\x1b[J";

/** Redraw, after printing any rows that are finished. */
function draw(finished: string[] = []) {
  const status = [...options.map((option) => option.currentValue.split("/").at(-1)), usage].join("  ");
  const size = out.columns - status.length - 5; // the prompt's width, between its mark and the status
  const chop = (text: string) => cut(text, `.{1,${size}}`);
  const input = chop(typed);
  const before = chop(typed.slice(0, cursor)); // the cursor is at the end of these rows
  const below = input.length - before.length;
  const mark = busy ? "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(Date.now() / 80) % 10] : "›";
  const thinking = thought.trim().split("\n").at(-1)!.slice(0, out.columns - 3);
  const rows = [
    ...finished,
    ...(reply.trim() ? [...(begun ? [] : [""]), "  " + markdown(reply)] : []),
    ...[...running.values()].flatMap((code) => ["", ...tool(code)]),
    ...(busy && thinking ? ["", "  " + gray(italic(thinking))] : []),
    ...queued.map((text) => dark("› " + text.split("\n")[0].slice(0, out.columns - 3))),
    "",
    `${amber(mark)} ${input[0].padEnd(size)}  ${dark(status)}`,
    ...input.slice(1).map((row) => "  " + row),
  ];
  // One frame: erase what was drawn, draw, and put the cursor where it is in the prompt.
  out.write(`\x1b[?2026h${clear()}${rows.join("\n")}${up(below)}\x1b[${3 + before.at(-1)!.length}G\x1b[?2026l`);
  at = rows.length - finished.length - below - 1;
}

/** Print finished rows, set apart from those before them unless they carry on a reply. */
function print(rows: string[], apart = true) {
  draw(rows.length && apart && printed ? ["", ...rows] : rows);
  printed ||= rows.length > 0;
}

/** A reply arrives in pieces. Its rows are printed as they fill, and the last waits for more. */
function stream(text: string) {
  const rows = wrap(reply + text);
  reply = rows.pop()!;
  thought = "";
  print(rows.map((row) => "  " + markdown(row)), !begun);
  begun ||= rows.length > 0;
}

/** The reply is over, if there was one: print the row that was waiting. */
function end() {
  const rest = reply.trim() ? ["  " + markdown(reply)] : [];
  const apart = !begun;
  reply = "";
  begun = false;
  print(rest, apart);
}

/** What you said. */
function user(text: string) {
  end();
  print(wrap(text).map((row, n) => (n ? "  " : amber("› ")) + row));
}

/** What this terminal has to say for itself. */
function note(text: string, look = gray) {
  end();
  print(wrap(text).map((row) => "  " + look(row)));
}

const updates: Record<string, (update: any) => void> = {
  user_message_chunk: ({ content }) => user(content.text),
  agent_message_chunk: ({ content }) => stream(content.text),
  agent_thought_chunk: ({ content }) => {
    thought += content.text;
    draw();
  },
  tool_call: ({ toolCallId, rawInput }) => {
    running.set(toolCallId, rawInput.code);
    thought = "";
    end();
  },
  tool_call_update: ({ toolCallId, status, rawOutput }) => {
    if (status !== "completed" && status !== "failed") return;
    const code = running.get(toolCallId) ?? "";
    running.delete(toolCallId);
    print(tool(code, rawOutput, status === "failed" ? red : gray));
  },
  usage_update: ({ used, size }) => {
    usage = `${Math.ceil((100 * used) / size)}%`;
    draw();
  },
};

setInterval(() => busy && draw(), 80); // the mark turns while bee works

// ── bee ─────────────────────────────────────────────────────────────────────

const bee = spawn(process.execPath, [join(import.meta.dir, "bee.ts")], { stdio: ["pipe", "pipe", "ignore"] });
bee.on("exit", (status) => quit(status ?? 1));

const send = (message: object) => bee.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

const answers = new Map<number, PromiseWithResolvers<any>>(); // to the calls bee has not answered yet
let calls = 0;

function call(method: string, params: object): Promise<any> {
  const answer = Promise.withResolvers<any>();
  answers.set(++calls, answer);
  send({ id: calls, method, params });
  return answer.promise;
}

createInterface({ input: bee.stdout! }).on("line", (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  if (method) return updates[params.update?.sessionUpdate]?.(params.update);
  const answer = answers.get(id);
  answers.delete(id);
  if (error) answer?.reject(new Error(error.message));
  else answer?.resolve(result);
});

function quit(status = 0, message = ""): never {
  out.write(clear() + "\x1b[?2004l" + message);
  process.exit(status);
}

// ── Session ─────────────────────────────────────────────────────────────────

type Session = { sessionId: string; title?: string };

const cwd = process.cwd();
let sessionId = "";

const sessions = async (): Promise<Session[]> => (await call("session/list", { cwd })).sessions;

/** Open the session named, showing what was said in it, or else a new one. */
async function open(id?: string) {
  const opened = await call(id ? "session/load" : "session/new", { sessionId: id, cwd, mcpServers: [] });
  sessionId = id ?? opened.sessionId;
  options = opened.configOptions;
  usage = "";
}

/** Send bee a prompt, and wait for its turn to end. */
async function prompt(text: string) {
  user(text);
  busy = true;
  const done = () => {
    busy = false;
    thought = "";
    end();
  };
  const { stopReason } = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }).finally(done);
  if (stopReason !== "end_turn") note(stopReason);
}

// `/model` lists the models and `/model <id>` picks one, or `/model opus` the one with that in its id.
// So does every other setting bee has.
async function set(id: string, wanted = "") {
  const option = options.find((option) => option.id === id);
  if (!option) return note([...options.map((option) => "/" + option.id), "/session"].join("  "));
  const values = option.options.map((choice) => choice.value);
  const exact = values.filter((value) => value === wanted || value.split("/").at(-1) === wanted);
  const found = exact.length ? exact : values.filter((value) => wanted && value.includes(wanted));
  if (found.length !== 1) return note((found.length ? found : values).join("\n"));
  options = (await call("session/set_config_option", { sessionId, configId: id, value: found[0] })).configOptions;
  draw();
}

// `/session` lists the other sessions here, and `/session <words>` opens the one with them in its title or id.
async function reopen(wanted: string) {
  const others = (await sessions()).filter((session) => session.title && session.sessionId !== sessionId);
  const named = (s: Session) => `${s.sessionId} ${s.title}`.toLowerCase().includes(wanted.toLowerCase());
  const found = wanted ? others.filter(named) : [];
  if (found.length !== 1) {
    const titles = (found.length ? found : others).slice(0, 10).map((session) => session.title!.split("\n")[0]);
    return note(titles.join("\n") || "No other sessions here.");
  }
  await open(found[0].sessionId);
  draw();
}

function command(text: string) {
  const [name, wanted] = text.slice(1).split(/\s+/);
  return name === "session" ? reopen(text.slice("/session".length).trim()) : set(name, wanted);
}

let last: Promise<unknown> = Promise.resolve(); // the last thing you sent, done: each waits for the one before

function submit(text: string) {
  queued.push(text);
  const next = () => {
    queued.shift();
    return text.startsWith("/") ? command(text) : prompt(text);
  };
  last = last.then(next).catch((error) => note(error.message, red));
}

const fatal = (error: Error) => quit(1, error.message + "\n");
await call("initialize", { protocolVersion: 1, clientCapabilities: {} }).catch(fatal);
const latest = args.includes("-c") ? (await sessions().catch(fatal)).find((session) => session.title) : undefined;
await open(latest?.sessionId).catch(fatal);

// ── Keyboard ────────────────────────────────────────────────────────────────

const history: string[] = [];
let back = 0; // how many prompts Up has gone back

/** Put `text` where the prompt runs `from` to `to`, and the cursor after it. */
function splice(from: number, to: number, text = "") {
  typed = typed.slice(0, from) + text + typed.slice(to);
  cursor = from + text.length;
}

function move(to: number) {
  cursor = Math.max(0, Math.min(typed.length, to));
}

function recall(step: number) {
  back = Math.max(0, Math.min(history.length, back + step));
  splice(0, typed.length, back ? history.at(-back) : "");
}

function enter() {
  const text = typed.trim();
  if (!text) return;
  history.push(text);
  back = 0;
  splice(0, typed.length);
  submit(text);
}

const keys: Record<string, () => unknown> = {
  "\r": enter,
  "\x1b\r": () => splice(cursor, cursor, "\n"), // Alt-Enter
  "\x7f": () => splice(Math.max(0, cursor - 1), cursor), // Backspace
  "\x1b[3~": () => splice(cursor, cursor + 1), // Delete
  "\x17": () => splice(typed.slice(0, cursor).search(/\S*\s*$/), cursor), // Ctrl-W: the word before the cursor
  "\x15": () => splice(0, cursor), // Ctrl-U
  "\x01": () => move(0), // Ctrl-A, and Home as terminals send it
  "\x1b[H": () => move(0),
  "\x1b[1~": () => move(0),
  "\x05": () => move(typed.length), // Ctrl-E, and End
  "\x1b[F": () => move(typed.length),
  "\x1b[4~": () => move(typed.length),
  "\x1b[D": () => move(cursor - 1), // Left and Right
  "\x1b[C": () => move(cursor + 1),
  "\x1b[A": () => recall(1), // Up and Down
  "\x1b[B": () => recall(-1),
  "\x1b": () => busy && send({ method: "session/cancel", params: { sessionId } }), // Esc
  "\x03": () => (typed ? splice(0, typed.length) : quit()), // Ctrl-C
};

let pasting = false; // between the marks a terminal puts around a paste

process.stdin.setRawMode(true).setEncoding("utf8").on("data", (data: string) => {
  for (const [key] of data.matchAll(/\x1b\[[\d;]*[^\d;]|\x1b[^]|[^]/g)) {
    if (/^\x1b\[20[01]~$/.test(key)) pasting = key === "\x1b[200~";
    else if (pasting) splice(cursor, cursor, key === "\r" ? "\n" : key);
    else if (keys[key]) keys[key]();
    else if (key >= " ") splice(cursor, cursor, key);
  }
  draw();
});
out.write("\x1b[?2004h"); // ask for those marks
out.on("resize", () => draw());

const first = args.filter((arg) => arg !== "-c").join(" ").trim();
if (first) submit(first);
else draw();
