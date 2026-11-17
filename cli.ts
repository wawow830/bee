#!/usr/bin/env bun
// bee in a terminal. It runs bee.ts and talks to it over ACP, as an editor would.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ── Arguments ───────────────────────────────────────────────────────────────

const help = `bee            new session
bee -c         continue the latest session here
bee "…"        start with a prompt
`;

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("-") && arg !== "-c");
if (flags.length) {
  const asked = flags.every((flag) => flag === "-h" || flag === "--help");
  (asked ? process.stdout : process.stderr).write(help);
  process.exit(asked ? 0 : 2);
}
const resume = args.includes("-c");
const first = args.filter((arg) => arg !== "-c").join(" ").trim();

// ── Look ────────────────────────────────────────────────────────────────────

const out = process.stdout;

type Paint = (text: string) => string;

// Colours by value, not by number: a theme can make any number another colour.
const color = (rgb: number): Paint => (text) =>
  `\x1b[38;2;${rgb >> 16};${(rgb >> 8) & 255};${rgb & 255}m${text}\x1b[39m`;
const [amber, light, gray, dark, red] = [0xffaf00, 0xbcbcbc, 0x8a8a8a, 0x4e4e4e, 0xff5f5f].map(color);
const bold: Paint = (text) => `\x1b[1m${text}\x1b[22m`;
const italic: Paint = (text) => `\x1b[3m${text}\x1b[23m`;

const pad = "  "; // every row begins with it, or with a mark as wide
const mark = amber("› "); // what you say begins with it
const bar = "│ "; // what bee runs, and what it printed, are behind it
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"; // the mark, while bee works
const frame = 80; // how many milliseconds each turn of the spinner shows
const tail = 4; // how many rows of code, and of what it printed, are shown
const choices = 8; // how many hints are shown

/** How wide a row can be after `indent` columns. The last column stays free. */
const room = (indent = pad.length) => out.columns - 1 - indent;

/** Text as rows: each of its lines, cut wherever `row` matches. */
const cut = (text: string, row: string) =>
  text.split("\n").flatMap((line) => line.match(new RegExp(row, "g")) ?? [""]);

/** Rows no wider than `size`, broken at a space where there is one. */
const wrap = (text: string, size = room()) => cut(text, `.{1,${size}}(?=\\s|$)\\s*|.{1,${size}}`);

/** As much markdown as a row can show by itself. */
const markdown: Paint = (row) =>
  row
    .replace(/^#+ (.*)/, (_, text) => bold(text))
    .replace(/^(\s*)[-*] /, (_, indent) => indent + gray("• "))
    .replace(/\*\*(.+?)\*\*/g, (_, text) => bold(text))
    .replace(/`([^`]+)`/g, (_, text) => amber(text));

/** Code and what it printed, each cut to its last rows, behind a bar. */
function tool(code: string, output = "", tint = gray) {
  const last = (text: string, look: Paint) => {
    const rows = wrap(text, room(pad.length + bar.length));
    return (rows.length > tail ? ["⋯", ...rows.slice(-tail)] : rows).map((row) => pad + dark(bar) + look(row));
  };
  return [...last(code.replace(/^\s*\n/gm, "").trim(), light), ...last(output.trimEnd(), tint)];
}

// ── Screen ──────────────────────────────────────────────────────────────────
// Finished rows are printed once. Below them the rest is redrawn: what bee is writing, running or thinking,
// what you have queued, and the prompt.

type Option = { id: string; currentValue: string; options: { value: string }[] };

let typed = ""; // the prompt
let cursor = 0; // where the cursor is in it
let tabbed = ""; // what you typed, while Tab goes through what fits it
let reply = ""; // the row bee is writing, until it is full
let begun = false; // whether rows of that reply are printed already
let thought = ""; // what bee is thinking
let usage = ""; // how full its context is
let options: Option[] = []; // the session's settings
let prompts = 0; // how many bee has not answered: a turn is under way while there are any
let printed = false; // whether anything is, yet
let at = 0; // how many rows the cursor is below the top of what is redrawn
const running = new Map<string, string>(); // the code of the calls bee is waiting on
const queued: string[] = []; // waiting for the turn to end
const history: string[] = []; // what you have said, here and in the sessions opened, for Up to recall

const busy = () => prompts > 0;
const up = (rows: number) => (rows ? `\x1b[${rows}A` : "");
const clear = () => "\r" + up(at) + "\x1b[J";

/** What bee is doing: the row it is writing, the code it is running, what it is thinking, and what waits. */
function activity() {
  const thinking = thought.trim().split("\n").at(-1)!.slice(0, room());
  return [
    ...(reply.trim() ? [...(begun ? [] : [""]), pad + markdown(reply)] : []),
    ...[...running.values()].flatMap((code) => ["", ...tool(code)]),
    ...(busy() && thinking ? ["", pad + gray(italic(thinking))] : []),
    ...queued.map((text) => dark("› " + text.split("\n")[0].slice(0, room()))),
  ];
}

/** Redraw, after printing any rows that are finished. */
function draw(finished: string[] = []) {
  const status = [...options.map((option) => option.currentValue.split("/").at(-1)), usage].join(pad);
  const size = room() - pad.length - status.length; // the prompt's width, between its mark and the status
  const chop = (text: string) => cut(text, `.{1,${size}}`);
  const input = chop(typed);
  const before = chop(typed.slice(0, cursor)); // the cursor is at the end of these rows
  const fits = hints(tabbed || typed);
  const last = Math.max(choices, fits.indexOf(typed) + 1); // the hints shown end at the one Tab is on
  const shown = fits.slice(last - choices, last);
  const from = (tabbed || typed).match(/^\/\S*\s+/)?.[0].length ?? 0; // each hint is shown from where it differs
  const below = input.length - before.length + shown.length;
  const turning = spinner[Math.floor(Date.now() / frame) % spinner.length];
  const rows = [
    ...finished,
    ...activity(),
    "",
    `${amber(busy() ? turning : "›")} ${input[0].padEnd(size)}${pad}${dark(status)}`,
    ...input.slice(1).map((row) => pad + row),
    ...shown.map((hint) => {
      const text = hint.slice(from, room());
      return pad + " ".repeat(from) + (hint === typed ? text : dark(text)); // the one Tab is on is in the prompt
    }),
  ];
  // One frame: erase what was drawn, draw, and put the cursor where it is in the prompt.
  const column = pad.length + before.at(-1)!.length + 1;
  out.write(`\x1b[?2026h${clear()}${rows.join("\n")}${up(below)}\x1b[${column}G\x1b[?2026l`);
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
  print(rows.map((row) => pad + markdown(row)), !begun);
  begun ||= rows.length > 0;
}

/** The reply is over, if there was one: print the row that was waiting. */
function end() {
  const rest = reply.trim() ? [pad + markdown(reply)] : [];
  const apart = !begun;
  reply = "";
  begun = false;
  print(rest, apart);
}

/** What you said. */
function user(text: string) {
  end();
  print(wrap(text).map((row, n) => (n ? pad : mark) + row));
}

/** What this terminal has to say for itself. */
function note(text: string, look = gray) {
  end();
  print(wrap(text).map((row) => pad + look(row)));
}

// ── bee ─────────────────────────────────────────────────────────────────────

/** The fields of the updates read here. */
type Update = {
  content: { text: string };
  toolCallId: string;
  rawInput: { command: string };
  rawOutput: string;
  status: string;
  used: number;
  size: number;
};

const updates: Record<string, (update: Update) => void> = {
  // What was said in a session opened.
  user_message_chunk: ({ content }) => {
    history.push(content.text);
    user(content.text);
  },
  agent_message_chunk: ({ content }) => stream(content.text),
  agent_thought_chunk: ({ content }) => {
    thought += content.text;
    draw();
  },
  tool_call: ({ toolCallId, rawInput }) => {
    running.set(toolCallId, rawInput.command);
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

const bee = spawn(process.execPath, [join(import.meta.dir, "bee.ts")], { stdio: ["pipe", "pipe", "ignore"] });
const answers = new Map<number, PromiseWithResolvers<any>>(); // to the calls bee has not answered yet
let calls = 0;

const send = (message: object) => bee.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

/** Ask bee something, and wait for its answer. */
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
bee.on("exit", (status) => quit(status ?? 1));

/** Leave the terminal as it was found. */
function quit(status = 0, message = ""): never {
  out.write(clear() + "\x1b[?2004l" + message);
  process.exit(status);
}

// ── Session ─────────────────────────────────────────────────────────────────

type Session = { sessionId: string; title?: string };

const cwd = process.cwd();
let sessionId = "";
let others: Session[] = []; // the other sessions here, latest first
let last: Promise<unknown> = Promise.resolve(); // the last thing you sent, done: each waits for the one before

const sessions = async (): Promise<Session[]> => (await call("session/list", { cwd })).sessions;
const stop = () => send({ method: "session/cancel", params: { sessionId } });

/** Open the session named, showing what was said in it, or else a new one. */
async function open(id?: string) {
  usage = "";
  const opened = await call(id ? "session/load" : "session/new", { sessionId: id, cwd, mcpServers: [] });
  sessionId = id ?? opened.sessionId;
  options = opened.configOptions;
  others = (await sessions()).filter((session) => session.title && session.sessionId !== sessionId);
}

/** Send bee a prompt, and wait for its turn to end. One sent while a turn is under way joins it. */
async function prompt(text: string) {
  user(text);
  prompts++;
  const done = () => {
    if (--prompts) return; // the turn answers each prompt in it
    thought = "";
    end();
  };
  const { stopReason } = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }).finally(done);
  if (stopReason !== "end_turn" && !prompts) note(stopReason);
}

/** Wait for the turn to end, and for what was queued before. */
function queue(text: string) {
  queued.push(text);
  const next = () => {
    queued.shift();
    return text.startsWith("/") ? command(text) : prompt(text);
  };
  last = last.then(next).catch((error) => note(error.message, red));
}

// ── Commands ────────────────────────────────────────────────────────────────
// `/model`, `/thinking` and `/session` each take one of their values: the one named, or else those with what you
// typed in them. What fits is shown under the prompt. Tab goes through it, and Enter sends the command once only one
// fits.

const title = (session: Session) => session.title!.split("\n")[0].trim();

/** Each command, with its values and what picking one does. */
function commands() {
  const settings = options.map((option) => ({
    id: option.id,
    values: option.options.map((choice) => choice.value),
    pick: async (value: string) => {
      options = (await call("session/set_config_option", { sessionId, configId: option.id, value })).configOptions;
    },
  }));
  const session = {
    id: "session",
    values: ["new", ...others.map(title)],
    pick: (value: string) => open(others.find((other) => title(other) === value)?.sessionId),
  };
  return [...settings, session];
}

/** What the prompt could become: the commands it starts, or the values of its command that fit the words after. */
function hints(text: string): string[] {
  const [, id, words] = text.match(/^\/(\S*)(?:\s+(.*))?$/s) ?? [];
  if (id === undefined) return [];
  const all = commands();
  if (words === undefined) return all.map((command) => `/${command.id} `).filter((hint) => hint.startsWith("/" + id));
  const values = all.find((command) => command.id === id)?.values ?? [];
  const wanted = words.trim();
  const named = values.filter((value) => value === wanted || value.endsWith("/" + wanted));
  const found = named.length ? named : values.filter((value) => value.toLowerCase().includes(wanted.toLowerCase()));
  return found.map((value) => `/${id} ${value}`);
}

/** Run `/<id> <value>`, as a hint wrote it. */
async function command(text: string) {
  note(text);
  const [, id, value] = text.match(/^\/(\S+) (.*)$/s)!;
  await commands().find((command) => command.id === id)!.pick(value);
  draw();
}

// ── Keyboard ────────────────────────────────────────────────────────────────

let back = 0; // how many prompts Up has gone back
let pasting = false; // between the marks a terminal puts around a paste

/** Put `text` where the prompt runs `from` to `to`, and the cursor after it. */
function splice(from: number, to: number, text = "") {
  typed = typed.slice(0, from) + text + typed.slice(to);
  cursor = from + text.length;
}

/** Put the cursor at `to`, or as near as the prompt allows. */
const move = (to: number) => (cursor = Math.max(0, Math.min(typed.length, to)));

/** Put a prompt you said in the prompt, `step` further back. */
function recall(step: number) {
  back = Math.max(0, Math.min(history.length, back + step));
  splice(0, typed.length, back ? history.at(-back) : "");
}

/** Take the first of what fits, or at the next Tab the one after. */
function tab() {
  const fits = hints(tabbed || typed);
  if (fits.length > 1) tabbed ||= typed; // with only one, the next Tab goes on from it
  if (fits.length) splice(0, typed.length, fits[(fits.indexOf(typed) + 1) % fits.length]);
}

/** Send what is typed: into the turn under way, unless you `wait`, or it is a command. */
function enter(wait = false) {
  const text = typed.trim();
  const [hint, ...more] = hints(typed);
  if (text.startsWith("/") && (!hint || more.length || hint.endsWith(" "))) return; // not one value yet
  if (!text) return;
  history.push(text);
  back = 0;
  splice(0, typed.length);
  if (wait || hint || !busy()) return queue(hint ?? text);
  prompt(text).catch((error) => note(error.message, red));
}

const keys: Record<string, () => unknown> = {
  "\r": () => enter(), // Enter
  "\x1b\r": () => enter(true), // Alt-Enter: for when the turn is over
  "\n": () => splice(cursor, cursor, "\n"), // Ctrl-J
  "\t": () => tab(), // Tab
  "\x7f": () => splice(Math.max(0, cursor - 1), cursor), // Backspace
  "\x1b[3~": () => splice(cursor, cursor + 1), // Delete
  "\x17": () => splice(typed.slice(0, cursor).search(/\S*\s*$/), cursor), // Ctrl-W: the word before the cursor
  "\x15": () => splice(0, cursor), // Ctrl-U: all before the cursor
  "\x01": () => move(0), // Ctrl-A
  "\x1b[H": () => move(0), // Home
  "\x1b[1~": () => move(0), // Home, as some terminals send it
  "\x05": () => move(typed.length), // Ctrl-E
  "\x1b[F": () => move(typed.length), // End
  "\x1b[4~": () => move(typed.length), // End, as some terminals send it
  "\x1b[D": () => move(cursor - 1), // Left
  "\x1b[C": () => move(cursor + 1), // Right
  "\x1b[A": () => recall(1), // Up
  "\x1b[B": () => recall(-1), // Down
  "\x1b": () => busy() && stop(), // Esc
  "\x03": () => (typed ? splice(0, typed.length) : busy() ? stop() : quit()), // Ctrl-C: clears, else stops, else quits
};

/** Take what the terminal sends, a key at a time. */
function press(data: string) {
  for (const [key] of data.matchAll(/\x1b\[[\d;]*[^\d;]|\x1b[^]|[^]/g)) {
    if (key !== "\t") tabbed = "";
    if (/^\x1b\[20[01]~$/.test(key)) pasting = key === "\x1b[200~";
    else if (pasting) splice(cursor, cursor, key === "\r" ? "\n" : key);
    else if (keys[key]) keys[key]();
    else if (key >= " ") splice(cursor, cursor, key);
  }
  draw();
}

// ── Start ───────────────────────────────────────────────────────────────────

const fatal = (error: Error) => quit(1, error.message + "\n");
await call("initialize", { protocolVersion: 1, clientCapabilities: {} }).catch(fatal);
const latest = resume ? (await sessions().catch(fatal)).find((session) => session.title) : undefined;
await open(latest?.sessionId).catch(fatal);

process.stdin.setRawMode(true).setEncoding("utf8").on("data", press);
out.write("\x1b[?2004h"); // ask for the marks around a paste
out.on("resize", () => draw());
setInterval(() => busy() && draw(), frame); // the mark turns while bee works

if (first) queue(first);
else draw();
