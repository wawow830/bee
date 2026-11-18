#!/usr/bin/env bun
// bee: a minimal agent harness. ACP on stdio, one tool, one append-only file per session.
import { isUtf8 } from "node:buffer";
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
import { version } from "./package.json";

console.log = console.error; // stdout carries the protocol and nothing else

/** An error the editor is told of, with its JSON-RPC code. */
const failure = (code: number, message: string) => Object.assign(new Error(message), { code });

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee", "agent");
const read = (path: string, otherwise = "") => (existsSync(path) ? readFileSync(path, "utf8") : otherwise);

/** A line as JSON. One that is not JSON is empty. */
function parse(line: string) {
  try {
    return JSON.parse(line) ?? {};
  } catch {
    return {};
  }
}

// ── Messages ────────────────────────────────────────────────────────────────
// What a session's file holds: what was said, by the user, the model and the tool.

type Text = { type: "text"; text: string; textSignature?: string };
type Image = { type: "image"; data: string; mimeType: string };
type Thinking = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };
type Call = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type Tool = { name: string; description: string; parameters: object };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

/** How the session began: the prompt, and the tool. */
type System = { role: "system"; content: string; toolsAdded: Tool[]; timestamp: number };
type User = { role: "user"; content: string | (Text | Image)[]; timestamp: number };
type Reply = {
  role: "assistant";
  content: (Text | Thinking | Call)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  /** "refused": the provider refused the request as it was, so the same again it would refuse again. */
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "refused";
  errorMessage?: string;
  timestamp: number;
};
type Result = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (Text | Image)[];
  isError: boolean;
  timestamp: number;
};
/** What is said once the session has begun. */
type Said = User | Reply | Result;
type Message = System | Said;

/** What bee says in a tool's answer, set apart from all a command wrote. */
const bee = (words: string) => `(bee: ${words})`;

const user = (content: User["content"]): User => ({ role: "user", content, timestamp: Date.now() });
const result = (call: Call, content: Result["content"], isError: boolean): Result => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content,
  isError,
  timestamp: Date.now(),
});

// ── The APIs ────────────────────────────────────────────────────────────────
// bee speaks to models itself, in two APIs: Anthropic's Messages, and OpenAI's Responses as Codex takes them. Each
// makes a request of the conversation, and a reply of the events it streams back.

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CACHES = ["none", "short", "long"] as const;
type Level = (typeof LEVELS)[number];
type Cache = (typeof CACHES)[number];

/** A model as pi.dev lists it, with the key and address of its provider. */
type Model = {
  provider: string;
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** What the API calls each level; null for a level the model does not have. */
  thinkingLevelMap?: Partial<Record<Level, string | null>>;
  compat?: { forceAdaptiveThinking?: boolean };
};

/** `origin`: how the session began, the same in each of its forks. Codex keeps its cache by it. */
type Options = { origin: string; thinking: Level; cache: Cache; signal: AbortSignal };
type Tell = (type: "text" | "thinking", words: string) => void;
type Api = {
  request(
    model: Model,
    messages: Message[],
    options: Options,
  ): { url: string; headers: Record<string, string>; body: object };
  /** Fills the reply as the events come, and returns how it stopped. A reply that fails throws. */
  read(incoming: AsyncIterable<any>, reply: Reply, tell: Tell): Promise<"stop" | "length" | "toolUse">;
};

/** One reply from a model, its words and thoughts told as they come. One that fails or is stopped says so. */
async function stream(model: Model, messages: Message[], chosen: Options, tell: Tell): Promise<Reply> {
  const api = APIS[model.api];
  const { provider, id } = model;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const reply: Reply = {
    role: "assistant",
    content: [],
    api: model.api,
    provider,
    model: id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  try {
    const { url, headers, body } = api.request(model, sendable(messages), chosen);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: chosen.signal,
    });
    const { status } = response;
    if (!response.ok) throw Object.assign(new Error(`${status} ${await response.text()}`), { status });
    reply.stopReason = await api.read(events(response.body!), reply, tell);
  } catch (error: any) {
    reply.stopReason = chosen.signal.aborted ? "aborted" : REFUSALS.includes(error.status) ? "refused" : "error";
    reply.errorMessage = error.message;
  }
  return reply;
}

/** The statuses of a request refused as it was: sent the same again, it would be refused again. */
const REFUSALS = [400, 413];

/**
 * The conversation as an API takes it: a reply that failed or was stopped is left out, with what answered it, a call
 * nothing answered is answered as not run, and an answer that says nothing says so. An answer a request was refused
 * with, one sent since the last reply, is the refusal, so no session holds one every request after is refused for.
 */
function sendable(messages: Message[]): Message[] {
  const sent: Message[] = [];
  const unanswered = new Map<string, Call>();
  let since = 0; // where what was sent since the last reply begins
  const close = () => {
    for (const call of unanswered.values()) sent.push(result(call, [{ type: "text", text: bee("not run") }], true));
    unanswered.clear();
  };
  for (const message of messages) {
    if (message.role === "toolResult") {
      const silent = message.content.every((block) => block.type === "text" && !block.text.trim());
      const said: Result = silent ? { ...message, content: [{ type: "text", text: bee("no output") }] } : message;
      if (unanswered.delete(message.toolCallId)) sent.push(said);
      continue;
    }
    close();
    if (message.role === "assistant") {
      if (message.stopReason === "refused")
        for (let n = since; n < sent.length; n++) sent[n] = refused(sent[n], message.errorMessage!);
      if (["error", "aborted", "refused"].includes(message.stopReason)) continue;
      since = sent.length + 1;
      for (const block of message.content) if (block.type === "toolCall") unanswered.set(block.id, block);
    }
    sent.push(message);
  }
  close();
  return sent;
}

/** A message as a request was refused with it: a tool's answer is the refusal. */
const refused = (message: Message, why: string): Message =>
  message.role === "toolResult"
    ? { ...message, content: [{ type: "text", text: bee(`provider refused: ${why}`) }] }
    : message;

/** The data of each event a server streams, as JSON. */
async function* events(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    const frames = (buffer + decoder.decode(bytes, { stream: true })).replaceAll("\r\n", "\n").split("\n\n");
    buffer = frames.pop()!;
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

/** Whether a reply is the model's own, so what only it can read is sent back: its thinking, and the ids it gave. */
const own = (reply: Reply, model: Model) =>
  reply.provider === model.provider && reply.api === model.api && reply.model === model.id;

/** What the user said, as blocks. */
const blocks = (content: User["content"]): (Text | Image)[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

/** A tool's result as one text, if it is only text. */
const textual = (content: Result["content"]) =>
  content.every((block): block is Text => block.type === "text")
    ? content.map((block) => block.text).join("\n")
    : undefined;

/** A tool call's id as an API takes it: letters, digits, _ and -, at most 64. */
const callId = (id: string) => id.replace(/[^\w-]/g, "_").slice(0, 64);

const BUDGETS: Partial<Record<Level, number>> = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
const STOPS: Record<string, "stop" | "length" | "toolUse"> = {
  end_turn: "stop",
  pause_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "toolUse",
};

/**
 * Anthropic's Messages. The prompt with the tool, and the conversation, are each cached to their end. A key that is an
 * OAuth token, one with sk-ant-oat in it, is sent as Claude Code, as the API takes one only from it.
 */
const anthropic: Api = {
  request(model, messages, { thinking, cache }) {
    const [system, ...rest] = messages as [System, ...Said[]];
    const oauth = model.apiKey.includes("sk-ant-oat");
    const mark =
      cache === "none" ? {} : { cache_control: { type: "ephemeral", ...(cache === "long" && { ttl: "1h" }) } };
    const media = (content: User["content"]) =>
      blocks(content)
        .filter((block) => block.type === "image" || block.text.trim())
        .map((block) =>
          block.type === "image"
            ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
            : { type: "text", text: block.text },
        );
    const said = (block: Text | Thinking | Call, reply: Reply): object[] => {
      if (block.type === "text") return block.text.trim() ? [{ type: "text", text: block.text }] : [];
      if (block.type === "toolCall")
        return [{ type: "tool_use", id: callId(block.id), name: block.name, input: block.arguments }];
      if (!own(reply, model) || !block.thinkingSignature) return [];
      return block.redacted
        ? [{ type: "redacted_thinking", data: block.thinkingSignature }]
        : [{ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature }];
    };
    const wire = (message: Said): { role: string; content: object[] } => {
      if (message.role === "assistant")
        return { role: "assistant", content: message.content.flatMap((block) => said(block, message)) };
      if (message.role === "user") return { role: "user", content: media(message.content) };
      const content = textual(message.content) ?? media(message.content);
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: callId(message.toolCallId), content, is_error: message.isError }],
      };
    };
    // One message for each turn of who speaks, the last cached to its end.
    const dialogue: { role: string; content: object[] }[] = [];
    for (const { role, content } of rest.map(wire).filter((message) => message.content.length)) {
      if (dialogue.at(-1)?.role === role) dialogue.at(-1)!.content.push(...content);
      else dialogue.push({ role, content });
    }
    Object.assign(dialogue.at(-1)?.content.at(-1) ?? {}, mark);
    const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
    const effort = model.thinkingLevelMap?.[thinking] ?? (thinking === "minimal" ? "low" : thinking);
    const reasoning = !model.reasoning
      ? {}
      : thinking === "off"
        ? { thinking: { type: "disabled" } }
        : model.compat?.forceAdaptiveThinking
          ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort } }
          : { thinking: { type: "enabled", budget_tokens: BUDGETS[thinking], display: "summarized" } };
    return {
      url: `${model.baseUrl}/v1/messages`,
      headers: {
        "anthropic-version": "2023-06-01",
        ...(oauth
          ? { authorization: `Bearer ${model.apiKey}`, "anthropic-beta": "oauth-2025-04-20" }
          : { "x-api-key": model.apiKey }),
      },
      body: {
        model: model.id,
        max_tokens: model.maxTokens,
        stream: true,
        system: [...(oauth ? [identity] : []), { type: "text", text: system.content, ...mark }],
        tools: system.toolsAdded.map(({ name, description, parameters }) => ({
          name,
          description,
          input_schema: parameters,
        })),
        messages: dialogue,
        ...reasoning,
      },
    };
  },

  async read(incoming, reply, tell) {
    const underway = new Map<number, { block: any; json: string }>(); // by the index the API gives it
    let stopped: { stop_reason?: string; stop_details?: { explanation?: string } } = {};
    const count = (counts: any = {}) => {
      const counted = reply.usage;
      counted.input = counts.input_tokens ?? counted.input;
      counted.output = counts.output_tokens ?? counted.output;
      counted.cacheRead = counts.cache_read_input_tokens ?? counted.cacheRead;
      counted.cacheWrite = counts.cache_creation_input_tokens ?? counted.cacheWrite;
      counted.totalTokens = counted.input + counted.output + counted.cacheRead + counted.cacheWrite;
    };
    /** A block as it starts, as bee keeps it. */
    const started = (block: any): Reply["content"][number] | undefined => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "thinking")
        return { type: "thinking", thinking: block.thinking, thinkingSignature: block.signature };
      if (block.type === "redacted_thinking")
        return { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: block.data, redacted: true };
      if (block.type === "tool_use") return { type: "toolCall", id: block.id, name: block.name, arguments: {} };
    };
    for await (const event of incoming) {
      const { delta } = event;
      const under = underway.get(event.index);
      switch (event.type) {
        case "error":
          throw new Error(`${event.error.type}: ${event.error.message}`);
        case "message_start":
          count(event.message.usage);
          break;
        case "content_block_start": {
          const block = started(event.content_block);
          if (!block) break;
          underway.set(event.index, { block, json: "" });
          reply.content.push(block);
          break;
        }
        case "content_block_delta":
          if (!under) break;
          if (delta.type === "text_delta") under.block.text += delta.text;
          if (delta.type === "thinking_delta") under.block.thinking += delta.thinking;
          if (delta.type === "text_delta" || delta.type === "thinking_delta")
            tell(under.block.type, delta.text ?? delta.thinking);
          if (delta.type === "signature_delta")
            under.block.thinkingSignature = (under.block.thinkingSignature ?? "") + delta.signature;
          if (delta.type === "input_json_delta") under.json += delta.partial_json;
          break;
        case "content_block_stop":
          if (under?.block.type === "toolCall") under.block.arguments = JSON.parse(under.json || "{}");
          underway.delete(event.index);
          break;
        case "message_delta":
          stopped = delta;
          count(event.usage);
          break;
        case "message_stop": {
          const reason = STOPS[stopped.stop_reason!];
          if (reason) return reason;
          throw new Error(stopped.stop_details?.explanation ?? `The model stopped: ${stopped.stop_reason}`);
        }
      }
    }
    throw new Error("The stream ended before the reply did");
  },
};

/** The ChatGPT account a Codex token is for. */
function account(token: string): string {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const id = claims["https://api.openai.com/auth"].chatgpt_account_id;
    if (typeof id === "string") return id;
  } catch {}
  throw new Error("The key is not a ChatGPT token: it names no account.");
}

/** OpenAI's Responses, as Codex takes them. How the session began is the cache's key, so a fork begins cached. */
const codex: Api = {
  request(model, messages, { origin, thinking, cache }) {
    const [system, ...rest] = messages as [System, ...Said[]];
    const media = (content: User["content"]) =>
      blocks(content).map((block) =>
        block.type === "text"
          ? { type: "input_text", text: block.text }
          : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` },
      );
    const said = (block: Text | Thinking | Call, reply: Reply): object[] => {
      const mine = own(reply, model);
      if (block.type === "thinking")
        return mine && block.thinkingSignature ? [JSON.parse(block.thinkingSignature)] : [];
      if (block.type === "toolCall") {
        const [call, item] = block.id.split("|");
        const id = mine && item?.startsWith("fc_") ? { id: item } : {};
        return [
          {
            type: "function_call",
            ...id,
            call_id: callId(call),
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          },
        ];
      }
      if (!block.text.trim()) return [];
      if (!mine || !block.textSignature) return [{ role: "assistant", content: block.text }];
      const { id, phase } = JSON.parse(block.textSignature);
      const content = [{ type: "output_text", text: block.text, annotations: [] }];
      return [{ type: "message", role: "assistant", content, status: "completed", id, phase }];
    };
    const wire = (message: Said): object[] => {
      if (message.role === "assistant") return message.content.flatMap((block) => said(block, message));
      if (message.role === "user") return [{ role: "user", content: media(message.content) }];
      const output = textual(message.content) ?? media(message.content);
      return [{ type: "function_call_output", call_id: callId(message.toolCallId.split("|")[0]), output }];
    };
    const effort =
      thinking === "off" ? (model.thinkingLevelMap?.off ?? "none") : (model.thinkingLevelMap?.[thinking] ?? thinking);
    return {
      url: `${model.baseUrl.replace(/\/codex$/, "")}/codex/responses`,
      headers: {
        authorization: `Bearer ${model.apiKey}`,
        "chatgpt-account-id": account(model.apiKey),
        "openai-beta": "responses=experimental",
        originator: "bee",
        "session-id": origin,
        accept: "text/event-stream",
      },
      body: {
        model: model.id,
        store: false,
        stream: true,
        instructions: system.content,
        input: rest.flatMap(wire),
        tools: system.toolsAdded.map(({ name, description, parameters }) => ({
          type: "function",
          name,
          description,
          parameters,
        })),
        include: ["reasoning.encrypted_content"],
        ...(cache !== "none" && { prompt_cache_key: origin }),
        ...(model.reasoning && { reasoning: { effort, ...(thinking !== "off" && { summary: "auto" }) } }),
      },
    };
  },

  async read(incoming, reply, tell) {
    /** An item as it is done, as bee keeps it. */
    const done = (item: any): Reply["content"][number] | undefined => {
      if (item.type === "reasoning")
        return {
          type: "thinking",
          thinking: item.summary.map((part: any) => part.text).join("\n\n"),
          thinkingSignature: JSON.stringify(item),
        };
      if (item.type === "message")
        return {
          type: "text",
          text: item.content.map((part: any) => part.text ?? part.refusal).join(""),
          textSignature: JSON.stringify({ v: 1, id: item.id, phase: item.phase ?? undefined }),
        };
      if (item.type === "function_call")
        return {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: JSON.parse(item.arguments || "{}"),
        };
    };
    for await (const event of incoming) {
      const { type, delta, item, response } = event;
      if (type === "error") throw new Error(`${event.code}: ${event.message}`);
      if (type === "response.failed") throw new Error(`${response.error?.code}: ${response.error?.message}`);
      if (type === "response.output_text.delta") tell("text", delta);
      if (type === "response.reasoning_summary_text.delta") tell("thinking", delta);
      if (type === "response.reasoning_summary_part.done") tell("thinking", "\n\n");
      if (type === "response.output_item.done") {
        const block = done(item);
        if (block) reply.content.push(block);
      }
      if (type === "response.completed" || type === "response.incomplete") {
        const { input_tokens, input_tokens_details: cached = {}, output_tokens, total_tokens } = response.usage;
        const cacheRead = cached.cached_tokens ?? 0;
        const cacheWrite = cached.cache_write_tokens ?? 0;
        const input = input_tokens - cacheRead - cacheWrite;
        reply.usage = { input, output: output_tokens, cacheRead, cacheWrite, totalTokens: total_tokens };
        if (type === "response.completed")
          return reply.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
        const reason = response.incomplete_details?.reason;
        if (reason === "max_output_tokens") return "length";
        throw new Error(`The reply is incomplete: ${reason}`);
      }
    }
    throw new Error("The stream ended before the reply did");
  },
};

const APIS: Record<string, Api> = { "anthropic-messages": anthropic, "openai-codex-responses": codex };

// ── Models ──────────────────────────────────────────────────────────────────

/** models.json, as pi writes it: {"providers": {"anthropic": {"apiKey": "...", "baseUrl": "..."}}}. */
const MODELS = join(HOME, "models.json");
const keys: Record<string, { apiKey: string; baseUrl?: string }> = JSON.parse(read(MODELS, "{}")).providers ?? {};

/**
 * Each provider's models as pi.dev lists them. bee starts with the list it fetched last, and fetches it again without
 * waiting, for the next start; a provider it has none of yet waits for it.
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

async function listed(provider: string): Promise<Model[]> {
  const fetched = fetchCatalog(provider).catch(() => {});
  if (!existsSync(catalog(provider))) await fetched;
  return Object.values(JSON.parse(read(catalog(provider), "{}")));
}

const ref = (model: Model) => `${model.provider}/${model.id}`;
const byName = new Intl.Collator("en", { numeric: true }).compare;

/** The models of every provider with a key, that speak an API bee does, in order of their names. */
const providers = await Promise.all(
  Object.entries(keys).map(async ([provider, { apiKey, baseUrl }]) =>
    (await listed(provider))
      .filter((model) => model.api in APIS)
      .map((model) => ({ ...model, apiKey, baseUrl: baseUrl ?? model.baseUrl })),
  ),
);
const available = providers.flat().sort((a, b) => byName(ref(a), ref(b)));

/** A model's thinking levels: off alone if it does not think, and none its API calls null. xhigh and max it names. */
const levels = (model: Model): Level[] =>
  model.reasoning
    ? LEVELS.filter((level) => {
        const named = model.thinkingLevelMap?.[level];
        return level === "xhigh" || level === "max" ? typeof named === "string" : named !== null;
      })
    : ["off"];

/** The level a model has that is nearest the one asked for: it, or the nearest above, or else below. */
function nearest(model: Model, level: Level) {
  const at = LEVELS.indexOf(level);
  return [...LEVELS.slice(at), ...LEVELS.slice(0, at).reverse()].find((one) => levels(model).includes(one))!;
}

// ── Sessions ────────────────────────────────────────────────────────────────
// A session is a file of lines, written as things happen: messages, and the settings chosen. Lines are only appended,
// so every request begins with the last one, and the provider's cache of it holds. The first line is how the session
// began: its directory, the prompt and the tool, and the settings in settings.json. The file is made when the first
// thing is said in it. A reply that runs commands is written with what they returned, in one write, so nothing comes
// between a command and its output, from any editor. A fork is a session that begins as another did, up to where it
// parts from it: its file begins with the other's lines up to there, then a line naming the session they are of, then
// the settings chosen after there, so it is set as the other is.

const SETTINGS = ["model", "thinking", "cache"] as const;
type Settings = Partial<Record<(typeof SETTINGS)[number], string>>;
type Line = Settings & { message?: Message; cwd?: string; forked?: string };

const SESSIONS = join(HOME, "sessions");
const file = (sid: string) => join(SESSIONS, sid + ".jsonl");

const SHOWN = 20_000; // characters of output the model sees per call

const BASH = {
  name: "bash",
  description:
    "Every command starts in the working directory. " +
    `Returns the output, cut at ${SHOWN.toLocaleString("en")} characters, or the image written.`,
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

/** The lines of each session nothing has been said in yet, held until the first message writes them. */
const unborn = new Map<string, Line[]>();

/** A session's lines. One that is not JSON is empty. */
function lines(sid: string): Line[] {
  const held = unborn.get(sid);
  if (held) return held;
  if (!/^[\w-]+$/.test(sid) || !existsSync(file(sid))) throw failure(-32002, `No session ${sid}`);
  return read(file(sid)).trimEnd().split("\n").map(parse);
}

/**
 * Add a line to a session, and describe it as the file now says. The first message makes the file, with the lines held
 * before it, so no file is a session nothing was said in. Nothing else makes it, so a session deleted stays deleted: a
 * line written to a new file would be a session with no beginning, which no model will take and no one can list.
 */
function append(sid: string, ...added: Line[]) {
  const held = unborn.get(sid);
  if (held && !added.some((line) => line.message)) return void held.push(...added);
  let fd: number;
  try {
    fd = openSync(file(sid), held ? "wx" : constants.O_WRONLY | constants.O_APPEND);
  } catch (error: any) {
    throw error.code === "ENOENT" ? failure(-32002, `No session ${sid}`) : error;
  }
  try {
    writeSync(fd, [...(held ?? []), ...added].map((line) => JSON.stringify(line) + "\n").join(""));
    unborn.delete(sid);
  } finally {
    closeSync(fd);
  }
  describe(sid);
}

const cwdOf = (sid: string) => lines(sid)[0].cwd!;

/** How a session began, as a key: the same in each of its forks, as each begins with its first line. */
const origin = (sid: string) => Bun.hash(JSON.stringify(lines(sid)[0])).toString(36);

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
  const level = latest((line) => LEVELS.find((level) => level === line.thinking)) ?? "medium";
  const cache = latest((line) => CACHES.find((cache) => cache === line.cache)) ?? "short";
  return { model, thinking: nearest(model, level), cache };
}

/**
 * Fork a session: a new one, with all its lines or those before a cursor, then the settings chosen after it, so it is
 * set as the session is. A cursor is the place of something the user said: how many lines come before it. Lines are
 * only appended, so a cursor never moves. Like a new session, a fork has no file until something is said in it, so one
 * nothing is said in leaves none.
 */
function fork(sid: string, cursorId?: string) {
  const all = lines(sid);
  const at =
    cursorId == null ? all.length : all.findIndex((line, n) => String(n) === cursorId && line.message?.role === "user");
  if (at < 0) throw failure(-32602, `No cursor ${cursorId}`);
  const forked = randomUUID();
  const chosen = all.slice(at).filter((line) => SETTINGS.some((setting) => setting in line));
  unborn.set(forked, [...all.slice(0, at), { forked: sid }, ...chosen]);
  return forked;
}

// ── The turn ────────────────────────────────────────────────────────────────

/** One reply from the model, streamed to the editor. */
async function ask(sid: string, signal: AbortSignal) {
  const { model, thinking, cache } = settings(sid);
  const tell: Tell = (type, words) => say(sid, type === "text" ? "agent_message" : "agent_thought", words);
  return stream(model, conversation(sid), { origin: origin(sid), thinking, cache, signal }, tell);
}

/** A turn under way: how to stop it, what the user said that it has not read, and how it ends. */
type Turn = { abort: AbortController; said: User[]; done?: Promise<string> };
const turns = new Map<string, Turn>();

/** Write what the user said that the turn has not read, in order. An editor that reads cursors is told. */
const hear = (sid: string, said: User[]) => {
  for (const message of said.splice(0)) {
    const at = lines(sid).length;
    append(sid, { message });
    if (cursors) quote(sid, message, at);
  }
};

/**
 * Read what the user said, ask, run what it asks for, and again until it has nothing to run and nothing more was
 * said. A prompt sent during a turn joins it, and the model reads it once the commands it is running end. A reply is
 * written once its commands end, with what they returned. A request refused with what the commands returned is asked
 * again, with the refusal in its place.
 */
async function turn(sid: string, { abort: { signal }, said }: Turn): Promise<string> {
  let results: Result[] = [];
  try {
    for (;;) {
      hear(sid, said);
      if (signal.aborted) return "cancelled";
      const reply = await ask(sid, signal);
      const again = reply.stopReason === "refused" && results.length > 0;
      const calls = reply.stopReason === "toolUse" ? reply.content.filter((block) => block.type === "toolCall") : [];
      results = [];
      for (const call of calls) if (!signal.aborted) results.push(await run(sid, call, signal));
      append(sid, ...[reply, ...results].map((message) => ({ message })));
      if (again) continue;
      if (reply.stopReason === "error" || reply.stopReason === "refused") throw new Error(reply.errorMessage);
      if (!calls.length && !said.length && !signal.aborted)
        return reply.stopReason === "length" ? "max_tokens" : "end_turn";
    }
  } finally {
    // However the turn ends, it is over first, so a write that fails cannot leave it under way for every prompt after
    // to join; then all that was said is written, so none is left behind.
    turns.delete(sid);
    hear(sid, said);
  }
}

// ── The tool ────────────────────────────────────────────────────────────────

/** The images a model can see, by how their bytes begin. */
const IMAGES: Record<string, RegExp> = {
  "image/png": /^\x89PNG/,
  "image/jpeg": /^\xff\xd8\xff/,
  "image/gif": /^GIF8/,
  "image/webp": /^RIFF....WEBP/s,
};

/** The head of text too long to show whole: its first lines up to SHOWN characters, and where all of it is. */
function head(text: string, path: string) {
  const end = text.lastIndexOf("\n", SHOWN);
  const shown = text.slice(0, end > 0 ? end : SHOWN).replace(/[\ud800-\udbff]$/, ""); // not half a character
  const unshown = (text.length - shown.length).toLocaleString("en");
  return `${shown}\n${bee(`${unshown} characters not shown, full output in ${path}`)}`;
}

/**
 * Run the command a call asks for. Returns what it wrote, as text or an image, and whether it failed. Text cut keeps
 * its file. A call that cannot run throws why.
 */
async function bash(sid: string, call: Call, signal: AbortSignal) {
  const { command } = call.arguments;
  const cwd = cwdOf(sid);
  if (call.name !== BASH.name) throw new Error("tool does not exist");
  if (typeof command !== "string") throw new Error("command is not a string");
  // Every command starts in the working directory, so with it gone none can, and the model is told so, not that there
  // is no bash.
  if (!existsSync(cwd)) throw new Error("working directory does not exist");
  // Written to a file, not a pipe, so the call ends when the command does, whatever it left running.
  const path = join(tmpdir(), `bee-${randomUUID()}`);
  const out = openSync(path, "w");
  // In its own process group, so an interrupt stops all of it.
  const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", out, out], detached: true });
  const interrupt = () => process.kill(-child.pid!, "SIGINT");
  signal.addEventListener("abort", interrupt);
  let cut = false;
  try {
    const [status] = await once(child, "exit");
    const written = readFileSync(path);
    const start = written.subarray(0, 12).toString("latin1");
    const format = isUtf8(written) ? "text" : Object.keys(IMAGES).find((type) => IMAGES[type].test(start));
    const text = written.toString("utf8").trimEnd();
    cut = format === "text" && text.length > SHOWN;
    const content: Result["content"] =
      format === "text"
        ? [{ type: "text", text: cut ? head(text, path) : text }]
        : format
          ? [{ type: "image", data: written.toString("base64"), mimeType: format }]
          : [{ type: "text", text: bee("output is of unsupported format") }];
    return { content, failed: status !== 0 || !format };
  } finally {
    signal.removeEventListener("abort", interrupt);
    closeSync(out);
    if (!cut) rmSync(path);
  }
}

/** Run one tool call, shown to the editor. One that cannot be run is told why, by bee. */
async function run(sid: string, call: Call, signal: AbortSignal) {
  showCall(sid, call);
  const { content, failed } = await bash(sid, call, signal).catch((error: Error) => ({
    content: [{ type: "text" as const, text: bee(error.message) }],
    failed: true,
  }));
  const answer = result(call, content, failed);
  showResult(sid, call, answer);
  return answer;
}

// ── The editor ──────────────────────────────────────────────────────────────
// ACP: JSON-RPC, one message per line, on stdin and stdout.

const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId: string, fields: object) =>
  send({ method: "session/update", params: { sessionId, update: fields } });

const say = (sid: string, who: "user_message" | "agent_message" | "agent_thought", words: string, messageId?: string) =>
  words && update(sid, { sessionUpdate: `${who}_chunk`, messageId, content: { type: "text", text: words } });

/** Whether the editor reads cursors, as it said when it began. */
let cursors = false;

/**
 * Tell the editor something the user said, at line `at`, and, if it reads cursors, the cursor before it: a fork can
 * begin there. Such an editor is told what the user said as bee hears it, so it holds what each cursor is before.
 */
function quote(sid: string, message: User, at: number) {
  const messageId = randomUUID();
  say(sid, "user_message", plain(message.content), messageId);
  if (!cursors) return;
  const anchor = { type: "user_message", messageId, position: "before" };
  update(sid, { sessionUpdate: "cursor_update", cursorId: String(at), capabilities: { fork: {} }, anchor });
}

/** What a text is called: the start of its first line. */
const headline = (text: string) => text.trim().split("\n")[0].slice(0, 80);

/** What a session is called: the headline of the first thing the user said in it since it began, or was forked. */
const title = (all: Line[]) => {
  const since = all.slice(all.findLastIndex((line) => line.forked) + 1).flatMap((line) => line.message ?? []);
  return headline(plain(since.find((message) => message.role === "user")?.content ?? "")) || undefined;
};

/**
 * Tell the editor what the file says of the session: what it is called, and how full the context of the model chosen
 * is, as the last reply counted it. A reply that failed or was stopped first counted nothing.
 */
function describe(sid: string) {
  const messages = conversation(sid);
  const called = title(lines(sid));
  const counted = messages.findLast(
    (message): message is Reply => message.role === "assistant" && message.usage.totalTokens > 0,
  );
  const size = settings(sid).model.contextWindow;
  if (called) update(sid, { sessionUpdate: "session_info_update", title: called });
  if (counted) update(sid, { sessionUpdate: "usage_update", used: counted.usage.totalTokens, size });
}

/** A message's content, as plain text. */
const plain = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");

/** A code block, fenced by more backticks than it holds. */
function fenced(body: string, language = "") {
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((ticks) => ticks[0].length + 1)));
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${body.trim()}\n${fence}` } };
}

/** The command a call asks for, as text. */
const command = (call: Call) => String(call.arguments.command ?? "");

/** Show the editor a call as it starts: its command, called by its headline. */
function showCall(sid: string, call: Call) {
  const shown = { toolCallId: call.id, title: headline(command(call)), kind: "execute" };
  const content = [fenced(command(call), "bash")];
  update(sid, { sessionUpdate: "tool_call", ...shown, status: "in_progress", content, rawInput: call.arguments });
}

/** Show the editor a call as it ended: its command, and what it returned. */
function showResult(sid: string, call: Call, answer: Result) {
  const status = answer.isError ? "failed" : "completed";
  const output = answer.content.map((block) =>
    block.type === "image" ? { type: "content", content: block } : fenced(block.text),
  );
  const content = [fenced(command(call), "bash"), ...output];
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.id,
    status,
    content,
    rawOutput: plain(answer.content),
  });
}

/** Show the editor a conversation it has not seen, as it was shown: a call with what it returned, as it was run. */
function replay(sid: string) {
  const calls = new Map<string, Call>();
  for (const [at, { message }] of lines(sid).entries()) {
    if (!message) continue;
    if (message.role === "user") quote(sid, message, at);
    if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId)!;
      showCall(sid, call);
      showResult(sid, call, message);
    }
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text") say(sid, "agent_message", block.text);
      if (block.type === "thinking") say(sid, "agent_thought", block.thinking);
      if (block.type === "toolCall") calls.set(block.id, block);
    }
  }
}

/** The settings the editor can change. Each one's id is its key in a line. */
function options(sid: string) {
  const { model, thinking } = settings(sid);
  const all = available.map((one) => ({ value: ref(one), name: one.name }));
  const thinkings = levels(model).map((level) => ({ value: level, name: level }));
  return [
    { id: "model", name: "Model", category: "model", currentValue: ref(model), options: all },
    { id: "thinking", name: "Thinking", category: "thought_level", currentValue: thinking, options: thinkings },
  ].map((option) => ({ type: "select", ...option }));
}

/** The sessions, latest first. */
function list(cwd?: string) {
  return readdirSync(SESSIONS)
    .flatMap((name) => /^([\w-]+)\.jsonl$/.exec(name)?.[1] ?? [])
    .map((sessionId) => {
      const all = lines(sessionId);
      const updatedAt = statSync(file(sessionId)).mtime.toISOString();
      return { sessionId, cwd: all[0].cwd!, title: title(all), updatedAt };
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
const parts = (blocks: any[]): User["content"] =>
  blocks.map((block) =>
    block.type === "image"
      ? { type: "text", text: saved(Buffer.from(block.data, "base64"), block.mimeType) }
      : block.type === "resource"
        ? { type: "text", text: `<file uri="${block.resource.uri}">\n${block.resource.text ?? ""}\n</file>` }
        : { type: "text", text: block.text ?? block.uri ?? "" },
  );

/** A session the editor opens, described. */
function open(sessionId: string) {
  describe(sessionId);
  return { sessionId, configOptions: options(sessionId) };
}

const handlers: Record<string, (params: any) => unknown> = {
  initialize: ({ clientCapabilities }) => {
    cursors = !!clientCapabilities?.session?.cursors;
    return {
      protocolVersion: 1,
      agentInfo: { name: "bee", title: "bee", version },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, fork: {} },
      },
    };
  },
  "session/new": ({ cwd }) => {
    const sessionId = randomUUID();
    unborn.set(sessionId, [beginning(cwd)]);
    return open(sessionId);
  },
  "session/resume": ({ sessionId }) => open(sessionId),
  "session/load": ({ sessionId }) => {
    replay(sessionId);
    return open(sessionId);
  },
  "session/fork": ({ sessionId, cursorId }) => open(fork(sessionId, cursorId)),
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
  const { id, method, params } = parse(line);
  if (!method) continue; // a reply, and we ask nothing; or not JSON
  const reply = (answer: object) => id !== undefined && send({ id, ...answer });
  const unknown = () => Promise.reject(failure(-32601, `No method ${method}`));
  Promise.resolve(params ?? {})
    .then(Object.hasOwn(handlers, method) ? handlers[method] : unknown)
    .then(
      (result) => reply({ result: result ?? {} }),
      (error) => reply({ error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } }),
    );
}
await hangUp();
