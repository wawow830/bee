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
// Each colour means one thing. Amber is you: the mark before all you say, and where you type. Words are in the
// terminal's own colour, code in gray, and red is what failed. All else is dark: marks, hints, what is waiting, and
// what this terminal says for itself. What bee thinks is as what it says, only faint and italic.

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
const scrolled = 3; // how many rows a turn of the wheel scrolls

/** How wide a row can be after `indent` columns. The last column stays free. */
const room = (indent = pad.length) => out.columns - 1 - indent;

/** Text as rows: each of its lines, cut wherever `row` matches. */
const cut = (text: string, row: string) => text.split("\n").flatMap((line) => line.match(new RegExp(row, "g")) ?? [""]);

/** Rows no wider than `size`, broken after a space where there is one. Each keeps the spaces it was broken at. */
const fill = (text: string, size: number) => cut(text, `.{1,${size}}(?=\\s|$)\\s*|.{1,${size}}`);

/** Rows no wider than `size`, broken at a space where there is one. */
const wrap = (text: string, size = room()) => fill(text, size).map((row) => row.trimEnd());

// ── Markdown ────────────────────────────────────────────────────────────────
// A reply is shown as it looks. It is read as blocks: a line of prose, code between fences, or a table. Blank lines
// between blocks are one blank row, and there are none before or after them.

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

/** Text with its marks taken out, and the look of each character. */
type Marked = { text: string; each: number[] };

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
  const result: Marked = { text: "", each: [] };
  parts.forEach((part, n) => {
    const plain = unclosed.has(n) && whole; // this mark is only characters
    if (part === "`" && !plain) look ^= mono;
    else if (part === "**" && !(look & mono) && !plain) look ^= strong;
    else for (const character of part) ((result.text += character), result.each.push(look));
  });
  return result;
}

/** Marked text as rows no wider than `size`, each part of a row in its look. */
function paint({ text, each }: Marked, size: number) {
  let from = 0; // where in `text` the row begins
  return fill(text, size).map((row) => {
    const kept = row.trimEnd();
    let painted = "";
    for (let start = 0, end = 1; start < kept.length; end++) {
      if (end < kept.length && each[from + end] === each[from + start]) continue;
      painted += looks(each[from + start])(kept.slice(start, end));
      start = end;
    }
    from += row.length;
    return painted;
  });
}

/** Rows after `lead`: the first begins with it, and the rest under where the first's text begins. */
const hang = (lead: string, rows: string[]) => rows.map((row, n) => (n ? " ".repeat(width(lead)) : lead) + row);

/**
 * A line of prose, in the `look` of what it is part of. A heading is bold, and a list item's rows hang under its text.
 */
function prose(line: string, done: boolean, look: number) {
  const heading = line.match(/^#{1,6}\s+(.*)/);
  const [, indent = "", item = "", body = line] = heading ? [] : (line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/) ?? []);
  const lead = item && indent + (/\d/.test(item) ? item : "•") + " ";
  const text = marked(heading?.[1] ?? body, done, heading ? look | strong : look);
  return hang(looks(look)(dark(lead)), paint(text, room(pad.length + lead.length)));
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
    const painted = row.map((cell, n) => paint(cell, widths[n]));
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

/** Code between fences. */
function code([, ...lines]: string[], look: number) {
  const body = fence(lines.at(-1) ?? "") ? lines.slice(0, -1) : lines;
  return body.flatMap((line) => source(line, looks(look | mono)));
}

/** How each kind of block is shown. */
const shows: Record<Kind, (lines: string[], done: boolean, look: number) => string[]> = {
  prose: ([line], done, look) => prose(line, done, look),
  code: (lines, _done, look) => code(lines, look),
  table,
};

/** How bee says something: the look of its words, and whether its blocks are set apart by blank lines. */
type Voice = { look: number; apart: boolean };

/** A reply, or a thought, as rows in its voice. */
function render(text: string, whole: boolean, voice: Voice) {
  const rows: string[] = [];
  for (const { kind, lines, apart, done } of blocks(text, whole)) {
    const shown = shows[kind](lines, done, voice.look);
    if (shown.length && apart && voice.apart && rows.length) rows.push("");
    rows.push(...shown);
  }
  return rows;
}

// ── Screen ──────────────────────────────────────────────────────────────────
// The screen is bee's own: the transcript, and under it what you have queued and the prompt. The transcript is turns,
// each what you said and what came of it. Its answer is the last thing bee said, if nothing came after it, and is
// shown whole as it comes. Before it is the work: what bee thought and ran, and what it said on the way. While bee
// works, the work is shown, each thing as its first row, and clicking it shows all of it: the whole thought, or the
// whole command and what it printed. Once the turn is over, ended or stopped, the work folds away behind what you said,
// and clicking what you said or the answer unfolds it. The wheel scrolls, and at the bottom the transcript follows
// what comes. Where you have scrolled to is a place in what was said, not a row, so it stays put as the screen's width
// changes and things fold and open. On leaving, the transcript is left in the terminal as it was last shown.

type Option = { id: string; currentValue: string; options: { value: string }[] };

/** Who said a thing shown, or what it is. */
type Said = "user" | "thought" | "reply" | "tool" | "note";

/** A thing in the transcript: its rows at the screen's width, and whether it is open. */
type Entry = { said: Said; rows: () => string[]; open: boolean };

/** A row of the transcript: which of the rows shown of which entry it is, and what clicking it opens or shuts. */
type Row = { text: string; of?: { entry: Entry; n: number; rows: string[] }; opens?: Entry };

/**
 * A place in the transcript, whatever the screen's width: the first character at or after it, as its entry and how
 * many characters of the entry come before it, and how many rows with none come first.
 */
type Place = { entry: Entry; before: number; blank: number };

/** A command bee ran: its code, how it ended, and what it printed. */
type Call = { code: string; status: string; output: string };

let typed = ""; // the prompt
let cursor = 0; // where the cursor is in it
let tabbed = ""; // what you typed, while Tab goes through what fits it
let writing: { said: "thought" | "reply"; text: string; whole: boolean } | undefined; // what bee is thinking or saying
let usage = ""; // how full its context is
let options: Option[] = []; // the session's settings
let prompts = 0; // how many bee has not answered: a turn is under way while there are any
let top: Place | undefined; // where the screen begins, once you have scrolled; else it follows the transcript
let laid: Row[] = []; // the transcript as rows, as last drawn
let at = 0; // the first of them on screen
let bottom = 0; // the first on screen at the bottom
let shown = 0; // how many are on screen
const transcript: Entry[] = [];
const ran = new Map<string, Call>(); // what bee ran, by the id of its call
const queued: string[] = []; // waiting for the turn to end
const history: string[] = []; // what you have said, here and in the sessions opened, for Up to recall

const busy = () => prompts > 0;

/** Add to the transcript. Its rows are made again only when the screen's width, or `version`, changes. */
function add(said: Said, make: () => string[], version = () => "") {
  let made: { at: string; rows: string[] } | undefined;
  const entry: Entry = {
    said,
    open: false,
    rows: () => {
      const at = `${out.columns} ${version()}`;
      if (made?.at !== at) made = { at, rows: make() };
      return made.rows;
    },
  };
  transcript.push(entry);
  draw();
}

/** How many characters a row shows, but for spaces and looks: as many, however wide the screen. */
const characters = (row: string) => row.replace(/\x1b\[[\d;]*m|\s/g, "").length;

/** Where row `n` of `rows` is. After the last row with characters, there is no place: the transcript is followed. */
function place(rows: Row[], n: number): Place | undefined {
  const next = rows.findIndex((row, m) => m >= n && characters(row.text));
  const of = rows[next]?.of;
  if (!of) return;
  const before = of.rows.slice(0, of.n).reduce((sum, row) => sum + characters(row), 0);
  return { entry: of.entry, before, blank: next - n };
}

/** Which of `rows` is at `place`. If its entry is not shown, it is the first row of the nearest shown before it. */
function find(rows: Row[], { entry, before, blank }: Place) {
  const firsts = new Map<Entry, number>(); // where each entry shown begins
  rows.forEach((row, n) => row.of && !firsts.has(row.of.entry) && firsts.set(row.of.entry, n));
  if (!firsts.has(entry)) {
    const shut = transcript.slice(0, transcript.indexOf(entry)).findLast((each) => firsts.has(each));
    return shut ? firsts.get(shut)! : 0;
  }
  const first = firsts.get(entry)!;
  const own = rows[first].of!.rows;
  let [n, sum] = [0, 0]; // the row the character is in, and how many come before it
  while (n < own.length - 1 && sum + characters(own[n]) <= before) sum += characters(own[n++]);
  n += first;
  if (sum < before) return n; // the character is within the row
  for (let up = 0; up < blank && n > 0 && !characters(rows[n - 1].text); up++) n--;
  return n;
}

/** Show the transcript from row `to`. At the bottom, it is followed. */
function scroll(to: number) {
  at = Math.max(0, Math.min(bottom, to)); // so the next turn of the wheel goes on from here, before the screen is drawn
  top = at < bottom ? place(laid, at) : undefined;
}

/** Open or shut what row `n` opens. The row stays where it is on screen. */
function toggle(n: number) {
  const entry = laid[n]?.opens;
  const clicked = place(laid, n);
  if (!entry || !clicked) return;
  entry.open = !entry.open;
  const rows = layout();
  top = place(rows, Math.max(0, find(rows, clicked) - (n - at)));
}

/** The transcript in turns. Each begins with what you said, or with what this terminal said. */
function turns() {
  const all: Entry[][] = [];
  for (const entry of transcript) {
    if (!all.length || entry.said === "user" || entry.said === "note") all.push([]);
    all.at(-1)!.push(entry);
  }
  return all;
}

/** The rows shown of `entry`, which, clicked, open `opens` if it is shut, or else shut it. */
function clicked(entry: Entry, texts: string[], opens?: Entry): Row[] {
  return texts.map((text, n) => ({ text, of: { entry, n, rows: texts }, opens }));
}

/**
 * The transcript as rows. A turn's answer is the last thing in it, if bee said it. Its work, all between what began
 * the turn and the answer, is shown while the turn is under way, or once what began the turn is open. In the work, a
 * thing shut is its first row. Each part of a turn is set apart from the one before by a blank row, and so is each
 * turn.
 */
function layout() {
  const rows: Row[] = [];
  const all = turns();
  all.forEach((turn, n) => {
    const head = turn[0].said === "user" || turn[0].said === "note" ? turn[0] : undefined;
    const after = turn.slice(head ? 1 : 0);
    const answer = after.at(-1)?.said === "reply" ? after.at(-1) : undefined;
    const work = answer ? after.slice(0, -1) : after;
    const over = !(busy() && n === all.length - 1);
    const folds = over && work.length ? head : undefined; // what you said opens the turn, once it has work to fold
    const shut = folds && !folds.open;
    const parts = [
      head ? clicked(head, head.rows(), folds) : [],
      shut ? [] : work.flatMap((entry) => clicked(entry, entry.open ? entry.rows() : entry.rows().slice(0, 1), entry)),
      answer ? clicked(answer, answer.rows(), folds) : [],
    ];
    for (const own of parts) {
      if (own.length && rows.length) rows.push({ text: "" });
      rows.push(...own);
    }
  });
  return rows;
}

/** What a command is set to, shown beside it as a hint. */
function current(id: string) {
  if (id === "session") return usage && `${usage} of context`;
  return options.find((option) => option.id === id)?.currentValue ?? "";
}

/** Draw the screen: as much of the transcript as fits, and under it what is queued and the prompt. */
function draw() {
  const size = room();
  const chop = (text: string) => cut(text, `.{1,${size}}`);
  const input = chop(typed);
  const before = chop(typed.slice(0, cursor)); // the cursor is at the end of these rows
  const command = read(tabbed || typed);
  const fits = command?.fits ?? [];
  const last = Math.max(choices, fits.indexOf(typed) + 1); // the hints shown end at the one Tab is on
  const listed = fits.slice(last - choices, last);
  const from = command?.of ? command.of.length + 2 : 0; // values are shown from where they differ
  const more = fits.length - listed.length;
  const widest = Math.max(...listed.map((hint) => hint.trimEnd().length));
  const below = input.length - before.length + listed.length + (more ? 1 : 0);
  const turning = spinner[Math.floor(Date.now() / frame) % spinner.length];
  const rows = layout();
  const prompt = [
    ...queued.map((text) => amber(mark) + dark(text.split("\n")[0].slice(0, room()))),
    ...(rows.length || queued.length ? [""] : []),
    amber(busy() ? turning + " " : mark) + input[0],
    ...input.slice(1).map((row) => pad + row),
    ...listed.map((hint) => {
      // A value is shown as it is, and a command with what it is set to.
      const set = command!.of ? hint : hint.trimEnd().padEnd(widest) + pad + current(hint.slice(1, -1));
      const text = set.slice(from, room()).trimEnd();
      return pad + " ".repeat(from) + (hint === typed ? text : dark(text)); // the one Tab is on is in the prompt
    }),
    ...(more ? [pad + " ".repeat(from) + dark(`${more} more`)] : []),
  ];
  const height = Math.max(0, out.rows - prompt.length);
  laid = rows;
  bottom = Math.max(0, rows.length - height);
  at = top ? Math.min(find(rows, top), bottom) : bottom;
  const visible = rows.slice(at, at + height).map((row) => row.text);
  shown = visible.length;
  const screen = [...visible, ...prompt].slice(-out.rows);
  // One frame: each row drawn over the one before, and the cursor put where it is in the prompt.
  const column = pad.length + before.at(-1)!.length + 1;
  const drawn = screen.map((row) => row + "\x1b[K").join("\r\n");
  out.write(`\x1b[?2026h\x1b[H${drawn}\x1b[J\x1b[${screen.length - below};${column}H\x1b[?2026l`);
}

/** Bee's voices. A thought is faint, and its paragraphs run together. */
const voices: Record<"thought" | "reply", Voice> = {
  thought: { look: thought, apart: false },
  reply: { look: 0, apart: true },
};

/** A thought or a reply arrives in pieces. */
function stream(said: "thought" | "reply", text: string) {
  if (writing?.said !== said) {
    end();
    const own = (writing = { said, text: "", whole: false });
    const make = () => render(own.text, own.whole, voices[said]).map((row) => row && pad + row);
    add(said, make, () => `${own.text.length} ${own.whole}`);
  }
  writing.text += text;
  draw();
}

/** The thought or reply is over, if there was one. */
function end() {
  if (writing) writing.whole = true;
  writing = undefined;
  draw();
}

/** Code bee ran, and under it what the code printed. */
function shell({ code, status, output }: Call) {
  const lines = (text: string, paint: Paint, indent = "") =>
    text.split("\n").flatMap((line) => source(indent + line, paint));
  const printed = output.trim() ? lines(output.trimEnd(), dark, pad) : [];
  return [...lines(code.trim(), status === "failed" ? red : gray), ...printed].map((row) => row && pad + row);
}

/** What you said. */
function user(text: string) {
  end();
  add("user", () => wrap(text).map((row, n) => (n ? pad : amber(mark)) + row));
}

/** What this terminal has to say for itself. */
function note(text: string, look = dark) {
  end();
  add("note", () => wrap(text).map((row) => pad + look(row)));
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
    const call: Call = { code: rawInput.command ?? "", status: "", output: "" };
    ran.set(toolCallId, call);
    const shown = () => shell(call);
    add("tool", shown, () => call.status);
  },
  tool_call_update: ({ toolCallId, status, rawOutput }) => {
    const call = ran.get(toolCallId);
    if (!call || (status !== "completed" && status !== "failed")) return;
    Object.assign(call, { status, output: rawOutput ?? "" });
    draw();
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
  const left = layout().map((row) => row.text + "\n"); // the transcript, as it was last shown
  out.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?1049l" + left.join("") + message); // as it was when bee began
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

/** Wait for the turn to end, and for what was queued before; then say `text`, or, for a command, `pick` its value. */
function queue(text: string, pick?: () => Promise<unknown>) {
  queued.push(text);
  const next = async () => {
    queued.shift();
    if (!pick) return prompt(text);
    user(text);
    await pick();
    draw();
  };
  last = last.then(next).catch((error) => note(error.message, red));
}

// ── Commands ────────────────────────────────────────────────────────────────
// `/model`, `/thinking` and `/session` each take one of their values. The prompt is a command while it is `/` and the
// start of a command's id, or a command's id and words; anything else, such as a path, is a prompt. The values that fit
// the words are those of the best kind of fit there is: the value, the value after its provider, or a part of it. What
// fits is shown under the prompt. Tab goes through it, and Enter sends the command once only one fits.

/** A command: each of its values, and what picking it does. */
type Command = { id: string; values: Map<string, () => Promise<unknown>> };

/** Values by name. A name already given, or none, names nothing more. */
function named(values: [string, () => Promise<unknown>][]) {
  const map = new Map<string, () => Promise<unknown>>();
  for (const [name, pick] of values) if (name && !map.has(name)) map.set(name, pick);
  return map;
}

const title = (session: Session) => session.title!.trim().split("\n")[0];

/** Each command. A session is named by its title, so of those alike the latest; and `new` is always a new one. */
function commands(): Command[] {
  const settings = options.map((option) => ({
    id: option.id,
    values: named(
      option.options.map(({ value }) => [
        value,
        async () => {
          options = (await call("session/set_config_option", { sessionId, configId: option.id, value })).configOptions;
        },
      ]),
    ),
  }));
  const session = {
    id: "session",
    values: named([
      ["new", () => open()],
      ...others.map((other): [string, () => Promise<void>] => [title(other), () => open(other.sessionId)]),
    ]),
  };
  return [...settings, session];
}

/** The kinds of fit a value can be for the words typed, best first. */
const fitting = [
  (value: string, words: string) => value === words,
  (value: string, words: string) => value.endsWith("/" + words),
  (value: string, words: string) => value.includes(words),
];

/**
 * The prompt as a command, or nothing if it is not one: what it could become, the command whose values those are, if
 * they are values, and what picking it does once only one fits.
 */
function read(text: string): { fits: string[]; of?: string; pick?: () => Promise<unknown> } | undefined {
  const [, id, words] = text.match(/^\/(\S*)(?:\s+(.*))?$/s) ?? [];
  if (id === undefined) return;
  if (words === undefined) {
    const fits = commands().flatMap((command) => (command.id.startsWith(id) ? [`/${command.id} `] : []));
    return fits.length ? { fits } : undefined;
  }
  const command = commands().find((command) => command.id === id);
  if (!command) return;
  const wanted = words.trim().toLowerCase();
  const values = [...command.values.keys()];
  const found = fitting
    .map((fits) => values.filter((value) => fits(value.toLowerCase(), wanted)))
    .find((some) => some.length);
  const fits = (found ?? []).map((value) => `/${id} ${value}`);
  return { fits, of: id, pick: found?.length === 1 ? command.values.get(found[0]) : undefined };
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
  const fits = read(tabbed || typed)?.fits ?? [];
  if (fits.length > 1) tabbed ||= typed; // with only one, the next Tab goes on from it
  if (fits.length) splice(0, typed.length, fits[(fits.indexOf(typed) + 1) % fits.length]);
}

/** Send what is typed: into the turn under way, unless you `wait`, or it is a command. */
function enter(wait = false) {
  const text = typed.trim();
  const command = read(typed);
  if (!text || (command && !command.pick)) return; // a command, but not one value yet
  history.push(text);
  back = 0;
  top = undefined; // the transcript follows again
  splice(0, typed.length);
  if (command) return queue(command.fits[0], command.pick);
  if (wait || !busy()) return queue(text);
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

/** What a press of the mouse does, by its button, at a row on screen. */
const buttons: Record<number, (row: number) => unknown> = {
  0: (row) => row <= shown && toggle(at + row - 1), // the left button: what the row opens or shuts
  64: () => scroll(at - scrolled), // the wheel, up
  65: () => scroll(at + scrolled), // the wheel, down
};

/** Take what the terminal sends, a key or a press of the mouse at a time. */
function press(data: string) {
  for (const [key] of data.matchAll(/\x1b\[<[\d;]*[Mm]|\x1b\[[\d;]*[^\d;]|\x1b[^]|[^]/g)) {
    if (key !== "\t") tabbed = "";
    const mouse = key.match(/^\x1b\[<(\d+);\d+;(\d+)([Mm])$/);
    if (mouse) mouse[3] === "M" && buttons[+mouse[1]]?.(+mouse[2]);
    else if (/^\x1b\[20[01]~$/.test(key)) pasting = key === "\x1b[200~";
    else if (pasting) splice(cursor, cursor, key === "\r" ? "\n" : key);
    else if (keys[key]) keys[key]();
    else if (key >= " ") splice(cursor, cursor, key);
  }
  draw();
}

// ── Start ───────────────────────────────────────────────────────────────────

// A screen of bee's own, the marks a terminal puts around a paste, and where the mouse is pressed.
out.write("\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h");
const fatal = (error: Error) => quit(1, error.message + "\n");
await call("initialize", { protocolVersion: 1, clientCapabilities: {} }).catch(fatal);
const latest = resume ? (await sessions().catch(fatal)).find((session) => session.title) : undefined;
await open(latest?.sessionId).catch(fatal);

process.stdin.setRawMode(true).setEncoding("utf8").on("data", press);
out.on("resize", draw);
setInterval(() => busy() && draw(), frame); // the mark turns while bee works

splice(0, 0, first);
enter(); // one you start with is sent as one you type, unless it is a command not yet whole
draw();
