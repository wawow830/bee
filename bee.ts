#!/usr/bin/env bun
// bee: a minimal agent harness. ACP on stdio, one tool, one append-only file per session.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
  validateToolCall,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { CACHE_RETENTIONS, MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import sharp from "sharp";
import { version } from "./package.json";

console.log = console.error; // stdout carries the protocol and nothing else

/** An error the editor is told of, with its JSON-RPC code. */
const failure = (code: number, message: string) => Object.assign(new Error(message), { code });

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee", "agent");
const read = (path: string, otherwise = "") => (existsSync(path) ? readFileSync(path, "utf8") : otherwise);

// ── Models ──────────────────────────────────────────────────────────────────

/** models.json, as pi writes it: {"providers": {"anthropic": {"baseUrl": "...", "apiKey": "..."}}}. */
const MODELS = join(HOME, "models.json");
const models = builtinModels();
for (const [id, { apiKey, baseUrl }] of Object.entries<any>(JSON.parse(read(MODELS, "{}")).providers ?? {})) {
  const provider = models.getProvider(id);
  const resolve = async () => ({ auth: { apiKey, baseUrl }, source: MODELS });
  if (provider) models.setProvider({ ...provider, auth: { apiKey: { name: MODELS, resolve } } });
}

/**
 * Each provider's models as pi.dev lists them, where pi finds them too: pi-ai's are as they were at its release. bee
 * starts with the lists it fetched last, and fetches them again without waiting, for the next start.
 */
const CATALOG = join(HOME, "catalog");
const catalog = (provider: string) => join(CATALOG, `${provider}.json`);

async function fetchCatalog(provider: string) {
  const response = await fetch(`https://pi.dev/api/models/providers/${provider}`);
  if (!response.ok) return;
  const json = JSON.stringify(await response.json());
  const temporary = `${catalog(provider)}.${process.pid}`;
  mkdirSync(CATALOG, { recursive: true });
  writeFileSync(temporary, json);
  renameSync(temporary, catalog(provider));
}

const ref = (model: Model<Api>) => `${model.provider}/${model.id}`;
const byName = new Intl.Collator("en", { numeric: true }).compare;

/** The models there is a key for, in order of their names: the catalog's over pi-ai's. */
const shipped = await models.getAvailable();
const providers = [...new Set(shipped.map((model) => model.provider))];
const listed = providers.flatMap((provider) => Object.values<Model<Api>>(JSON.parse(read(catalog(provider), "{}"))));
const merged = new Map([...shipped, ...listed].map((model) => [ref(model), model]));
const available = [...merged.values()].sort((a, b) => byName(ref(a), ref(b)));
for (const provider of providers) fetchCatalog(provider).catch(() => {});

// ── Sessions ────────────────────────────────────────────────────────────────
// A session is a file of lines, written as things happen: messages, and the
// settings chosen. Lines are only appended, so every request begins with the
// last one, and the provider's cache of it holds. The first line is how the
// session began: its directory, the prompt and the tool, and the settings in
// settings.json.

type Settings = { model?: string; thinking?: string; cache?: string };
type Line = Settings & { message?: Message; cwd?: string };

const SESSIONS = join(HOME, "sessions");
const file = (sid: string) => join(SESSIONS, sid + ".jsonl");

const SHOWN = 12_000; // characters of output the model sees per call
const SIDE = 1568; // pixels on an image's long side: as many as Anthropic sees, and fewer than any provider refuses
const BYTES = 3_932_160; // bytes of an image: 5 MiB in base64, as many as Anthropic takes

const BASH = {
  name: "bash",
  description:
    "Every command starts in the working directory. " +
    `Returns the output: its text, cut at ${SHOWN.toLocaleString("en")} characters, and its images.`,
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

/** AGENTS.md from ~/.bee/agent, then from every directory down to cwd. */
function instructions(cwd: string) {
  const dirs = [cwd];
  while (dirs[0] !== dirname(dirs[0])) dirs.unshift(dirname(dirs[0]));
  return [HOME, ...dirs]
    .map((dir) => join(dir, "AGENTS.md"))
    .filter(existsSync)
    .map((path) => `<file path="${path}">\n${read(path).trim()}\n</file>`)
    .join("\n\n");
}

/** How a session begins. */
const beginning = (cwd: string): Line => ({
  ...JSON.parse(read(join(HOME, "settings.json"), "{}")),
  cwd,
  message: {
    role: "system",
    content: `\nYou are an agent in the bee harness.\n\n${instructions(cwd)}`.trimEnd(),
    toolsAdded: [BASH],
    timestamp: Date.now(),
  },
});

/** A session's lines. One that is not JSON is empty. */
function lines(sid: string): Line[] {
  if (!/^[\w-]+$/.test(sid) || !existsSync(file(sid))) throw failure(-32002, `No session ${sid}`);
  const parse = (json: string) => {
    try {
      return JSON.parse(json) ?? {};
    } catch {
      return {};
    }
  };
  return read(file(sid)).trimEnd().split("\n").map(parse);
}

/**
 * Add a line to a session. Only its beginning makes the file, so a session deleted stays deleted: a line written
 * to a new file would be a session with no beginning, which no model will take and no one can list.
 */
function append(sid: string, line: Line, flag: string | number = constants.O_WRONLY | constants.O_APPEND) {
  let fd: number;
  try {
    fd = openSync(file(sid), flag);
  } catch (error: any) {
    throw error.code === "ENOENT" ? failure(-32002, `No session ${sid}`) : error;
  }
  try {
    writeSync(fd, JSON.stringify(line) + "\n");
  } finally {
    closeSync(fd);
  }
}

const cwdOf = (sid: string) => lines(sid)[0].cwd!;

const conversation = (sid: string) => lines(sid).flatMap((line) => (line.message ? [line.message] : []));

/**
 * For each setting, the latest line that makes sense holds. Without one, the model is the first there is a key for,
 * thinking is medium, and the prompt stays cached for five minutes. ("long" is an hour.)
 */
function settings(sid: string) {
  if (!available.length) throw failure(-32000, "No provider key is set.");
  const all = lines(sid);
  const latest = <T>(pick: (line: Line) => T | undefined) => all.map(pick).findLast(Boolean);
  const model = latest((line) => available.find((one) => ref(one) === line.model)) ?? available[0];
  const level = latest((line) => MODEL_THINKING_LEVELS.find((level) => level === line.thinking)) ?? "medium";
  const cache = latest((line) => CACHE_RETENTIONS.find((retention) => retention === line.cache)) ?? "short";
  return { model, thinking: clampThinkingLevel(model, level), cache };
}

// ── The turn ────────────────────────────────────────────────────────────────

/** One reply from the model, streamed to the editor. */
async function ask(sid: string, signal: AbortSignal): Promise<AssistantMessage> {
  const { model, thinking, cache } = settings(sid);
  const reasoning = thinking === "off" ? undefined : thinking;
  const stream = models.streamSimple(
    model,
    { messages: conversation(sid) },
    {
      signal,
      sessionId: sid,
      reasoning,
      cacheRetention: cache,
    },
  );
  for await (const event of stream) {
    if (event.type === "text_delta") say(sid, "agent_message", event.delta);
    if (event.type === "thinking_delta") say(sid, "agent_thought", event.delta);
  }
  const reply = await stream.result();
  usage(sid, reply);
  return reply;
}

const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: Date.now() });

/** A turn under way: how to stop it, what the user said that it has not read, and how it ends. */
type Turn = { abort: AbortController; said: UserMessage[]; done?: Promise<string> };
const turns = new Map<string, Turn>();

/** Write what the user said that the turn has not read, in the order it was said. */
const hear = (sid: string, said: UserMessage[]) => {
  for (const message of said.splice(0)) append(sid, { message });
};

/**
 * Read what the user said, ask, run what it asks for, and again until it has nothing to run and nothing more was
 * said. A prompt sent during a turn joins it, and the model reads it once the commands it is running end.
 */
async function turn(sid: string, { abort: { signal }, said }: Turn): Promise<string> {
  try {
    for (;;) {
      hear(sid, said);
      if (signal.aborted) return "cancelled";
      const reply = await ask(sid, signal);
      const calls = reply.stopReason === "toolUse" ? reply.content.filter((block) => block.type === "toolCall") : [];
      append(sid, { message: reply });
      for (const call of calls) if (!signal.aborted) append(sid, { message: await run(sid, call, signal) });
      if (reply.stopReason === "error") throw new Error(reply.errorMessage);
      if (!calls.length && !said.length && !signal.aborted)
        return reply.stopReason === "length" ? "max_tokens" : "end_turn";
    }
  } finally {
    // However the turn ends, all that was said is written, in the same step as it is over, so none is left behind.
    hear(sid, said);
    turns.delete(sid);
  }
}

// ── The tool ────────────────────────────────────────────────────────────────

/** Where an image may start in what a command writes: PNG, JPEG, GIF or WebP. */
const IMAGE = /\x89PNG\r\n\x1a\n|\xff\xd8\xff|GIF8[79]a|RIFF[^]{4}WEBP/g;

/** Where the image that starts at `i` ends, read by its format's own lengths, or 0 if it does not. */
function end(b: Buffer, i: number) {
  let j = i;
  const table = (flags: number) => flags & 0x80 && 3 << ((flags & 7) + 1); // a GIF's colours
  const blocks = () => {
    while (b[j]) j += b[j] + 1; // a GIF's data, in blocks each led by its length
    j++;
  };
  try {
    if (b[i] === 0x89) {
      // PNG: chunks, each led by its length, to IEND
      j += 8;
      while (b.toString("latin1", j + 4, j + 8) !== "IEND") j += b.readUInt32BE(j) + 12;
      j += 12;
    } else if (b[i] === 0x52) {
      // WebP: RIFF, led by its length
      j += 8 + b.readUInt32LE(i + 4);
    } else if (b[i] === 0x47) {
      // GIF: a screen and its colours, then images and extensions, to the trailer
      j += 13 + table(b[i + 10]);
      while (b[j] !== 0x3b) {
        if (b[j] === 0x21) j += 2;
        else if (b[j] === 0x2c) j += 11 + table(b[j + 9]);
        else return 0;
        blocks();
      }
      j++;
    } else {
      // JPEG: segments, each led by its length, and after a scan its data, to EOI
      j += 2;
      while (b[j + 1] !== 0xd9) {
        if (b[j] !== 0xff) return 0;
        const marker = b[j + 1];
        j += marker === 0xff ? 1 : 2 + b.readUInt16BE(j + 2); // a byte of fill, or a segment
        if (marker === 0xda) while (j < b.length && !(b[j] === 0xff && b[j + 1] && (b[j + 1] & 0xf8) !== 0xd0)) j++;
      }
      j += 2;
    }
  } catch {
    return 0;
  }
  return j <= b.length ? j : 0;
}

/** An image as a model is shown it: SIDE pixels long at most, in its format, or JPEG if that is more than BYTES. */
async function see(bytes: Buffer): Promise<ImageContent | undefined> {
  try {
    const image = sharp(bytes).rotate().resize(SIDE, SIDE, { fit: "inside", withoutEnlargement: true });
    const { format = "png" } = await image.metadata();
    const kept = await image.clone().toFormat(format).toBuffer();
    const fits = kept.length <= BYTES; // and a JPEG this size always does
    const data = fits ? kept : await image.jpeg().toBuffer();
    return { type: "image", data: data.toString("base64"), mimeType: `image/${fits ? format : "jpeg"}` };
  } catch {}
}

/** Run a command. Returns what it wrote, as text cut to its two ends and the images in it, and whether it failed. */
async function bash(sid: string, command: string, signal: AbortSignal) {
  // Written to a file, not a pipe, so the call ends when the command does, whatever it left running.
  const path = join(tmpdir(), `bee-${randomUUID()}`);
  const out = openSync(path, "w");
  const cwd = cwdOf(sid);
  const left = path + ".cwd"; // where bash is when it exits
  // In its own process group, so an interrupt stops all of it.
  const child = spawn("bash", ["-c", `trap 'pwd > "${left}"' EXIT\n${command}`], {
    cwd,
    stdio: ["ignore", out, out],
    detached: true,
  });
  const interrupt = () => process.kill(-child.pid!, "SIGINT");
  signal.addEventListener("abort", interrupt);
  try {
    const [status] = await once(child, "exit");
    const written = readFileSync(path);
    // The images in it, wherever they are, taken out of its text.
    const images: ImageContent[] = [];
    const text: Buffer[] = [];
    let rest = 0;
    for (const { index } of written.toString("latin1").matchAll(IMAGE)) {
      const after = index >= rest && end(written, index);
      const image = after && (await see(written.subarray(index, after)));
      if (!image) continue;
      images.push(image);
      text.push(written.subarray(rest, index));
      rest = after;
    }
    text.push(written.subarray(rest));
    // Every command starts in the session's directory. One that ends elsewhere is told so, as Claude Code tells it.
    const ended = read(left).trim();
    const reset = ended && ended !== cwd ? `Shell cwd was reset to ${cwd}` : "";
    const said = [Buffer.concat(text).toString("utf8").trimEnd(), reset].filter(Boolean).join("\n");
    const cut = said.length - SHOWN;
    const shown = cut <= 0 ? said : `${said.slice(0, SHOWN / 2)}\n[${cut} characters cut]\n${said.slice(-SHOWN / 2)}`;
    const content: ToolResultMessage["content"] = [
      ...(shown || !images.length ? [{ type: "text" as const, text: shown || "(no output)" }] : []),
      ...images,
    ];
    return { content, failed: status !== 0 };
  } finally {
    signal.removeEventListener("abort", interrupt);
    closeSync(out);
    rmSync(path);
    rmSync(left, { force: true });
  }
}

/** Run one tool call, shown to the editor. A call that is not a command is told why. */
async function run(sid: string, call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
  showCall(sid, call);
  const { content, failed } = await Promise.resolve()
    .then(() => bash(sid, validateToolCall([BASH], call).command, signal))
    .catch((error: Error) => ({ content: [{ type: "text" as const, text: error.message }], failed: true }));
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: failed,
    timestamp: Date.now(),
  };
  showResult(sid, call, result);
  return result;
}

// ── The editor ──────────────────────────────────────────────────────────────
// ACP: JSON-RPC, one message per line, on stdin and stdout.

const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId: string, fields: object) =>
  send({ method: "session/update", params: { sessionId, update: fields } });

const say = (sid: string, who: "user_message" | "agent_message" | "agent_thought", words: string) =>
  words && update(sid, { sessionUpdate: `${who}_chunk`, content: { type: "text", text: words } });

/** How full the context is: the tokens in the conversation, as the model counted them in a reply. */
const usage = (sid: string, reply: AssistantMessage) =>
  update(sid, {
    sessionUpdate: "usage_update",
    used: reply.usage.totalTokens,
    size: settings(sid).model.contextWindow,
  });

/** A message's content, as plain text. */
const plain = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");

/** A code block, fenced by more backticks than it holds. */
function fenced(body: string, language = "") {
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((ticks) => ticks[0].length + 1)));
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${body.trim()}\n${fence}` } };
}

const command = (call: ToolCall) => String(call.arguments.command ?? "");

function showCall(sid: string, call: ToolCall) {
  const shown = { toolCallId: call.id, title: command(call).trim().split("\n")[0].slice(0, 80), kind: "execute" };
  const content = [fenced(command(call), "bash")];
  update(sid, { sessionUpdate: "tool_call", ...shown, status: "in_progress", content, rawInput: call.arguments });
}

function showResult(sid: string, call: ToolCall, result: ToolResultMessage) {
  const status = result.isError ? "failed" : "completed";
  const output = result.content.map((block) =>
    block.type === "image" ? { type: "content", content: block } : fenced(block.text),
  );
  const content = [fenced(command(call), "bash"), ...output];
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.id,
    status,
    content,
    rawOutput: plain(result.content),
  });
}

/** Show the editor a conversation it has not seen. */
function replay(sid: string) {
  const calls = new Map<string, ToolCall>();
  for (const message of conversation(sid)) {
    if (message.role === "user") say(sid, "user_message", plain(message.content));
    if (message.role === "toolResult") showResult(sid, calls.get(message.toolCallId)!, message);
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text") say(sid, "agent_message", block.text);
      if (block.type === "thinking") say(sid, "agent_thought", block.thinking);
      if (block.type === "toolCall") {
        calls.set(block.id, block);
        showCall(sid, block);
      }
    }
  }
}

/** The settings the editor can change. Each one's id is its key in a line. */
function options(sid: string) {
  const { model, thinking } = settings(sid);
  const all = available.map((one) => ({ value: ref(one), name: one.name }));
  const levels = getSupportedThinkingLevels(model).map((level) => ({ value: level, name: level }));
  return [
    { id: "model", name: "Model", category: "model", currentValue: ref(model), options: all },
    { id: "thinking", name: "Thinking", category: "thought_level", currentValue: thinking, options: levels },
  ].map((option) => ({ type: "select", ...option }));
}

/** The sessions, latest first. One's title is the start of what the user first said in it. */
function list(cwd?: string) {
  return readdirSync(SESSIONS)
    .flatMap((name) => /^([\w-]+)\.jsonl$/.exec(name)?.[1] ?? [])
    .map((sessionId) => {
      const first = conversation(sessionId).find((message) => message.role === "user")?.content ?? "";
      const updatedAt = statSync(file(sessionId)).mtime.toISOString();
      return { sessionId, cwd: cwdOf(sessionId), title: plain(first).slice(0, 80) || undefined, updatedAt };
    })
    .filter((session) => !cwd || session.cwd === cwd)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** An image pasted, as a file the model can read: its path. */
function saved(bytes: Buffer, mimeType: string) {
  const path = join(tmpdir(), `bee-${randomUUID()}.${mimeType.split("/")[1]}`);
  writeFileSync(path, bytes);
  return path;
}

/** Prompt blocks from the editor, as content for the model. */
const parts = (blocks: any[]): UserMessage["content"] =>
  blocks.map((block) =>
    block.type === "image"
      ? { type: "text", text: saved(Buffer.from(block.data, "base64"), block.mimeType) }
      : block.type === "resource"
        ? { type: "text", text: `<file uri="${block.resource.uri}">\n${block.resource.text ?? ""}\n</file>` }
        : { type: "text", text: block.text ?? block.uri ?? "" },
  );

/** A session the editor opens, and how full its context was at the last reply. */
function open(sessionId: string) {
  const last = conversation(sessionId).findLast((message) => message.role === "assistant");
  if (last) usage(sessionId, last);
  return { sessionId, configOptions: options(sessionId) };
}

const handlers: Record<string, (params: any) => unknown> = {
  initialize: () => ({
    protocolVersion: 1,
    agentInfo: { name: "bee", title: "bee", version },
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {} },
    },
  }),
  "session/new": ({ cwd }) => {
    const sessionId = randomUUID();
    append(sessionId, beginning(cwd), "wx");
    return open(sessionId);
  },
  "session/resume": ({ sessionId }) => open(sessionId),
  "session/load": ({ sessionId }) => {
    replay(sessionId);
    return open(sessionId);
  },
  "session/list": ({ cwd }) => ({ sessions: list(cwd) }),
  "session/set_config_option": ({ sessionId, configId, value }) => {
    const choices = options(sessionId).find((option) => option.id === configId)?.options ?? [];
    if (!choices.some((choice) => choice.value === value)) throw failure(-32602, `No ${configId} ${value}`);
    append(sessionId, { [configId]: value });
    return { configOptions: options(sessionId) };
  },
  "session/cancel": ({ sessionId }) => turns.get(sessionId)?.abort.abort(),
  "session/prompt": async ({ sessionId, prompt }) => {
    const message = user(parts(prompt));
    let under = turns.get(sessionId);
    if (under) under.said.push(message);
    else {
      under = { abort: new AbortController(), said: [message] };
      turns.set(sessionId, under);
      under.done = turn(sessionId, under);
    }
    return { stopReason: await under.done };
  },
};

/**
 * The editor hung up, or the terminal closed: stop every turn as a cancel does, so each writes down how far it got,
 * then go. What is said to an editor that is gone is lost, and only the file matters.
 */
async function hangUp() {
  const under = [...turns.values()];
  for (const turn of under) turn.abort.abort();
  await Promise.allSettled(under.map((turn) => turn.done));
  process.exit();
}
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(signal, hangUp);
process.stdout.on("error", () => {});

mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (!method) continue; // a reply, and we ask nothing
  const reply = (answer: object) => id !== undefined && send({ id, ...answer });
  const unknown = () => Promise.reject(failure(-32601, `No method ${method}`));
  Promise.resolve(params ?? {})
    .then(handlers[method] ?? unknown)
    .then(
      (result) => reply({ result: result ?? {} }),
      (error) => reply({ error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } }),
    );
}
await hangUp();
