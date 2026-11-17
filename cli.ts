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
const first = args
  .filter((arg) => arg !== "-c")
  .join(" ")
  .trim();

// ── Look ────────────────────────────────────────────────────────────────────
// Each colour means one thing. Amber is where you type. Words are in the terminal's own colour, code in gray, and
// red is what failed. All else is dark: marks, hints, and what this terminal says for itself. What bee thinks is as
// what it says, only faint and italic.

const out = process.stdout;

type Paint = (text: string) => string;

/** A look that begins with `on` and ends with `off`. Nothing stays nothing, so a blank row stays blank. */
const style =
  (on: string, off: string): Paint =>
  (text) =>
    text && `\x1b[${on}m${text}\x1b[${off}m`;
// Colours by value, not by number: a theme can make any number another colour.
const color = (rgb: number) => style(`38;2;${rgb >> 16};${(rgb >> 8) & 255};${rgb & 255}`, "39");
const [amber, gray, dark, red] = [0xffaf00, 0x8a8a8a, 0x4e4e4e, 0xff5f5f].map(color);
const bold = style("1", "22");
const faint = style("2;3", "22;23");

const pad = "  "; // every row begins with it, or with a mark as wide
const mark = "› "; // what you say begins with it
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"; // the mark, while bee works
const frame = 80; // how many milliseconds each turn of the spinner shows
const choices = 8; // how many hints are shown

/** How wide a row can be after `indent` columns. The last column stays free. */
const room = (indent = pad.length) => out.columns - 1 - indent;

/** Text as rows: each of its lines, cut wherever `row` matches. */
const cut = (text: string, row: string) => text.split("\n").flatMap((line) => line.match(new RegExp(row, "g")) ?? [""]);

/** Rows no wider than `size`, broken after a space where there is one. Each keeps the spaces it was broken at. */
const fill = (text: string, size: number) => cut(text, `.{1,${size}}(?=\\s|$)\\s*|.{1,${size}}`);

/** Rows no wider than `size`, broken at a space where there is one. */
const wrap = (text: string, size = room()) => fill(text, size).map((row) => row.trimEnd());

/** Text at a glance, as one row: its first line, and `…` if there is more. */
function glance(text: string, look: Paint) {
  const [line, ...more] = text.trim().split("\n");
  const row = line.length > room() || more.length ? line.slice(0, room() - 1) + "…" : line;
  return pad + look(row);
}

// ── Markdown ────────────────────────────────────────────────────────────────
// A reply is shown as it looks. It is read as blocks: a line of prose, code between fences, or a table. Blank lines
// between blocks are one blank row, and there are none before or after them. While a reply arrives, a row is final
// once nothing more of it can change the row. Those are printed, and the rest wait below them.

// A look is which of these hold: bold, code, thought.
const [strong, mono, thought] = [1, 2, 4];

/** Text in a look. */
const looks =
  (look: number): Paint =>
  (text) => {
    if (look & mono) text = gray(text);
    if (look & strong) text = bold(text);
    if (look & thought) text = faint(text);
    return text;
  };

/** Text with its marks taken out, the look of each character, and where in it a mark not yet closed is. */
type Marked = { text: string; each: number[]; open: number };

/** Rows, and how many of them are final. */
type Rendered = { rows: string[]; final: number };

/** How many columns `row` takes on screen. */
const width = (row: string) => row.replace(/\x1b\[[\d;]*m/g, "").length;

/** The marks of markdown in `text`, and each character between them. */
const tokens = (text: string) => text.match(/\*\*|`|[^]/g) ?? [];

/** Where in `parts` a mark is that nothing after it closes. In code, `**` is only characters. */
function unpaired(parts: string[]) {
  const open = new Map<string, number>(); // each mark still open, and where
  for (const [n, part] of parts.entries()) {
    if (part !== "`" && (part !== "**" || open.has("`"))) continue;
    if (open.has(part)) open.delete(part);
    else open.set(part, n);
  }
  return new Set(open.values());
}

/**
 * `text` with its marks taken out. A mark nothing closes is only characters once the text is `whole`. Before, it is
 * taken to be closed later, and what comes after it may yet look otherwise.
 */
function marked(text: string, whole: boolean, look = 0): Marked {
  const parts = tokens(text);
  const unclosed = unpaired(parts);
  const result: Marked = { text: "", each: [], open: Infinity };
  parts.forEach((part, n) => {
    const plain = unclosed.has(n) && whole; // this mark is only characters
    if (unclosed.has(n)) result.open = Math.min(result.open, result.text.length);
    if (part === "`" && !plain) look ^= mono;
    else if (part === "**" && !(look & mono) && !plain) look ^= strong;
    else for (const character of part) ((result.text += character), result.each.push(look));
  });
  return result;
}

/** Marked text as rows no wider than `size`, each part of a row in its look. Those before a mark not yet closed are final. */
function paint({ text, each, open }: Marked, size: number): Rendered {
  let from = 0; // where in `text` the row begins
  let final = 0;
  const rows = fill(text, size).map((row) => {
    const kept = row.trimEnd();
    let painted = "";
    for (let start = 0, end = 1; start < kept.length; end++) {
      if (end < kept.length && each[from + end] === each[from + start]) continue;
      painted += looks(each[from + start])(kept.slice(start, end));
      start = end;
    }
    from += row.length;
    if (from <= open) final++;
    return painted;
  });
  return { rows, final };
}

/** Rows of a block, of which `final` are final, or all once it is `done`. */
const settle = (rows: string[], done: boolean, final: number): Rendered => ({
  rows,
  final: done ? rows.length : final,
});

/** Rows after `lead`: the first begins with it, and the rest under where the first's text begins. */
const hang = (lead: string, rows: string[]) => rows.map((row, n) => (n ? " ".repeat(width(lead)) : lead) + row);

/** A line of prose, in the `look` of what it is part of. A heading is bold, and a list item's rows hang under its text. */
function prose(line: string, done: boolean, look: number) {
  const heading = line.match(/^#{1,6}\s+(.*)/);
  const [, indent = "", item = "", body = line] = heading ? [] : (line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/) ?? []);
  const lead = item && indent + (/\d/.test(item) ? item : "•") + " ";
  const { rows, final } = paint(
    marked(heading?.[1] ?? body, done, heading ? look | strong : look),
    room(pad.length + lead.length),
  );
  return settle(hang(looks(look)(dark(lead)), rows), done, Math.min(final, rows.length - 1)); // the last row may yet grow
}

/** A line of code, as it is. Its rows hang under where its text begins. */
function source(line: string, look: Paint) {
  const [, indent, text] = line.replace(/\t/g, "    ").match(/^(\s*)(.*)/)!;
  return hang(indent, wrap(text, room(pad.length + indent.length)).map(look));
}

/** Where a block of code begins or ends. */
const fence = (line: string) => /^\s*```/.test(line);

/** Whether a line is a row of a table. */
const tabled = (line: string) => line.trimStart().startsWith("|");

/** The cells of a row of a table. */
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

/** Whether a row of a table is the rule under its head, which says how each column is aligned. */
const isRule = (line: string) => /^[\s|:-]+$/.test(line) && line.includes("-");

/**
 * The lines of a table as rows. Each column is as wide as what is in it, or narrower if the table must be, and is
 * aligned as its rule says. The head is bold, with a rule under it.
 */
function table(lines: string[], whole: boolean, look: number) {
  const gap = pad; // between columns
  const rule = cells(lines.find(isRule) ?? "");
  const headed = isRule(lines[1] ?? "");
  const content = lines.filter((line) => !isRule(line)).map(cells);
  const columns = [...Array(Math.max(...content.map((row) => row.length))).keys()];
  const text = content.map((row, r) =>
    columns.map((n) => marked(row[n] ?? "", whole, headed && !r ? look | strong : look)),
  );
  const widths = columns.map((n) => Math.max(1, ...text.map((row) => row[n].text.length)));
  const sum = () => widths.reduce((sum, each) => sum + each, 0);
  while (sum() > room() - gap.length * (columns.length - 1) && Math.max(...widths) > 1) {
    widths[widths.indexOf(Math.max(...widths))]--; // the widest gives way first
  }
  /** A row of a cell, as wide as its column, and set where its column's rule puts it. */
  const place = (row: string, n: number) => {
    const space = widths[n] - width(row);
    const [left, right] = [rule[n]?.startsWith(":"), rule[n]?.endsWith(":")];
    const before = right ? (left ? space >> 1 : space) : 0;
    return " ".repeat(before) + row + " ".repeat(space - before);
  };
  return text.flatMap((row, r) => {
    const painted = row.map((cell, n) => paint(cell, widths[n]).rows);
    const height = Math.max(...painted.map((each) => each.length));
    const shown = [...Array(height).keys()].map((m) => columns.map((n) => place(painted[n][m] ?? "", n)).join(gap));
    const under = headed && !r ? [looks(look)(dark(widths.map((each) => "─".repeat(each)).join(gap)))] : [];
    return [...shown.map((each) => each.trimEnd()), ...under];
  });
}

type Kind = "prose" | "code" | "table";

/** A block of a reply: its lines, whether a blank line comes before it, and whether more can change it. */
type Block = { kind: Kind; lines: string[]; apart: boolean; done: boolean };

/**
 * A reply's blocks. Once it is `whole`, all are done. Before, a block is done once a line after it has begun, and a
 * table once that line has begun with something other than `|`.
 */
function* blocks(reply: string, whole: boolean): Generator<Block> {
  const lines = reply.split("\n");
  /** Where the first line from `from` on is that `ends` the block, or the end. */
  const until = (from: number, ends: (line: string) => boolean) => {
    const at = lines.findIndex((line, n) => n >= from && ends(line));
    return at < 0 ? lines.length : at;
  };
  let apart = false;
  for (let n = 0; n < lines.length;) {
    if (!lines[n].trim()) {
      [apart, n] = [true, n + 1];
      continue;
    }
    const kind: Kind = fence(lines[n]) ? "code" : tabled(lines[n]) ? "table" : "prose";
    const end = {
      code: Math.min(lines.length, until(n + 1, fence) + 1),
      table: until(n, (line) => !tabled(line)),
      prose: n + 1,
    }[kind];
    const begun = end < lines.length - 1 || !!lines[end]?.trim() || (kind !== "table" && end < lines.length);
    yield { kind, lines: lines.slice(n, end), apart, done: whole || begun };
    [apart, n] = [false, end];
  }
}

/** Code between fences. Until it is `done`, the rows of the line being written are not final: it may yet be a fence. */
function code([, ...lines]: string[], done: boolean, look: number) {
  const closed = fence(lines.at(-1) ?? "");
  const body = closed ? lines.slice(0, -1) : lines;
  const paint = looks(look | mono);
  const rows = body.flatMap((line) => source(line, paint));
  return settle(rows, done, rows.length - (closed || !body.length ? 0 : source(body.at(-1)!, paint).length));
}

/** How each kind of block is shown. A table's rows are final only once it is done, as each may change its widths. */
const shows: Record<Kind, (lines: string[], done: boolean, look: number) => Rendered> = {
  prose: ([line], done, look) => prose(line, done, look),
  code,
  table: (lines, done, look) => settle(table(lines, done, look), done, 0),
};

/** How bee says something: the look of its words, and whether its blocks are set apart by blank lines. */
type Voice = { look: number; apart: boolean };

/** A reply, or a thought, as rows in its voice, and how many are final: those nothing to come can change. */
function render(text: string, whole: boolean, voice: Voice): Rendered {
  const rows: string[] = [];
  let final = 0;
  for (const { kind, lines, apart, done } of blocks(text, whole)) {
    const { rows: shown, final: settled } = shows[kind](lines, done, voice.look);
    if (!shown.length) continue;
    const before = apart && voice.apart && rows.length ? [""] : [];
    if (settled) final = rows.length + before.length + settled;
    rows.push(...before, ...shown);
  }
  return { rows, final };
}

// ── Screen ──────────────────────────────────────────────────────────────────
// The transcript is everything said, each thing shown at the screen's width. Its final rows are printed once, and
// below them the rest is redrawn: what may yet change, what bee is running, what you have queued, and the prompt.
// Bee's work, what it thinks and the code it runs, is shown in brief, a row for each thing, or in full with what the
// code printed. Ctrl-O turns from one to the other. When the screen's width changes, or that, all of it is shown again.

type Option = { id: string; currentValue: string; options: { value: string }[] };

/** Who said a thing shown, or what it is. */
type Said = "user" | "thought" | "reply" | "tool" | "note";

/** A thing in the transcript, as rows at the screen's width. */
type Entry = { said: Said; render: () => Rendered };

let typed = ""; // the prompt
let cursor = 0; // where the cursor is in it
let tabbed = ""; // what you typed, while Tab goes through what fits it
let writing: { said: "thought" | "reply"; text: string; whole: boolean } | undefined; // what bee is thinking or saying
let usage = ""; // how full its context is
let options: Option[] = []; // the session's settings
let prompts = 0; // how many bee has not answered: a turn is under way while there are any
let printed = 0; // how many rows of the transcript are printed
let at = 0; // how many rows the cursor is below the top of what is redrawn
const transcript: Entry[] = [];
let brief = true; // whether bee's work is shown in brief, or in full
const running = new Map<string, string>(); // the code of the calls bee is waiting on
const queued: string[] = []; // waiting for the turn to end
const history: string[] = []; // what you have said, here and in the sessions opened, for Up to recall

const busy = () => prompts > 0;
const up = (rows: number) => (rows ? `\x1b[${rows}A` : "");
const clear = () => "\r" + up(at) + "\x1b[J";

/** Rows, all of them final. */
const final = (rows: string[]): Rendered => ({ rows, final: rows.length });

/** Add to the transcript. Its rows are made again only when how it is shown, or `version`, changes. */
function add(said: Said, make: () => Rendered, version = () => "") {
  let made: { at: string; rendered: Rendered } | undefined;
  const render = () => {
    const at = `${out.columns} ${brief} ${version()}`;
    if (made?.at !== at) made = { at, rendered: make() };
    return made.rendered;
  };
  transcript.push({ said, render });
  draw();
}

/** Whether a thing is bee at work: thinking, or running code. */
const working = (said: Said) => said === "thought" || said === "tool";

/**
 * Things said as rows: of each, its final rows, or all of them. Each is set apart from the one before by a blank row,
 * unless both are bee at work.
 */
function layout(entries: { said: Said; rows: string[] }[]) {
  const rows: string[] = [];
  let last: Said | undefined;
  for (const { said, rows: own } of entries) {
    if (!own.length) continue;
    if (last && !(working(said) && working(last))) rows.push("");
    rows.push(...own);
    last = said;
  }
  return rows;
}

/** What a command is set to, shown beside it as a hint. */
function current(id: string) {
  if (id === "session") return usage && `${usage} of context`;
  return options.find((option) => option.id === id)?.currentValue ?? "";
}

/** Print what of the transcript is final and not printed yet, and redraw the rest. */
function draw() {
  const rendered = transcript.map(({ said, render }) => ({ said, ...render() }));
  const settled = layout(rendered.map(({ said, rows, final }) => ({ said, rows: rows.slice(0, final) })));
  const code = [...running.values()].map((text) => ({ said: "tool" as const, rows: [glance(text, gray)] }));
  const pending = layout([...rendered, ...code]).slice(settled.length);
  const finished = settled.slice(printed);
  printed = settled.length;

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
  // What is redrawn must fit the screen, or what of it went above the screen could not be erased.
  const redrawn = [
    ...pending,
    ...queued.map((text) => dark(mark + text.split("\n")[0].slice(0, room()))),
    "",
    amber(busy() ? turning + " " : mark) + input[0],
    ...input.slice(1).map((row) => pad + row),
    ...shown.map((hint) => {
      const named = hint.match(/^\/(\S+) $/)?.[1]; // a command, which is shown with what it is set to
      const text = (named ? hint.trimEnd().padEnd(widest) + pad + current(named) : hint).slice(from, room()).trimEnd();
      return pad + " ".repeat(from) + (hint === typed ? text : dark(text)); // the one Tab is on is in the prompt
    }),
    ...(more ? [pad + " ".repeat(from) + dark(`${more} more`)] : []),
  ].slice(-(out.rows - 1));
  // One frame: erase what was drawn, draw, and put the cursor where it is in the prompt.
  const column = pad.length + before.at(-1)!.length + 1;
  out.write(`\x1b[?2026h${clear()}${[...finished, ...redrawn].join("\n")}${up(below)}\x1b[${column}G\x1b[?2026l`);
  at = redrawn.length - below - 1;
}

/** Show all of the transcript again, as it is shown now: at another width, or in brief or full, it was not. */
function reflow() {
  out.write("\x1b[H\x1b[2J\x1b[3J"); // the screen, and what scrolled off it, cleared
  [printed, at] = [0, 0];
  draw();
}

/** Bee's voices. A thought is faint, and its paragraphs run together, as it is bee at work. In brief, it is a glance. */
const voices: Record<"thought" | "reply", Voice> = {
  thought: { look: thought, apart: false },
  reply: { look: 0, apart: true },
};

/** A thought or a reply arrives in pieces. Its rows are printed once they are final. */
function stream(said: "thought" | "reply", text: string) {
  if (writing?.said !== said) {
    end();
    const own = (writing = { said, text: "", whole: false });
    const make = () => {
      if (brief && working(said)) return settle([glance(marked(own.text, true).text, faint)], own.whole, 0);
      const { rows, final } = render(own.text, own.whole, voices[said]);
      return { rows: rows.map((row) => row && pad + row), final };
    };
    add(said, make, () => `${own.text.length} ${own.whole}`);
  }
  writing.text += text;
  draw();
}

/** The thought or reply is over, if there was one: all of it is final. */
function end() {
  if (writing) writing.whole = true;
  writing = undefined;
  draw();
}

/** Code bee ran: in brief, a glance at it; in full, all of it, and under it what it printed. */
function ran(code: string, output: string, look: Paint) {
  if (brief) return [glance(code, look)];
  const lines = (text: string, paint: Paint, indent = "") =>
    text.split("\n").flatMap((line) => source(indent + line, paint));
  return [...lines(code.trim(), look), ...lines(output.trimEnd(), dark, pad)].map((row) => row && pad + row);
}

/** What you said. */
function user(text: string) {
  end();
  add("user", () => final(wrap(text).map((row, n) => (n ? pad : dark(mark)) + row)));
}

/** What this terminal has to say for itself. */
function note(text: string, look = dark) {
  end();
  add("note", () => final(wrap(text).map((row) => pad + look(row))));
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
  agent_thought_chunk: ({ content }) => stream("thought", content.text),
  agent_message_chunk: ({ content }) => stream("reply", content.text),
  tool_call: ({ toolCallId, rawInput }) => {
    end();
    running.set(toolCallId, rawInput.command);
    draw();
  },
  tool_call_update: ({ toolCallId, status, rawOutput }) => {
    if (status !== "completed" && status !== "failed") return;
    const code = running.get(toolCallId) ?? "";
    running.delete(toolCallId);
    add("tool", () => final(ran(code, rawOutput ?? "", status === "failed" ? red : gray)));
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
  await commands()
    .find((command) => command.id === id)!
    .pick(value);
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
  "\x0f": () => ((brief = !brief), reflow()), // Ctrl-O: bee's work in full, or in brief
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
out.on("resize", reflow);
setInterval(() => busy() && draw(), frame); // the mark turns while bee works

if (first) queue(first);
else draw();
