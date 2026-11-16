// bee in a terminal. An editor like any other: it starts bee.ts and speaks ACP to it.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  Box,
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { version } from "./package.json";

// ── Look ────────────────────────────────────────────────────────────────────

const style = (on: string | number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
const [bold, italic, gray, red, cyan] = [style(1, 22), style(3, 23), style(90, 39), style(31, 39), style(36, 39)];
const shade = (rgb: string) => style(`48;2;${rgb}`, 49);
const shades: Record<string, (text: string) => string> = {
  user: shade("52;52;60"),
  pending: shade("40;40;50"),
  completed: shade("40;50;40"),
  failed: shade("60;40;40"),
};
const list = { selectedPrefix: cyan, selectedText: cyan, description: gray, scrollInfo: gray, noMatch: gray };
const plain = (text: string) => text;
const markdown = {
  heading: (text: string) => bold(cyan(text)),
  ...{ link: cyan, linkUrl: gray, code: cyan, codeBlock: plain, codeBlockBorder: gray, listBullet: cyan, hr: gray },
  ...{ quote: italic, quoteBorder: gray, bold, italic, strikethrough: style(9, 29), underline: style(4, 24) },
};

/** The end of long output. The model sees all of it. */
function tail(text: string, keep = 10) {
  const lines = text.trimEnd().split("\n").map((line) => (line.length > 300 ? line.slice(0, 300) + "…" : line));
  return [...(lines.length > keep ? [`… ${lines.length - keep} earlier lines`] : []), ...lines.slice(-keep)].join("\n");
}

// ── Screen ──────────────────────────────────────────────────────────────────
// What was said, a spinner while bee works, the editor, and a footer.

const tui = new TuiMainScreen(new ProcessTerminal());
const [said, status, input, footer] = [new Container(), new Container(), new Container(), new Text("", 1, 0)];
const working = new Loader(tui, cyan, gray, "esc to stop");
const editor = new Editor(tui, { borderColor: gray, selectList: list }, { paddingX: 1 });
for (const part of [said, status, input, footer]) tui.addChild(part);

function add<T extends Component>(component: T): T {
  said.addChild(new Spacer(1));
  said.addChild(component);
  tui.requestRender();
  return component;
}

let usage = "";
let streaming: { kind: string; text: string; view: Markdown } | undefined; // the block text is arriving in
function note(text: string) {
  streaming = undefined;
  add(new Text(text, 1, 0));
}

function say(kind: "user" | "agent" | "thought", text: string) {
  if (streaming?.kind !== kind || kind === "user") {
    const look = { user: { bgColor: shades.user }, agent: {}, thought: { color: gray, italic: true } }[kind];
    streaming = { kind, text: "", view: add(new Markdown("", 1, kind === "user" ? 1 : 0, markdown, look)) };
  }
  streaming.view.setText((streaming.text += text));
  tui.requestRender();
}

const calls = new Map<string, { box: Box; output: Text }>();

const updates: Record<string, (update: any) => void> = {
  user_message_chunk: ({ content }) => say("user", content.text ?? ""), // when a session is loaded
  agent_message_chunk: ({ content }) => say("agent", content.text ?? ""),
  agent_thought_chunk: ({ content }) => say("thought", content.text ?? ""),
  tool_call: ({ toolCallId, rawInput }) => {
    const [box, output] = [new Box(1, 1, shades.pending), new Text("", 0, 0)];
    box.addChild(new Text(cyan(String(rawInput?.code ?? "").trim()), 0, 0));
    box.addChild(output);
    calls.set(toolCallId, { box: add(box), output });
    streaming = undefined;
  },
  tool_call_update: ({ toolCallId, status, rawOutput }) => {
    const call = calls.get(toolCallId)!;
    call.box.setBgFn(shades[status] ?? shades.pending);
    if (typeof rawOutput === "string" && rawOutput.trim()) call.output.setText("\n" + gray(tail(rawOutput)));
    tui.requestRender();
  },
  usage_update: ({ used, size }) => ((usage = `${Math.ceil((100 * used) / size)}%`), refresh()),
};

/** Ask the user to pick one, in the editor's place. */
let dismiss: (() => void) | undefined;
const choose = (items: { value: string; label: string }[]) =>
  new Promise<string | null>((resolve) => {
    const picker = new SelectList(items, items.length, list);
    const done = (value: string | null) => {
      dismiss = undefined;
      input.clear();
      input.addChild(editor);
      tui.setFocus(editor);
      resolve(value);
    };
    picker.onSelect = (item) => done(item.value);
    picker.onCancel = dismiss = () => done(null);
    input.clear();
    input.addChild(picker);
    tui.setFocus(picker);
  });

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

createInterface({ input: bee.stdout! }).on("line", async (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  if (method === "session/update") return updates[params.update.sessionUpdate]?.(params.update);
  if (method === "session/request_permission") {
    const optionId = await choose(params.options.map((o: any) => ({ value: o.optionId, label: o.name })));
    return send({ id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
  }
  if (method) return send({ id, error: { code: -32601, message: `No method ${method}` } });
  const { resolve, reject } = waiting.get(id)!;
  waiting.delete(id);
  error ? reject(new Error(error.message)) : resolve(result);
});

// ── Session ─────────────────────────────────────────────────────────────────

function quit(message?: string) {
  tui.stop();
  if (message) console.error(message);
  process.exit(message ? 1 : 0);
}

const cwd = process.cwd();
const must = (method: string, params: object) => call(method, params).catch((error) => quit(error.message));
tui.start();
await must("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "bee-cli", version } });
const resume = process.argv.includes("-c");
const latest = resume && (await must("session/list", { cwd })).sessions.find((s: any) => s.title)?.sessionId;
const session = await must(latest ? "session/load" : "session/new", { sessionId: latest || undefined, cwd, mcpServers: [] });
const sessionId: string = session.sessionId;
let options: { id: string; currentValue: string; options: { value: string }[] }[] = session.configOptions;

/** The footer and the slash commands follow the settings: each setting bee offers is a command. */
function refresh() {
  const where = cwd.replace(homedir(), "~");
  footer.setText(gray([where, ...options.map((option) => option.currentValue), usage].filter(Boolean).join(" · ")));
  const commands = options.map((option) => ({
    name: option.id,
    description: option.currentValue,
    getArgumentCompletions: (prefix: string) =>
      option.options.filter((o) => o.value.includes(prefix)).map((o) => ({ value: o.value, label: o.value })),
  }));
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, cwd));
  tui.requestRender();
}

async function set(line: string) {
  const [id, value = ""] = line.slice(1).split(/\s+/);
  const option = options.find((option) => option.id === id);
  if (!option) return note(red(`No command /${id}`));
  if (!option.options.some((o) => o.value === value)) return note(gray(`${id}: ${option.currentValue}`));
  ({ configOptions: options } = await call("session/set_config_option", { sessionId, configId: id, value }));
  refresh();
}

let busy = false;

async function prompt(text: string) {
  say("user", text);
  busy = true;
  status.addChild(working);
  working.start();
  try {
    const { stopReason } = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    if (stopReason !== "end_turn") note(gray(`[${stopReason}]`));
  } catch (error: any) {
    note(red(error.message));
  } finally {
    [busy, streaming] = [false, undefined];
    working.stop();
    status.clear();
    tui.requestRender();
  }
}

// Esc stops bee. Ctrl-C clears the editor, or quits if it is empty.
tui.addInputListener((data) => {
  if (matchesKey(data, "escape") && busy && !editor.isShowingAutocomplete())
    return send({ method: "session/cancel", params: { sessionId } }), dismiss?.(), { consume: true };
  if (matchesKey(data, "ctrl+c")) return editor.getText() ? editor.setText("") : quit(), { consume: true };
});

let queue: Promise<unknown> = Promise.resolve(); // what you send while bee works waits its turn
editor.onSubmit = (text) => {
  if (!text) return;
  editor.addToHistory(text);
  queue = queue.then(() => (text.startsWith("/") ? set(text).catch((error) => note(red(error.message))) : prompt(text)));
};
input.addChild(editor);
tui.setFocus(editor);
refresh();
const words = process.argv.slice(2).filter((arg) => arg !== "-c").join(" ");
if (words) editor.onSubmit(words);
await new Promise(() => {}); // bee.ts waits on this module, so the harness never starts here; quit() ends it
