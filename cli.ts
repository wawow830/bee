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
// Each colour means one thing. Amber is where you type. Words are in the terminal's own colour, code in gray, and
// red is what failed. All else is dark: marks, hints, and what this terminal says for itself.

const out = process.stdout;

type Paint = (text: string) => string;

/** A look that begins with `on` and ends with `off`. Nothing stays nothing, so a blank row stays blank. */
const style = (on: string, off: string): Paint => (text) => text && `\x1b[${on}m${text}\x1b[${off}m`;
// Colours by value, not by number: a theme can make any number another colour.
const color = (rgb: number) => style(`38;2;${rgb >> 16};${(rgb >> 8) & 255};${rgb & 255}`, "39");
const [amber, gray, dark, red] = [0xffaf00, 0x8a8a8a, 0x4e4e4e, 0xff5f5f].map(color);
const bold = style("1", "22");

const pad = "  "; // every row begins with it, or with a mark as wide
const mark = "› "; // what you say begins with it
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"; // the mark, while bee works
const frame = 80; // how many milliseconds each turn of the spinner shows
const choices = 8; // how many hints are shown

/** How wide a row can be after `indent` columns. The last column stays free. */
const room = (indent = pad.length) => out.columns - 1 - indent;

/** Text as rows: each of its lines, cut wherever `row` matches. */
const cut = (text: string, row: string) =>
  text.split("\n").flatMap((line) => line.match(new RegExp(row, "g")) ?? [""]);

/** Rows no wider than `size`, broken after a space where there is one. Each keeps the spaces it was broken at. */
const fill = (text: string, size: number) => cut(text, `.{1,${size}}(?=\\s|$)\\s*|.{1,${size}}`);

/** Rows no wider than `size`, broken at a space where there is one. */
const wrap = (text: string, size = room()) => fill(text, size).map((row) => row.trimEnd());

// A look is which marks of markdown hold: bold, code, or both.
const [strong, code] = [1, 2];
const looks: Paint[] = [(text) => text, bold, gray, (text) => bold(gray(text))];

/** Where a line of code begins or ends. */
const fence = (line: string) => /^\s*```/.test(line);

/**
 * A line of a reply as rows, its markdown shown as it looks. A list item's rows hang under its text. Between fences,
 * `inCode`, the line is shown as it is. Unless the line is `whole`, a mark not yet closed is taken to be closed later.
 */
function markdown(line: string, { inCode = false, whole = true } = {}): string[] {
  if (fence(line)) return [];
  if (inCode) return wrap(line).map(gray);
  const heading = line.match(/^#+\s+(.*)/);
  const [, indent = "", item = "", body = line] = heading ? [] : (line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/) ?? []);
  const lead = item && indent + (/\d/.test(item) ? item : "•") + " ";
  const tokens = (heading?.[1] ?? body).match(/\*\*|`|[^]/g) ?? [];
  // Once the line is whole, a mark with none after it to close it is only characters.
  const unpaired = new Set<number>();
  for (const mark of ["`", "**"]) {
    const at = tokens.flatMap((token, n) => (token === mark ? [n] : []));
    if (whole && at.length % 2) unpaired.add(at.at(-1)!);
  }
  let text = "";
  let look = heading ? strong : 0;
  const each: number[] = []; // the look of each character of `text`
  tokens.forEach((token, n) => {
    if (token === "`" && !unpaired.has(n)) look ^= code;
    else if (token === "**" && !(look & code) && !unpaired.has(n)) look ^= strong;
    else for (const character of token) (text += character), each.push(look);
  });
  let from = 0;
  return fill(text, room(pad.length + lead.length)).map((row, n) => {
    const shown = row.trimEnd();
    let painted = "";
    for (let start = 0, end = 1; start < shown.length; end++) {
      if (end < shown.length && each[from + end] === each[from + start]) continue;
      painted += looks[each[from + start]](shown.slice(start, end));
      start = end;
    }
    from += row.length;
    return (n ? " ".repeat(lead.length) : dark(lead)) + painted;
  });
}

/** The code bee runs, as one row: its first line, and `…` if there is more. */
function tool(text: string, look = gray) {
  const [line, ...more] = text.trim().split("\n");
  const row = line.length > room() || more.length ? line.slice(0, room() - 1) + "…" : line;
  return pad + look(row);
}

// ── Screen ──────────────────────────────────────────────────────────────────
// Finished rows are printed once. Below them the rest is redrawn: what bee is writing or running, what you have
// queued, and the prompt.

type Option = { id: string; currentValue: string; options: { value: string }[] };

let typed = ""; // the prompt
let cursor = 0; // where the cursor is in it
let tabbed = ""; // what you typed, while Tab goes through what fits it
let reply = ""; // the line bee is writing, until it ends
let held = 0; // how many rows of that line are printed already: all but the last, which may grow
let begun = false; // whether rows of the reply are printed already
let blank = false; // whether a blank row waits, to be printed only if more of the reply comes after it
let inCode = false; // whether the reply is between fences
let usage = ""; // how full its context is
let options: Option[] = []; // the session's settings
let prompts = 0; // how many bee has not answered: a turn is under way while there are any
let printed = false; // whether anything is, yet
let ran = false; // whether the last rows printed are code bee ran: code run in a row is not set apart
let at = 0; // how many rows the cursor is below the top of what is redrawn
const running = new Map<string, string>(); // the code of the calls bee is waiting on
const queued: string[] = []; // waiting for the turn to end
const history: string[] = []; // what you have said, here and in the sessions opened, for Up to recall

const busy = () => prompts > 0;
const up = (rows: number) => (rows ? `\x1b[${rows}A` : "");
const clear = () => "\r" + up(at) + "\x1b[J";

/** What bee is doing: the row it is writing and the code it is running, and what waits. */
function activity() {
  const writing = markdown(reply, { inCode, whole: false }).slice(held).filter((row) => row.trim());
  const code = [...running.values()].map((text) => tool(text));
  return [
    ...(writing.length ? [...(begun && !blank ? [] : [""]), ...writing.map((row) => pad + row)] : []),
    ...(code.length ? [...(ran ? [] : [""]), ...code] : []),
    ...queued.map((text) => dark(mark + text.split("\n")[0].slice(0, room()))),
  ];
}

/** What a command is set to, shown beside it as a hint. */
function current(id: string) {
  if (id === "session") return usage && `${usage} of context`;
  return options.find((option) => option.id === id)?.currentValue ?? "";
}

/** Redraw, after printing any rows that are finished. */
function draw(finished: string[] = []) {
  const size = room();
  const chop = (text: string) => cut(text, `.{1,${size}}`);
  const input = chop(typed);
  const before = chop(typed.slice(0, cursor)); // the cursor is at the end of these rows
  const fits = hints(tabbed || typed);
  const last = Math.max(choices, fits.indexOf(typed) + 1); // the hints shown end at the one Tab is on
  const shown = fits.slice(last - choices, last);
  const from = (tabbed || typed).match(/^\/\S*\s+/)?.[0].length ?? 0; // each hint is shown from where it differs
  const more = fits.length - shown.length;
  const widest = Math.max(...shown.map((hint) => hint.trimEnd().length));
  const below = input.length - before.length + shown.length + (more ? 1 : 0);
  const turning = spinner[Math.floor(Date.now() / frame) % spinner.length];
  const rows = [
    ...finished,
    ...activity(),
    "",
    amber(busy() ? turning + " " : mark) + input[0],
    ...input.slice(1).map((row) => pad + row),
    ...shown.map((hint) => {
      const named = hint.match(/^\/(\S+) $/)?.[1]; // a command, which is shown with what it is set to
      const text = (named ? hint.trimEnd().padEnd(widest) + pad + current(named) : hint).slice(from, room()).trimEnd();
      return pad + " ".repeat(from) + (hint === typed ? text : dark(text)); // the one Tab is on is in the prompt
    }),
    ...(more ? [pad + " ".repeat(from) + dark(`${more} more`)] : []),
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
  ran &&= !rows.length;
}

/** Print rows of the reply. Blank rows between its rows are one, and there are none around it. */
function show(rows: string[]) {
  const shown: string[] = [];
  for (const row of rows) {
    if (!row.trim() && !inCode) blank = begun || shown.length > 0;
    else shown.push(...(blank ? [""] : []), pad + row), (blank = false);
  }
  print(shown, !begun);
  begun ||= shown.length > 0;
}

/** A reply arrives in pieces. Its rows are printed as they fill, and the last waits for more. */
function stream(text: string) {
  const lines = (reply + text).split("\n");
  reply = lines.pop()!;
  const rows: string[] = [];
  for (const line of lines) {
    rows.push(...markdown(line, { inCode }).slice(held));
    held = 0;
    if (fence(line)) inCode = !inCode;
  }
  const writing = markdown(reply, { inCode, whole: false });
  show([...rows, ...writing.slice(held, -1)]);
  held = Math.max(held, writing.length - 1);
}

/** The reply is over, if there was one: print what was waiting. */
function end() {
  const rest = markdown(reply, { inCode }).slice(held);
  [reply, held] = ["", 0];
  show(rest);
  [begun, blank, inCode] = [false, false, false];
}

/** What you said. */
function user(text: string) {
  end();
  print(wrap(text).map((row, n) => (n ? pad : dark(mark)) + row));
}

/** What this terminal has to say for itself. */
function note(text: string, look = dark) {
  end();
  print(wrap(text).map((row) => pad + look(row)));
}

// ── bee ─────────────────────────────────────────────────────────────────────

/** The fields of the updates read here. */
type Update = {
  content: { text: string };
  toolCallId: string;
  rawInput: { command: string };
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
  tool_call: ({ toolCallId, rawInput }) => {
    end();
    running.set(toolCallId, rawInput.command);
    draw();
  },
  tool_call_update: ({ toolCallId, status }) => {
    if (status !== "completed" && status !== "failed") return;
    const code = running.get(toolCallId) ?? "";
    running.delete(toolCallId);
    print([tool(code, status === "failed" ? red : gray)], !ran);
    ran = true;
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
