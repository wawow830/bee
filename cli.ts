#!/usr/bin/env bun
// Terminal client for bee.ts over ACP stdio.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  amber,
  dark,
  displayWidth,
  graphemes,
  gray,
  hangIndent,
  hardWrap,
  PAD,
  red,
  renderCodeLine,
  renderMarkdown,
  STYLE_THOUGHT,
  wordWrap,
  type Styler,
  type VoiceStyle,
} from "./src/markdown";

// ── CLI Arguments ───────────────────────────────────────────────────────────

const USAGE = `bee            new session
bee -c         continue the latest session here
bee "…"        start with a prompt
`;

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("-") && arg !== "-c");
if (flags.length) {
  const isHelp = flags.every((flag) => flag === "-h" || flag === "--help");
  (isHelp ? process.stdout : process.stderr).write(USAGE);
  process.exit(isHelp ? 0 : 2);
}
const resumeLatest = args.includes("-c");
const initialPrompt = args
  .filter((arg) => arg !== "-c")
  .join(" ")
  .trim();

// ── Transcript & Viewport ───────────────────────────────────────────────────

const out = process.stdout;
const USER_MARK = "› ";
const SHELL_MARK = "$ ";
const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPINNER_MS = 80;
const MAX_HINTS = 8;
const SCROLL_STEP = 3;

const contentWidth = (indent = PAD.length) => out.columns - 1 - indent;

type ConfigOption = { id: string; currentValue: string; options: { value: string }[] };
type EntryKind = "user" | "thought" | "reply" | "tool" | "note";
type TranscriptEntry = { kind: EntryKind; rows: () => string[]; open: boolean };
type LayoutRow = {
  text: string;
  owner?: { entry: TranscriptEntry; lineIndex: number; rows: string[] };
  toggles?: TranscriptEntry;
};
// Width-independent scroll anchor: character offset into a specific entry plus leading blank lines above it.
type ScrollAnchor = { entry: TranscriptEntry; charOffset: number; blankLines: number };
type ToolCallState = { command: string; status: string; output: string };

let inputBuffer = "";
let cursorPos = 0;
let tabPrefix = "";
let streaming: { kind: "thought" | "reply"; text: string; complete: boolean } | undefined;
let usageLabel = "";
let sessionTitle = "";
let configOptions: ConfigOption[] = [];
let inflightPrompts = 0;
let scrollAnchor: ScrollAnchor | undefined;
let laidOutRows: LayoutRow[] = [];
let viewportTop = 0;
let maxScroll = 0;
let visibleRowCount = 0;
let spinnerTimer: Timer | undefined;

const transcript: TranscriptEntry[] = [];
const toolCalls = new Map<string, ToolCallState>();
const userMessagesById = new Map<string, string>();
const forkCursors = new Map<string, string>();
const pendingMessages: string[] = [];
const queuedMessages: string[] = [];
const promptHistory: string[] = [];

const compactNumber = new Intl.NumberFormat("en", { notation: "compact" });
const isBusy = () => inflightPrompts > 0;

function syncSpinner() {
  if (isBusy() && !spinnerTimer) spinnerTimer = setInterval(scheduleRender, SPINNER_MS);
  else if (!isBusy() && spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }
}

function addEntry(kind: EntryKind, buildRows: () => string[], cacheKey = () => "") {
  let cache: { key: string; rows: string[] } | undefined;
  transcript.push({
    kind,
    open: false,
    rows: () => {
      const key = `${out.columns} ${cacheKey()}`;
      if (cache?.key !== key) cache = { key, rows: buildRows() };
      return cache.rows;
    },
  });
  scheduleRender();
}

// Count visible non-whitespace graphemes (invariant across reflows).
const visibleCharCount = (row: string) => [...graphemes.segment(row.replace(/\x1b\[[\d;]*m|\s/g, ""))].length;

function anchorAtRow(rows: LayoutRow[], rowIndex: number): ScrollAnchor | undefined {
  const target = rows.findIndex((row, i) => i >= rowIndex && visibleCharCount(row.text));
  const owner = rows[target]?.owner;
  if (!owner) return;
  const charOffset = owner.rows.slice(0, owner.lineIndex).reduce((sum, row) => sum + visibleCharCount(row), 0);
  return { entry: owner.entry, charOffset, blankLines: target - rowIndex };
}

function resolveAnchor(rows: LayoutRow[], anchor: ScrollAnchor) {
  const firstRowByEntry = new Map<TranscriptEntry, number>();
  rows.forEach(
    (row, i) => row.owner && !firstRowByEntry.has(row.owner.entry) && firstRowByEntry.set(row.owner.entry, i),
  );
  if (!firstRowByEntry.has(anchor.entry)) {
    const fallback = transcript.slice(0, transcript.indexOf(anchor.entry)).findLast((e) => firstRowByEntry.has(e));
    return fallback ? firstRowByEntry.get(fallback)! : 0;
  }
  const startRow = firstRowByEntry.get(anchor.entry)!;
  const entryRows = rows[startRow].owner!.rows;
  let lineIdx = 0;
  let chars = 0;
  while (lineIdx < entryRows.length - 1 && chars + visibleCharCount(entryRows[lineIdx]) <= anchor.charOffset) {
    chars += visibleCharCount(entryRows[lineIdx++]);
  }
  let resolved = startRow + lineIdx;
  if (chars < anchor.charOffset) return resolved;
  for (let up = 0; up < anchor.blankLines && resolved > 0 && !visibleCharCount(rows[resolved - 1].text); up++)
    resolved--;
  return resolved;
}

function scrollTo(rowIndex: number) {
  viewportTop = Math.max(0, Math.min(maxScroll, rowIndex));
  scrollAnchor = viewportTop < maxScroll ? anchorAtRow(laidOutRows, viewportTop) : undefined;
}

function toggleRow(rowIndex: number) {
  const target = laidOutRows[rowIndex]?.toggles;
  const clicked = anchorAtRow(laidOutRows, rowIndex);
  if (!target || !clicked) return;
  target.open = !target.open;
  const rows = layoutTranscript();
  scrollAnchor = anchorAtRow(rows, Math.max(0, resolveAnchor(rows, clicked) - (rowIndex - viewportTop)));
}

function groupIntoTurns() {
  const turns: TranscriptEntry[][] = [];
  for (const entry of transcript) {
    if (!turns.length || entry.kind === "user" || entry.kind === "note") turns.push([]);
    turns.at(-1)!.push(entry);
  }
  return turns;
}

function makeLayoutRows(entry: TranscriptEntry, lines: string[], toggles?: TranscriptEntry): LayoutRow[] {
  return lines.map((text, lineIndex) => ({ text, owner: { entry, lineIndex, rows: lines }, toggles }));
}

// Completed turns fold intermediate work (thinking/tools/narration) behind the user prompt and final answer.
function layoutTranscript() {
  const rows: LayoutRow[] = [];
  const turns = groupIntoTurns();
  turns.forEach((turn, i) => {
    const header = turn[0].kind === "user" || turn[0].kind === "note" ? turn[0] : undefined;
    const body = turn.slice(header ? 1 : 0);
    const answer = body.at(-1)?.kind === "reply" ? body.at(-1) : undefined;
    const work = answer ? body.slice(0, -1) : body;
    const finished = !(isBusy() && i === turns.length - 1);
    const foldToggle = finished && work.length ? header : undefined;
    const folded = Boolean(foldToggle && !foldToggle.open);
    const sections = [
      header ? makeLayoutRows(header, header.rows(), foldToggle) : [],
      folded
        ? []
        : work.flatMap((entry) => makeLayoutRows(entry, entry.open ? entry.rows() : entry.rows().slice(0, 1), entry)),
      answer ? makeLayoutRows(answer, answer.rows(), foldToggle) : [],
    ];
    for (const section of sections) {
      if (section.length && rows.length) rows.push({ text: "" });
      rows.push(...section);
    }
  });
  return rows;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setImmediate(() => {
    renderQueued = false;
    renderFrame();
  });
}

function renderFrame() {
  const width = contentWidth();
  const inputLines = hardWrap(inputBuffer, width);
  const beforeCursor = hardWrap(inputBuffer.slice(0, cursorPos), width);
  const allCommands = slashCommands();
  const parsedCmd = parseSlashCommand(tabPrefix || inputBuffer, allCommands);
  const matches = parsedCmd?.matches ?? [];
  const windowEnd = Math.max(MAX_HINTS, matches.indexOf(inputBuffer) + 1);
  const visibleHints = matches.slice(windowEnd - MAX_HINTS, windowEnd);
  const valueOffset = parsedCmd?.commandId ? parsedCmd.commandId.length + 2 : 0;
  const hiddenCount = matches.length - visibleHints.length;
  const widestHint = Math.max(0, ...visibleHints.map((h) => h.trimEnd().length));
  const rowsBelowCursor = inputLines.length - beforeCursor.length + visibleHints.length + (hiddenCount ? 1 : 0);
  const spinner = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_MS) % SPINNER_FRAMES.length];

  const rows = layoutTranscript();
  const currentValueFor = (hint: string) => allCommands.find((cmd) => `/${cmd.id} ` === hint)!.current;
  const promptLines = [
    amber(isBusy() ? spinner + " " : USER_MARK) + inputLines[0],
    ...inputLines.slice(1).map((line) => PAD + line),
    ...visibleHints.map((hint) => {
      const display = parsedCmd!.commandId ? hint : hint.trimEnd().padEnd(widestHint) + PAD + currentValueFor(hint);
      const clipped = hardWrap(display.slice(valueOffset), contentWidth(PAD.length + valueOffset))[0].trimEnd();
      return PAD + " ".repeat(valueOffset) + (hint === inputBuffer ? clipped : dark(clipped));
    }),
    ...(hiddenCount ? [PAD + " ".repeat(valueOffset) + dark(`${hiddenCount} more`)] : []),
  ];
  const pendingLines = [...pendingMessages, ...queuedMessages]
    .filter(Boolean)
    .map((text) => amber(USER_MARK) + dark(hardWrap(text, width)[0]));
  const footer: string[] = [];
  for (const section of [pendingLines, promptLines]) {
    if (section.length && (rows.length || footer.length)) footer.push("");
    footer.push(...section);
  }

  const transcriptHeight = Math.max(0, out.rows - footer.length);
  laidOutRows = rows;
  maxScroll = Math.max(0, rows.length - transcriptHeight);
  viewportTop = scrollAnchor ? Math.min(resolveAnchor(rows, scrollAnchor), maxScroll) : maxScroll;
  const visible = rows.slice(viewportTop, viewportTop + transcriptHeight).map((r) => r.text);
  visibleRowCount = visible.length;

  const frame = [...visible, ...footer].slice(-out.rows);
  const cursorCol = PAD.length + displayWidth(beforeCursor.at(-1)!) + 1;
  const body = frame.map((row) => row + "\x1b[K").join("\r\n");
  // Synchronized output (DEC mode 2026) avoids flicker during full-frame redraws.
  out.write(`\x1b[?2026h\x1b[H${body}\x1b[J\x1b[${frame.length - rowsBelowCursor};${cursorCol}H\x1b[?2026l`);
}

const VOICES: Record<"thought" | "reply", VoiceStyle> = {
  thought: { style: STYLE_THOUGHT, blankBetweenBlocks: false },
  reply: { style: 0, blankBetweenBlocks: true },
};

function appendStream(kind: "thought" | "reply", delta: string) {
  if (streaming?.kind !== kind) {
    finishStream();
    const active = (streaming = { kind, text: "", complete: false });
    const build = () =>
      renderMarkdown(active.text, contentWidth(), active.complete, VOICES[kind]).map((row) => row && PAD + row);
    addEntry(kind, build, () => `${active.text.length} ${active.complete}`);
  }
  streaming.text += delta;
  scheduleRender();
}

function finishStream() {
  if (streaming) streaming.complete = true;
  streaming = undefined;
  scheduleRender();
}

function renderToolCall({ command, status, output }: ToolCallState) {
  const width = contentWidth();
  const formatLines = (text: string, styler: Styler, indent = "") =>
    text.split("\n").flatMap((line) => renderCodeLine(indent + line, width, styler));
  const renderedOutput = output.trim() ? formatLines(output.trimEnd(), dark, PAD) : [];
  return hangIndent(dark(SHELL_MARK), [
    ...formatLines(command.trim(), status === "failed" ? red : gray),
    ...renderedOutput,
  ]);
}

function appendUserEntry(text: string) {
  promptHistory.push(text);
  finishStream();
  addEntry("user", () => hangIndent(amber(USER_MARK), wordWrap(text, contentWidth())));
}

function appendNote(text: string, styler = dark) {
  finishStream();
  addEntry("note", () => wordWrap(text, contentWidth()).map((row) => PAD + styler(row)));
}

// ── ACP Client ──────────────────────────────────────────────────────────────

type SessionUpdate = {
  content: { text: string };
  messageId: string;
  cursorId: string;
  anchor: { messageId: string };
  toolCallId: string;
  rawInput: { command: string };
  rawOutput: string;
  status: string;
  used: number;
  size: number;
  title: string;
};

const updateHandlers: Record<string, (update: SessionUpdate) => void> = {
  user_message_chunk: ({ content, messageId }) => {
    pendingMessages.shift();
    userMessagesById.set(messageId, content.text);
    appendUserEntry(content.text);
  },
  cursor_update: ({ cursorId, anchor }) => {
    forkCursors.set(cursorId, userMessagesById.get(anchor.messageId)!);
  },
  agent_thought_chunk: ({ content }) => appendStream("thought", content.text),
  agent_message_chunk: ({ content }) => appendStream("reply", content.text),
  tool_call: ({ toolCallId, rawInput }) => {
    finishStream();
    const state: ToolCallState = { command: rawInput.command ?? "", status: "", output: "" };
    toolCalls.set(toolCallId, state);
    addEntry(
      "tool",
      () => renderToolCall(state),
      () => state.status,
    );
  },
  tool_call_update: ({ toolCallId, status, rawOutput }) => {
    const state = toolCalls.get(toolCallId);
    if (!state || (status !== "completed" && status !== "failed")) return;
    Object.assign(state, { status, output: rawOutput ?? "" });
    scheduleRender();
  },
  usage_update: ({ used, size }) => {
    usageLabel = `${compactNumber.format(used)}/${compactNumber.format(size)}`;
    scheduleRender();
  },
  session_info_update: ({ title }) => {
    sessionTitle = title;
    scheduleRender();
  },
};

const agentProc = spawn(process.execPath, [join(import.meta.dir, "bee.ts")], { stdio: ["pipe", "pipe", "ignore"] });
const rpcPending = new Map<number, PromiseWithResolvers<any>>();
let nextRpcId = 0;

const sendRpc = (payload: object) => agentProc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");

function rpcCall(method: string, params: object): Promise<any> {
  const deferred = Promise.withResolvers<any>();
  rpcPending.set(++nextRpcId, deferred);
  sendRpc({ id: nextRpcId, method, params });
  return deferred.promise;
}

createInterface({ input: agentProc.stdout! }).on("line", (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  if (method) return updateHandlers[params.update?.sessionUpdate]?.(params.update);
  const deferred = rpcPending.get(id);
  rpcPending.delete(id);
  if (error) deferred?.reject(new Error(error.message));
  else deferred?.resolve(result);
});
agentProc.on("exit", (code) => quit(code ?? 1));

function quit(code = 0, message = ""): never {
  const finalTranscript = layoutTranscript()
    .map((row) => row.text + "\n")
    .join("");
  // Disable mouse tracking, bracketed paste, and alt-screen, then dump the transcript to the main buffer.
  out.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?1049l" + finalTranscript + message);
  process.exit(code);
}

// ── Session Management ──────────────────────────────────────────────────────

type SessionSummary = { sessionId: string; title?: string };

const cwd = process.cwd();
let sessionId = "";
let localSessions: SessionSummary[] = [];
let sendChain: Promise<unknown> = Promise.resolve();

const listSessions = async (): Promise<SessionSummary[]> => (await rpcCall("session/list", { cwd })).sessions;
const cancelTurn = () => sendRpc({ method: "session/cancel", params: { sessionId } });

async function openSession(id?: string) {
  [usageLabel, sessionTitle, scrollAnchor, historyIndex] = ["", "", undefined, 0];
  for (const list of [transcript, promptHistory]) list.length = 0;
  for (const map of [toolCalls, userMessagesById, forkCursors, historyDrafts]) map.clear();
  const opened = await rpcCall(id ? "session/load" : "session/new", { sessionId: id, cwd, mcpServers: [] });
  sessionId = id ?? opened.sessionId;
  configOptions = opened.configOptions;
  listSessions().then(
    (list) => (localSessions = list),
    (error) => appendNote(error.message, red),
  );
}

async function forkFromCursor(cursorId: string, text: string) {
  const forked = await rpcCall("session/fork", { sessionId, cursorId, cwd, mcpServers: [] });
  await openSession(forked.sessionId);
  spliceInput(0, inputBuffer.length, [text, inputBuffer].filter(Boolean).join("\n\n"));
}

async function sendPrompt(text: string) {
  if (text) pendingMessages.push(text);
  inflightPrompts++;
  syncSpinner();
  const onDone = () => {
    if (!--inflightPrompts) finishStream();
    syncSpinner();
  };
  await rpcCall("session/prompt", { sessionId, prompt: [{ type: "text", text }] }).finally(onDone);
}

function enqueue(text: string, runCommand?: () => Promise<unknown>) {
  queuedMessages.push(text);
  const step = async () => {
    queuedMessages.shift();
    if (!runCommand) return sendPrompt(text);
    appendNote(text);
    await runCommand();
    scheduleRender();
  };
  sendChain = sendChain.then(step).catch((error) => appendNote(error.message, red));
}

// ── Slash Commands ──────────────────────────────────────────────────────────

type SlashCommand = { id: string; current: string; values: Map<string, () => Promise<unknown>> };

function uniqueEntries(pairs: [string, () => Promise<unknown>][]) {
  const map = new Map<string, () => Promise<unknown>>();
  for (const [name, action] of pairs) if (name && !map.has(name)) map.set(name, action);
  return map;
}

function slashCommands(): SlashCommand[] {
  const configCmds = configOptions.map((option) => ({
    id: option.id,
    current: option.currentValue,
    values: uniqueEntries(
      option.options.map(({ value }) => [
        value,
        async () => {
          const res = await rpcCall("session/set_config_option", { sessionId, configId: option.id, value });
          configOptions = res.configOptions;
        },
      ]),
    ),
  }));
  const sessionCmd: SlashCommand = {
    id: "session",
    current: [usageLabel, sessionTitle && `"${sessionTitle}"`, sessionId].filter(Boolean).join(" "),
    values: uniqueEntries([
      ["new", () => openSession()],
      ...localSessions
        .filter((s) => s.sessionId !== sessionId)
        .map((s): [string, () => Promise<void>] => [s.title ?? "", () => openSession(s.sessionId)]),
    ]),
  };
  const forkCmd: SlashCommand = {
    id: "fork",
    current: "",
    values: uniqueEntries(
      [...forkCursors]
        .reverse()
        .map(([cursorId, text]): [string, () => Promise<void>] => [
          text.trim().split("\n")[0],
          () => forkFromCursor(cursorId, text),
        ]),
    ),
  };
  return [...configCmds, sessionCmd, forkCmd];
}

const MATCHERS = [
  (value: string, query: string) => value === query,
  (value: string, query: string) => value.endsWith("/" + query),
  (value: string, query: string) => value.includes(query),
];

function parseSlashCommand(
  text: string,
  allCommands = slashCommands(),
): { matches: string[]; commandId?: string; execute?: () => Promise<unknown> } | undefined {
  const [, id, argText] = text.match(/^\/(\S*)(?:\s+(.*))?$/s) ?? [];
  if (id === undefined) return;
  if (argText === undefined) {
    const matches = allCommands.flatMap((cmd) => (cmd.id.startsWith(id) ? [`/${cmd.id} `] : []));
    return matches.length ? { matches } : undefined;
  }
  const cmd = allCommands.find((c) => c.id === id);
  if (!cmd) return;
  const query = argText.trim().toLowerCase();
  const keys = [...cmd.values.keys()];
  const matched = MATCHERS.map((fn) => keys.filter((k) => fn(k.toLowerCase(), query))).find((list) => list.length);
  const matches = (matched ?? []).map((value) => `/${id} ${value}`);
  return { matches, commandId: id, execute: matched?.length === 1 ? cmd.values.get(matched[0]) : undefined };
}

// ── Keyboard & Mouse Input ──────────────────────────────────────────────────

let historyIndex = 0;
const historyDrafts = new Map<number, string>();
let bracketedPaste = false;
let lastEscMs = 0;

function spliceInput(from: number, to: number, insertion = "") {
  inputBuffer = inputBuffer.slice(0, from) + insertion + inputBuffer.slice(to);
  cursorPos = from + insertion.length;
}

const moveCursor = (pos: number) => (cursorPos = Math.max(0, Math.min(inputBuffer.length, pos)));

function stepGrapheme(delta: number) {
  const boundaries = [...graphemes.segment(inputBuffer)].map((s) => s.index).concat(inputBuffer.length);
  const current = boundaries.findLastIndex((b) => b <= cursorPos);
  return boundaries[Math.max(0, Math.min(boundaries.length - 1, current + delta))];
}

function stepHistory(delta: number) {
  historyDrafts.set(historyIndex, inputBuffer);
  historyIndex = Math.max(0, Math.min(promptHistory.length, historyIndex + delta));
  spliceInput(0, inputBuffer.length, historyDrafts.get(historyIndex) ?? promptHistory.at(-historyIndex));
}

function handleTab() {
  const matches = parseSlashCommand(tabPrefix || inputBuffer)?.matches ?? [];
  if (matches.length > 1) tabPrefix ||= inputBuffer;
  if (matches.length) spliceInput(0, inputBuffer.length, matches[(matches.indexOf(inputBuffer) + 1) % matches.length]);
}

function handleSubmit(queueForLater = false) {
  const text = inputBuffer.trim();
  const cmd = parseSlashCommand(inputBuffer);
  if (cmd && !cmd.execute) return;
  historyIndex = 0;
  historyDrafts.clear();
  scrollAnchor = undefined;
  spliceInput(0, inputBuffer.length);
  if (cmd) return enqueue(cmd.matches[0], cmd.execute);
  if (queueForLater || !isBusy()) return enqueue(text);
  sendPrompt(text).catch((error) => appendNote(error.message, red));
}

function handleEsc() {
  if (isBusy()) return cancelTurn();
  if (inputBuffer) return;
  const isDoubleEsc = Date.now() - lastEscMs < 500;
  lastEscMs = isDoubleEsc ? 0 : Date.now();
  if (isDoubleEsc) spliceInput(0, 0, "/fork ");
}

const CLIPBOARD_IMAGE_CMDS = [
  ["wl-paste", "--type", "image/png"],
  ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
];

function pasteClipboardImage() {
  for (const [bin, ...cmdArgs] of CLIPBOARD_IMAGE_CMDS) {
    const { status, stdout } = spawnSync(bin, cmdArgs);
    if (status !== 0 || !stdout.length) continue;
    const hash = createHash("sha256").update(stdout).digest("hex").slice(0, 12);
    const path = join(tmpdir(), `bee-${hash}.png`);
    writeFileSync(path, stdout);
    const spacer = /\S$/.test(inputBuffer.slice(0, cursorPos)) ? " " : "";
    return spliceInput(cursorPos, cursorPos, spacer + path);
  }
  appendNote("No image is copied.");
}

const KEY_BINDINGS: Record<string, () => unknown> = {
  "\r": () => handleSubmit(),
  "\x1b\r": () => handleSubmit(true), // Alt-Enter: queue after current turn
  "\n": () => spliceInput(cursorPos, cursorPos, "\n"), // Ctrl-J
  "\t": () => handleTab(),
  "\x7f": () => spliceInput(stepGrapheme(-1), cursorPos), // Backspace
  "\x1b[3~": () => spliceInput(cursorPos, stepGrapheme(1)), // Delete
  "\x17": () => spliceInput(inputBuffer.slice(0, cursorPos).search(/\S*\s*$/), cursorPos), // Ctrl-W
  "\x15": () => spliceInput(0, cursorPos), // Ctrl-U
  "\x16": () => pasteClipboardImage(), // Ctrl-V
  "\x01": () => moveCursor(0), // Ctrl-A
  "\x1b[H": () => moveCursor(0),
  "\x1b[1~": () => moveCursor(0),
  "\x05": () => moveCursor(inputBuffer.length), // Ctrl-E
  "\x1b[F": () => moveCursor(inputBuffer.length),
  "\x1b[4~": () => moveCursor(inputBuffer.length),
  "\x1b[D": () => moveCursor(stepGrapheme(-1)),
  "\x1b[C": () => moveCursor(stepGrapheme(1)),
  "\x1b[A": () => stepHistory(1),
  "\x1b[B": () => stepHistory(-1),
  "\x1b": () => handleEsc(),
  "\x03": () => (inputBuffer ? spliceInput(0, inputBuffer.length) : isBusy() ? cancelTurn() : quit()),
};

const MOUSE_BUTTONS: Record<number, (row: number) => unknown> = {
  0: (row) => row <= visibleRowCount && toggleRow(viewportTop + row - 1),
  64: () => scrollTo(viewportTop - SCROLL_STEP),
  65: () => scrollTo(viewportTop + SCROLL_STEP),
};

function handleInput(chunk: string) {
  for (const [token] of chunk.matchAll(/\x1b\[<[\d;]*[Mm]|\x1b\[[\d;]*[^\d;]|\x1b[^\x1b]|[^]/g)) {
    if (token !== "\t") tabPrefix = "";
    if (token !== "\x1b") lastEscMs = 0;
    const mouse = token.match(/^\x1b\[<(\d+);\d+;(\d+)([Mm])$/);
    if (mouse) mouse[3] === "M" && MOUSE_BUTTONS[+mouse[1]]?.(+mouse[2]);
    else if (/^\x1b\[20[01]~$/.test(token)) bracketedPaste = token === "\x1b[200~";
    else if (bracketedPaste) spliceInput(cursorPos, cursorPos, token === "\r" ? "\n" : token);
    else if (KEY_BINDINGS[token]) KEY_BINDINGS[token]();
    else if (token >= " ") spliceInput(cursorPos, cursorPos, token);
  }
  scheduleRender();
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

// Enter alternate screen, enable bracketed paste, and enable SGR mouse reporting.
out.write("\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h");
process.stdin.setRawMode(true).setEncoding("utf8").on("data", handleInput);
out.on("resize", scheduleRender);
renderFrame();

// The prompt is up before bee is: what is sent waits for the session to open.
async function begin() {
  await rpcCall("initialize", { protocolVersion: 1, clientCapabilities: { session: { cursors: {} } } });
  const latest = resumeLatest ? (await listSessions())[0] : undefined;
  await openSession(latest?.sessionId);
}
sendChain = begin().catch((error) => quit(1, error.message + "\n"));
enqueue(initialPrompt);
