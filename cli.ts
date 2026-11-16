// bee in a terminal. This is an editor like any other: it starts bee.ts and speaks ACP to it.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { version } from "./package.json";

const args = process.argv.slice(2);
const flags = new Set<string>(args.filter((arg) => arg === "-c" || arg === "-y"));
const words = args.filter((arg) => !flags.has(arg)).join(" ");
let yes = flags.has("-y");

// ── The screen ──────────────────────────────────────────────────────────────
// What bee says goes to stdout, everything else to stderr, so `bee "…" > file` keeps only the answer.

const paint = (code: number) => (text: string) => (process.stderr.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const [dim, red, cyan] = [paint(2), paint(31), paint(36)];

let shown = { kind: "", out: process.stderr as NodeJS.WriteStream, open: false }; // what was written last, and whether its line is open

/** Write text, with a blank line before it if it starts something new. */
function show(kind: string, text: string, out: NodeJS.WriteStream = process.stderr) {
  if (!text) return;
  if (shown.kind && kind !== shown.kind) shown.open && shown.out.write("\n"), process.stderr.write("\n");
  out.write(text);
  shown = { kind, out, open: !text.endsWith("\n") };
}

function end() {
  if (shown.open) shown.out.write("\n");
  shown = { kind: "", out: process.stderr, open: false };
}

/** Long output, cut to its start. The model sees all of it. */
function cut(text: string, keep = 2000) {
  const start = text.trimEnd().split("\n").slice(0, 20).join("\n").slice(0, keep);
  const left = text.trimEnd().length - start.length;
  return left > 0 ? `${start}\n… ${left} more characters` : start;
}

let usage = "";

function update(update: any) {
  const text = update.content?.text ?? "";
  if (update.sessionUpdate === "agent_message_chunk") show("agent", text, process.stdout);
  if (update.sessionUpdate === "agent_thought_chunk") show("thought", dim(text));
  if (update.sessionUpdate === "user_message_chunk") show("user", dim(`› ${text.trim()}\n`)); // when a session is loaded
  if (update.sessionUpdate === "tool_call") show(update.toolCallId, cyan(String(update.rawInput?.code ?? "").trim()) + "\n");
  if (update.sessionUpdate === "tool_call_update" && typeof update.rawOutput === "string")
    show(update.toolCallId, (update.status === "failed" ? red : dim)(cut(update.rawOutput)) + "\n");
  if (update.sessionUpdate === "usage_update") usage = `${Math.ceil((100 * update.used) / update.size)}% `;
}

// ── The keyboard ────────────────────────────────────────────────────────────
// Lines are asked for one at a time. Ctrl-C stops bee if it is working, and quits if not.

const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
let answer: ((line: string | null) => void) | undefined;
let closed = !rl;

/** One line from the user, or null if there is no one to ask. */
const read = (prompt: string) =>
  new Promise<string | null>((resolve) => {
    if (closed) return resolve(null);
    answer = resolve;
    rl!.setPrompt(prompt);
    rl!.prompt();
  });

const reply = (line: string | null) => {
  answer?.(line);
  answer = undefined;
};

let busy = false;
let stopping = false;

function interrupt() {
  if (!busy) return rl?.close();
  if (stopping) process.exit(130); // twice: bee is stuck, so go anyway
  stopping = true;
  send({ method: "session/cancel", params: { sessionId } });
  reply(null);
}

rl?.on("line", reply).on("SIGINT", interrupt).on("close", () => {
  closed = true;
  if (busy) interrupt();
  reply(null);
});
process.on("SIGINT", interrupt);

/** Whether a call may run. `-y`, or answering `a`, allows every call from then on. */
async function permit({ toolCall, options }: { toolCall: { toolCallId: string }; options: any[] }) {
  const line = yes ? "a" : await read("Run? [Y/n/a] ");
  if (!yes) shown = { kind: toolCall.toolCallId, out: process.stderr, open: false };
  if (stopping) return { outcome: "cancelled" };
  if (line && /^a/i.test(line)) yes = true;
  const kind = line === null || /^n/i.test(line) ? "reject" : "allow";
  return { outcome: "selected", optionId: options.find((option) => option.kind.startsWith(kind))?.optionId };
}

// ── bee ─────────────────────────────────────────────────────────────────────

const bee = spawn(process.execPath, [join(import.meta.dir, "bee.ts")], { stdio: ["pipe", "pipe", "inherit"] });
bee.on("exit", (code) => process.exit(code || 1));

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
  if (method === "session/update") return update(params.update);
  if (method === "session/request_permission") return send({ id, result: { outcome: await permit(params) } });
  if (method) return send({ id, error: { code: -32601, message: `No method ${method}` } });
  const { resolve, reject } = waiting.get(id)!;
  waiting.delete(id);
  error ? reject(new Error(error.message)) : resolve(result);
});

/** A call that has to work for anything else to. */
const must = (method: string, params: object) =>
  call(method, params).catch((error) => (console.error(red(error.message)), process.exit(1)));

await must("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "bee-cli", version } });
const cwd = process.cwd();
const latest = flags.has("-c") && (await must("session/list", { cwd })).sessions.find((s: any) => s.title)?.sessionId;
const method = !latest ? "session/new" : words ? "session/resume" : "session/load"; // only a person needs the history
const session = await must(method, { sessionId: latest || undefined, cwd, mcpServers: [] });
const sessionId: string = session.sessionId;
let options: { id: string; currentValue: string; options: { value: string }[] }[] = session.configOptions;

/** Send one prompt and show the turn. Returns whether it went wrong. */
async function prompt(text: string) {
  [busy, stopping] = [true, false];
  try {
    const { stopReason } = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    if (stopReason !== "end_turn") show("stop", dim(`[${stopReason}]`));
    return false;
  } catch (error: any) {
    show("error", red(error.message));
    return true;
  } finally {
    busy = false;
    end();
  }
}

/** `/model`, `/thinking`: each setting bee offers is a command. Without a value, it lists the values. */
async function set(line: string) {
  const [id, value] = line.slice(1).trim().split(/\s+/);
  const option = options.find((option) => option.id === id);
  if (!option) return show("help", dim(options.map((option) => `/${option.id} [value]`).join("\n")) + "\n");
  const exact = option.options.filter((o) => o.value === value);
  const matches = exact.length ? exact : option.options.filter((o) => value && o.value.includes(value));
  if (matches.length === 1) {
    options = (await call("session/set_config_option", { sessionId, configId: id, value: matches[0].value })).configOptions;
    return show("help", dim(`${id}: ${matches[0].value}`) + "\n");
  }
  if (value && !matches.length) show("help", red(`No ${id} matches ${value}`) + "\n");
  const list = (matches.length ? matches : option.options).map((o) => (o.value === option.currentValue ? "● " : "  ") + o.value);
  show("help", dim(list.join("\n")) + "\n");
}

if (words) process.exit((await prompt(words)) ? 1 : 0);
show("help", dim(`bee ${options.map((option) => option.currentValue).join(" · ")}`) + "\n");
for (;;) {
  if (shown.kind) end(), process.stderr.write("\n");
  const line = await read(`${usage}› `);
  if (line === null) process.exit();
  if (!line.trim()) continue;
  shown = { kind: "you", out: process.stderr, open: false };
  if (line.startsWith("/")) await set(line).catch((error) => show("error", red(error.message) + "\n"));
  else await prompt(line);
}
