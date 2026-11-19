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
import { setTimeout as sleep } from "node:timers/promises";
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

// ── Said ────────────────────────────────────────────────────────────────────
// What a session's file holds: how it began, and what was said in it, by the user, a model and a command. What only a
// model's provider can read is `sealed`, as the provider gave it: its thinking, and the ids it gave.

type Text = { type: "text"; text: string; sealed?: any };
type Image = { type: "image"; data: string; mimeType: string };
type Thinking = { type: "thinking"; text: string; sealed?: any; redacted?: boolean };
type Call = { type: "call"; id: string; name: string; arguments: Record<string, unknown>; sealed?: any };
type Tool = { name: string; description: string; parameters: object };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** How the session began: where, the prompt, and the tools. */
type Began = { cwd: string; prompt: string; tools: Tool[]; timestamp: number };
type User = { content: (Text | Image)[]; timestamp: number };
/**
 * What a model said. `end`: how it ended, if not of itself: cut at its longest, stopped, failed, or refused, the
 * request being refused as it was, so the same again would be refused again. `why`: the error it ended with, and
 * `status`: the HTTP status the provider answered it with, if it answered.
 */
type Reply = {
  provider: string;
  model: string;
  content: (Text | Thinking | Call)[];
  usage: Usage;
  timestamp: number;
  end?: "cut" | "stopped" | "failed" | "refused";
  why?: string;
  status?: number;
};
/** What a command returned, to the call that asked for it. */
type Result = { call: string; content: (Text | Image)[]; failed: boolean; timestamp: number };
/** What is said once the session has begun. */
type Said = { user: User } | { reply: Reply } | { result: Result };

/** What bee says in what a command returned, set apart from all the command wrote. */
const bee = (words: string) => `(bee: ${words})`;

const user = (content: User["content"]): User => ({ content, timestamp: Date.now() });
/** Whether content says nothing: no image, and no text but blanks. */
const silent = (content: (Text | Image)[]) => content.every((block) => block.type === "text" && !block.text.trim());
const result = (call: Call, content: Result["content"], failed: boolean): Result => ({
  call: call.id,
  content,
  failed,
  timestamp: Date.now(),
});

// ── The APIs ────────────────────────────────────────────────────────────────
// bee speaks to two providers itself, each in its API: Anthropic, in its Messages, and Codex, in OpenAI's Responses.
// Each lists the models it has, makes a request of the conversation, and a reply of the events it streams back.

/** The thinking levels the APIs take, least first. A model has those its provider lists. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CACHES = ["none", "short", "long"] as const;
type Level = (typeof LEVELS)[number];
type Cache = (typeof CACHES)[number];

/** A provider's key, and where it is. */
type Key = { apiKey: string; baseUrl: string };

/** A model as its provider lists it: its levels, least first, and `listed`, all the provider says of it. */
type Listed = { id: string; name: string; contextWindow: number; levels: Level[]; listed: any };

/** A model, with its provider's key. */
type Model = Listed & Key & { provider: string };

/** `origin`: how the session began, the same in each of its forks. Codex keeps its cache by it. */
type Options = { origin: string; thinking: Level; cache: Cache; signal: AbortSignal };
type Tell = (type: "text" | "thinking", words: string) => void;
type Api = {
  /** Where the provider is, unless models.json says. */
  baseUrl: string;
  /** How to ask the provider for its models. */
  listing(key: Key): { url: string; headers: Record<string, string> };
  /** The models in what it listed, each with its levels. */
  models(listing: any): Listed[];
  request(
    model: Model,
    began: Began,
    said: Said[],
    options: Options,
  ): { url: string; headers: Record<string, string>; body: object };
  /** Fills the reply as the events come, with how it ended if not of itself. A reply that fails throws. */
  read(incoming: AsyncIterable<any>, reply: Reply, tell: Tell): Promise<void>;
};

/** One reply from a model, its words and thoughts told as they come. One that fails or is stopped says so. */
async function stream(model: Model, began: Began, said: Said[], chosen: Options, tell: Tell): Promise<Reply> {
  const api = PROVIDERS[model.provider];
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const reply: Reply = { provider: model.provider, model: model.id, content: [], usage, timestamp: Date.now() };
  try {
    const { url, headers, body } = api.request(model, began, sendable(said), chosen);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: chosen.signal,
    });
    const { status } = response;
    if (!response.ok) throw Object.assign(new Error(`${status} ${await response.text()}`), { status });
    await api.read(events(response.body!), reply, tell);
  } catch (error: any) {
    reply.end = chosen.signal.aborted ? "stopped" : REFUSALS.includes(error.status) ? "refused" : "failed";
    reply.why = error.message;
    reply.status = error.status;
  }
  return reply;
}

/** The statuses of a request refused as it was: sent the same again, it would be refused again. */
const REFUSALS = [400, 413];

/**
 * Whether a reply failed only for now: the provider did not answer, as the connection or its stream broke, or it
 * answered to ask later, as too many requests or its own failure.
 */
const later = ({ end, status = 0 }: Reply) => end === "failed" && (!status || status === 429 || status >= 500);

/** How many times a reply that failed for now is asked again: after 1 second, then each time twice as long. */
const TRIES = 6;

/**
 * The conversation as an API takes it: a reply that failed or was stopped is left out, with what answered it, a call
 * nothing answered is answered as not run, and an answer that says nothing says so. An answer a request was refused
 * with, one sent since the last reply, is the refusal, so no session holds one every request after is refused for.
 */
function sendable(conversation: Said[]): Said[] {
  const sent: Said[] = [];
  const unanswered = new Map<string, Call>();
  let since = 0; // where what was sent since the last reply begins
  const close = () => {
    for (const call of unanswered.values())
      sent.push({ result: result(call, [{ type: "text", text: bee("not run") }], true) });
    unanswered.clear();
  };
  for (const said of conversation) {
    if ("result" in said) {
      const { result } = said;
      const answer = silent(result.content)
        ? { result: { ...result, content: [{ type: "text" as const, text: bee("no output") }] } }
        : said;
      if (unanswered.delete(result.call)) sent.push(answer);
      continue;
    }
    close();
    if ("reply" in said) {
      const { reply } = said;
      if (reply.end === "refused") for (let n = since; n < sent.length; n++) sent[n] = refused(sent[n], reply.why!);
      if (["failed", "stopped", "refused"].includes(reply.end!)) continue;
      since = sent.length + 1;
      for (const block of reply.content) if (block.type === "call") unanswered.set(block.id, block);
    }
    sent.push(said);
  }
  close();
  return sent;
}

/** What was said, as a request was refused with it: what a command returned is the refusal. */
const refused = (said: Said, why: string): Said =>
  "result" in said
    ? { result: { ...said.result, content: [{ type: "text", text: bee(`provider refused: ${why}`) }] } }
    : said;

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

/** Whether a reply is of a model's provider, so its thinking and the ids it gave can be sent back to it. */
const native = (reply: Reply, model: Model) => reply.provider === model.provider;

/** A tool's result as one text, if it is only text. */
const textual = (content: Result["content"]) =>
  content.every((block): block is Text => block.type === "text")
    ? content.map((block) => block.text).join("\n")
    : undefined;

/** A tool call's id as an API takes it: letters, digits, _ and -, at most 64. */
const callId = (id: string) => id.replace(/[^\w-]/g, "_").slice(0, 64);

/** How a reply ends, by Anthropic's reason: of itself, or cut at its longest. */
const ENDS: Record<string, Reply["end"]> = {
  end_turn: undefined,
  pause_turn: undefined,
  stop_sequence: undefined,
  tool_use: undefined,
  max_tokens: "cut",
};

/** Whether an Anthropic key is an OAuth token, which the API takes only from Claude Code. */
const oauth = (apiKey: string) => apiKey.includes("sk-ant-oat");

/** Anthropic's headers for a key. */
const anthropicHeaders = (apiKey: string) => ({
  "anthropic-version": "2023-06-01",
  ...(oauth(apiKey)
    ? { authorization: `Bearer ${apiKey}`, "anthropic-beta": "oauth-2025-04-20" }
    : { "x-api-key": apiKey }),
});

/**
 * Anthropic's Messages. A model thinks at the efforts it lists, and off if it lists that. The prompt with the tool, and
 * the conversation, are each cached to their end. An OAuth token is sent as Claude Code.
 */
const anthropic: Api = {
  baseUrl: "https://api.anthropic.com",
  listing: ({ baseUrl, apiKey }) => ({ url: `${baseUrl}/v1/models?limit=1000`, headers: anthropicHeaders(apiKey) }),
  models: (listing) =>
    (listing.data ?? []).map((listed: any) => {
      const { thinking, effort } = listed.capabilities;
      const has = (level: Level) => (level === "off" ? thinking?.types?.disabled : effort?.[level])?.supported;
      const { id, display_name: name, max_input_tokens: contextWindow } = listed;
      return { id, name, contextWindow, levels: LEVELS.filter(has), listed };
    }),

  request(model, began, conversation, { thinking, cache }) {
    const mark =
      cache === "none" ? {} : { cache_control: { type: "ephemeral", ...(cache === "long" && { ttl: "1h" }) } };
    const media = (content: User["content"]) =>
      content
        .filter((block) => block.type === "image" || block.text.trim())
        .map((block) =>
          block.type === "image"
            ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
            : { type: "text", text: block.text },
        );
    const block = (said: Text | Thinking | Call, reply: Reply): object[] => {
      if (said.type === "text") return said.text.trim() ? [{ type: "text", text: said.text }] : [];
      if (said.type === "call")
        return [{ type: "tool_use", id: callId(said.id), name: said.name, input: said.arguments }];
      if (!native(reply, model) || !said.sealed) return [];
      return said.redacted
        ? [{ type: "redacted_thinking", data: said.sealed }]
        : [{ type: "thinking", thinking: said.text, signature: said.sealed }];
    };
    const wire = (said: Said): { role: string; content: object[] } => {
      if ("reply" in said)
        return { role: "assistant", content: said.reply.content.flatMap((each) => block(each, said.reply)) };
      if ("user" in said) return { role: "user", content: media(said.user.content) };
      const { call, content, failed } = said.result;
      const answer = textual(content) ?? media(content);
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: callId(call), content: answer, is_error: failed }],
      };
    };
    // One message for each turn of who speaks, the last cached to its end.
    const dialogue: { role: string; content: object[] }[] = [];
    for (const { role, content } of conversation.map(wire).filter((message) => message.content.length)) {
      if (dialogue.at(-1)?.role === role) dialogue.at(-1)!.content.push(...content);
      else dialogue.push({ role, content });
    }
    Object.assign(dialogue.at(-1)?.content.at(-1) ?? {}, mark);
    const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
    const reasoning =
      thinking === "off"
        ? { thinking: { type: "disabled" } }
        : { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: thinking } };
    return {
      url: `${model.baseUrl}/v1/messages`,
      headers: anthropicHeaders(model.apiKey),
      body: {
        model: model.id,
        max_tokens: model.listed.max_tokens,
        stream: true,
        system: [...(oauth(model.apiKey) ? [identity] : []), { type: "text", text: began.prompt, ...mark }],
        tools: began.tools.map(({ name, description, parameters }) => ({
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
    };
    /** A block as it starts, as bee keeps it. */
    const started = (block: any): Reply["content"][number] | undefined => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "thinking") return { type: "thinking", text: block.thinking, sealed: block.signature };
      if (block.type === "redacted_thinking") return { type: "thinking", text: "", sealed: block.data, redacted: true };
      if (block.type === "tool_use") return { type: "call", id: block.id, name: block.name, arguments: {} };
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
          if (delta.type === "text_delta" || delta.type === "thinking_delta") {
            under.block.text += delta.text ?? delta.thinking;
            tell(under.block.type, delta.text ?? delta.thinking);
          }
          if (delta.type === "signature_delta") under.block.sealed = (under.block.sealed ?? "") + delta.signature;
          if (delta.type === "input_json_delta") under.json += delta.partial_json;
          break;
        case "content_block_stop":
          if (under?.block.type === "call") under.block.arguments = JSON.parse(under.json || "{}");
          underway.delete(event.index);
          break;
        case "message_delta":
          stopped = delta;
          count(event.usage);
          break;
        case "message_stop":
          if (!(stopped.stop_reason! in ENDS))
            throw new Error(stopped.stop_details?.explanation ?? `The model stopped: ${stopped.stop_reason}`);
          reply.end = ENDS[stopped.stop_reason!];
          return;
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

/** Codex's headers for a key. */
const codexHeaders = (apiKey: string) => ({ authorization: `Bearer ${apiKey}`, "chatgpt-account-id": account(apiKey) });

/**
 * OpenAI's Responses, as Codex takes them. Its models are those it lists to be shown, at the efforts each lists. It
 * lists a model only to a client as new as the model asks, so bee says it is newer than any. How the session began is
 * the cache's key, so a fork begins cached.
 */
const codex: Api = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  listing: ({ baseUrl, apiKey }) => ({
    url: `${baseUrl}/models?client_version=999.0.0`,
    headers: codexHeaders(apiKey),
  }),
  models: (listing) =>
    (listing.models ?? [])
      .filter((listed: any) => listed.visibility === "list")
      .map((listed: any) => {
        const efforts = listed.supported_reasoning_levels.map((level: any) => level.effort);
        const { slug: id, display_name: name, context_window: contextWindow } = listed;
        return { id, name, contextWindow, levels: LEVELS.filter((level) => efforts.includes(level)), listed };
      }),

  request(model, began, conversation, { origin, thinking, cache }) {
    const media = (content: User["content"]) =>
      content.map((block) =>
        block.type === "text"
          ? { type: "input_text", text: block.text }
          : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` },
      );
    const block = (said: Text | Thinking | Call, reply: Reply): object[] => {
      const sealed = native(reply, model) && said.sealed;
      if (said.type === "thinking") return sealed ? [sealed] : [];
      if (said.type === "call") {
        const { id, name, arguments: input } = said;
        return [
          {
            type: "function_call",
            ...(sealed && { id: sealed }),
            call_id: callId(id),
            name,
            arguments: JSON.stringify(input),
          },
        ];
      }
      if (!said.text.trim()) return [];
      if (!sealed) return [{ role: "assistant", content: said.text }];
      const content = [{ type: "output_text", text: said.text, annotations: [] }];
      return [{ type: "message", role: "assistant", content, status: "completed", ...sealed }];
    };
    const wire = (said: Said): object[] => {
      if ("reply" in said) return said.reply.content.flatMap((each) => block(each, said.reply));
      if ("user" in said) return [{ role: "user", content: media(said.user.content) }];
      const output = textual(said.result.content) ?? media(said.result.content);
      return [{ type: "function_call_output", call_id: callId(said.result.call), output }];
    };
    return {
      url: `${model.baseUrl}/responses`,
      headers: {
        ...codexHeaders(model.apiKey),
        "openai-beta": "responses=experimental",
        originator: "bee",
        "session-id": origin,
        accept: "text/event-stream",
      },
      body: {
        model: model.id,
        store: false,
        stream: true,
        instructions: began.prompt,
        input: conversation.flatMap(wire),
        tools: began.tools.map(({ name, description, parameters }) => ({
          type: "function",
          name,
          description,
          parameters,
        })),
        include: ["reasoning.encrypted_content"],
        ...(cache !== "none" && { prompt_cache_key: origin }),
        reasoning: { effort: thinking, summary: "auto" },
      },
    };
  },

  async read(incoming, reply, tell) {
    /** An item as it is done, as bee keeps it. */
    const done = (item: any): Reply["content"][number] | undefined => {
      if (item.type === "reasoning")
        return { type: "thinking", text: item.summary.map((part: any) => part.text).join("\n\n"), sealed: item };
      if (item.type === "message") {
        const text = item.content.map((part: any) => part.text ?? part.refusal).join("");
        return { type: "text", text, sealed: { id: item.id, phase: item.phase ?? undefined } };
      }
      if (item.type === "function_call") {
        const { call_id: id, name, arguments: input } = item;
        return { type: "call", id, name, arguments: JSON.parse(input || "{}"), sealed: item.id };
      }
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
        const { input_tokens, input_tokens_details: cached = {}, output_tokens } = response.usage;
        const cacheRead = cached.cached_tokens ?? 0;
        const cacheWrite = cached.cache_write_tokens ?? 0;
        reply.usage = { input: input_tokens - cacheRead - cacheWrite, output: output_tokens, cacheRead, cacheWrite };
        if (type === "response.completed") return;
        const reason = response.incomplete_details?.reason;
        if (reason !== "max_output_tokens") throw new Error(`The reply is incomplete: ${reason}`);
        reply.end = "cut";
        return;
      }
    }
    throw new Error("The stream ended before the reply did");
  },
};

/** The providers bee speaks to, by the names models.json gives them. */
const PROVIDERS: Record<string, Api> = { anthropic, "openai-codex": codex };

// ── Models ──────────────────────────────────────────────────────────────────

/** models.json: {"providers": {"anthropic": {"apiKey": "...", "baseUrl": "..."}}}. */
const MODELS = join(HOME, "models.json");
const keys: Record<string, { apiKey: string; baseUrl?: string }> = JSON.parse(read(MODELS, "{}")).providers ?? {};

/**
 * What each provider listed last. bee starts with it, and asks again without waiting, for the next start; a provider
 * it has no models of yet, it waits for.
 */
const CATALOG = join(HOME, "catalog");
const catalog = (provider: string) => join(CATALOG, `${provider}.json`);

async function fetchCatalog(provider: string, key: Key) {
  const { url, headers } = PROVIDERS[provider].listing(key);
  const response = await fetch(url, { headers });
  if (!response.ok) return;
  const json = JSON.stringify(await response.json());
  const temporary = `${catalog(provider)}.${process.pid}`;
  mkdirSync(CATALOG, { recursive: true });
  writeFileSync(temporary, json);
  renameSync(temporary, catalog(provider));
}

async function listed(provider: string, key: Key): Promise<Model[]> {
  const fetched = fetchCatalog(provider, key).catch(() => {});
  const models = () => PROVIDERS[provider].models(JSON.parse(read(catalog(provider), "{}")));
  if (!models().length) await fetched;
  return models().map((model) => ({ ...model, ...key, provider }));
}

const ref = (model: Model) => `${model.provider}/${model.id}`;
const byName = new Intl.Collator("en", { numeric: true }).compare;

/** The models of every provider bee speaks to that has a key, in order of their names. */
const providers = await Promise.all(
  Object.entries(keys)
    .filter(([provider]) => provider in PROVIDERS)
    .map(([provider, { apiKey, baseUrl }]) =>
      listed(provider, { apiKey, baseUrl: baseUrl ?? PROVIDERS[provider].baseUrl }),
    ),
);
const available = providers.flat().sort((a, b) => byName(ref(a), ref(b)));

/** The level a model has that is nearest the one asked for: it, or the nearest above, or else below. */
function nearest(model: Model, level: Level) {
  const at = LEVELS.indexOf(level);
  return [...LEVELS.slice(at), ...LEVELS.slice(0, at).reverse()].find((one) => model.levels.includes(one))!;
}

// ── Sessions ────────────────────────────────────────────────────────────────
// A session is a file of lines, written as things happen, each one thing: how it began, something said, a setting
// chosen, or the session it was forked from. Lines are only appended, so every request begins with the last one, and
// the provider's cache of it holds. The first line is how the session began: its directory, the prompt and the tools,
// with the settings in settings.json. The file is made when the first thing is said in it. A reply that runs commands
// is written with what they returned, in one write, so nothing comes between a command and its output, from any
// editor. A fork is a session that begins as another did, up to where it parts from it: its file begins with the
// other's lines up to there, then a line naming the session they are of, then the settings chosen after there, so it
// is set as the other is.

const SETTINGS = ["model", "thinking", "cache"] as const;
type Settings = Partial<Record<(typeof SETTINGS)[number], string>>;
type Line = Settings & { began?: Began; user?: User; reply?: Reply; result?: Result; forked?: string };

/** Whether a line is something said. */
const says = (line: Line): line is Line & Said => !!(line.user || line.reply || line.result);

const SESSIONS = join(HOME, "sessions");
const file = (sid: string) => join(SESSIONS, sid + ".jsonl");

const SHOWN = 20_000; // characters of output the model sees per call
const TIMEOUT = 120; // seconds a command runs before it is stopped

const BASH = {
  name: "bash",
  description:
    "Every command starts in the working directory. " +
    `Returns the output, cut at ${SHOWN.toLocaleString("en")} characters, or the image written. ` +
    `Timeout at ${TIMEOUT} seconds.`,
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
  began: {
    cwd,
    prompt: `\nYou are an agent in the bee harness.\n\n${instructions(cwd)}`.trimEnd(),
    tools: [BASH],
    timestamp: Date.now(),
  },
});

/** The lines of each session nothing has been said in yet, held until the first thing said writes them. */
const unborn = new Map<string, Line[]>();

/** A session's file as it was written: nothing, for one nothing has been said in. */
const written = (sid: string) => (existsSync(file(sid)) ? readFileSync(file(sid)) : Buffer.alloc(0));

/** The line of what was written that begins at `at`. */
const lineAt = (all: Buffer, at: number): Line => parse(all.toString("utf8", at, all.indexOf("\n", at)));

/**
 * The lines of each session worked in, as last read, and how many bytes they were. A session is only appended to, so
 * a file as long holds the same lines.
 */
const kept = new Map<string, { size: number; lines: Line[] }>();

/** A session's lines. One that is not JSON is empty. */
function lines(sid: string): Line[] {
  const held = unborn.get(sid);
  if (held) return held;
  if (!/^[\w-]+$/.test(sid) || !existsSync(file(sid))) throw failure(-32002, `No session ${sid}`);
  const { size } = statSync(file(sid));
  if (kept.get(sid)?.size !== size) kept.set(sid, { size, lines: read(file(sid)).trimEnd().split("\n").map(parse) });
  return kept.get(sid)!.lines;
}

/**
 * Add a line to a session, and describe it as the file now says. The first thing said makes the file, with the lines
 * held before it, so no file is a session nothing was said in. Nothing else makes it, so a session deleted stays
 * deleted: a line written to a new file would be a session with no beginning, which no model will take and no one can
 * list.
 */
function append(sid: string, ...added: Line[]) {
  const held = unborn.get(sid);
  if (held && !added.some(says)) return void held.push(...added);
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

/** How a session began. */
const beganOf = (sid: string) => lines(sid)[0].began!;

/** How a session began, as a key: the same in each of its forks, as each begins with its first line. */
const origin = (sid: string) => Bun.hash(JSON.stringify(lines(sid)[0])).toString(36);

/** What was said in a session. */
const conversation = (sid: string): Said[] => lines(sid).filter(says);

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
  const at = cursorId == null ? all.length : all.findIndex((line, n) => String(n) === cursorId && line.user);
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
  return stream(model, beganOf(sid), conversation(sid), { origin: origin(sid), thinking, cache, signal }, tell);
}

/** A turn under way: how to stop it, what the user said that it has not read, and how it ends. */
type Turn = { abort: AbortController; said: User[]; done?: Promise<string> };
const turns = new Map<string, Turn>();

/**
 * Write what the user said that the turn has not read, in order, but for what says nothing. An editor that reads
 * cursors is told.
 */
const hear = (sid: string, said: User[]) => {
  for (const told of said.splice(0).filter((told) => !silent(told.content))) {
    const at = lines(sid).length;
    append(sid, { user: told });
    if (cursors) quote(sid, told, at);
  }
};

/** Whether something said waits for the model to answer it: the last thing sent is not a reply. */
function waiting(sid: string) {
  const last = sendable(conversation(sid)).at(-1);
  return !!last && !("reply" in last);
}

/**
 * Read what the user said, and while something waits for an answer, ask, run what it asks for, and again until it has
 * nothing to run and nothing more was said. A prompt that says nothing asks again what a turn failed or was stopped
 * before answering. A prompt sent during a turn joins it, and the model reads it once the commands it is running end. A
 * reply is written once its commands end, with what they returned. A request refused with what the commands returned is
 * asked again, with the refusal in its place. One that failed for now is asked again, the same, a few times, each
 * later.
 */
async function turn(sid: string, { abort: { signal }, said }: Turn): Promise<string> {
  let results: Result[] = [];
  let tries = 0; // how many times in a row a reply failed for now
  try {
    for (;;) {
      hear(sid, said);
      if (signal.aborted) return "cancelled";
      if (!waiting(sid)) return "end_turn";
      const reply = await ask(sid, signal);
      const again = reply.end === "refused" && results.length > 0;
      const calls = reply.end ? [] : reply.content.filter((block) => block.type === "call");
      results = [];
      for (const call of calls) if (!signal.aborted) results.push(await run(sid, call, signal));
      append(sid, { reply }, ...results.map((result) => ({ result })));
      if (again) continue;
      tries = later(reply) ? tries + 1 : 0;
      if (tries && tries <= TRIES) {
        await sleep(1000 * 2 ** (tries - 1), null, { signal }).catch(() => {});
        continue;
      }
      if (reply.end === "failed" || reply.end === "refused") throw new Error(reply.why);
      if (!calls.length && !said.length && !signal.aborted) return reply.end === "cut" ? "max_tokens" : "end_turn";
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
  const { cwd } = beganOf(sid);
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
  // Stopped as the user stops it, at the timeout too.
  const timeout = AbortSignal.timeout(TIMEOUT * 1000);
  const stop = AbortSignal.any([signal, timeout]);
  const interrupt = () => process.kill(-child.pid!, "SIGINT");
  stop.addEventListener("abort", interrupt);
  let cut = false;
  try {
    const [status] = await once(child, "exit");
    const written = readFileSync(path);
    const start = written.subarray(0, 12).toString("latin1");
    const format = isUtf8(written) ? "text" : Object.keys(IMAGES).find((type) => IMAGES[type].test(start));
    const text = written.toString("utf8").trimEnd();
    cut = format === "text" && text.length > SHOWN;
    // What bee says of how the command ended is the last line of what it returned.
    const ended = timeout.aborted ? bee("timeout") : "";
    const told = (text: string) => ({ type: "text" as const, text: [text, ended].filter(Boolean).join("\n") });
    const content: Result["content"] =
      format === "text"
        ? [told(cut ? head(text, path) : text)]
        : format
          ? [{ type: "image", data: written.toString("base64"), mimeType: format }, ...(ended ? [told("")] : [])]
          : [told(bee("output is of unsupported format"))];
    return { content, failed: status !== 0 || !format };
  } finally {
    stop.removeEventListener("abort", interrupt);
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
function quote(sid: string, told: User, at: number) {
  const messageId = randomUUID();
  say(sid, "user_message", plain(told.content), messageId);
  if (!cursors) return;
  const anchor = { type: "user_message", messageId, position: "before" };
  update(sid, { sessionUpdate: "cursor_update", cursorId: String(at), capabilities: { fork: {} }, anchor });
}

/** What a text is called: the start of its first line. */
const headline = (text: string) => text.trim().split("\n")[0].slice(0, 80);

/**
 * What a session is called: the headline of the first thing the user said in it since it began, or was forked. Each
 * line is one thing, by the key it begins with, so the lines that say are found by how they begin, and only the one
 * said is read.
 */
function title(all: Buffer) {
  const said = all.indexOf('\n{"user":', all.lastIndexOf('\n{"forked":') + 1);
  return said < 0 ? undefined : headline(plain(lineAt(all, said + 1).user!.content)) || undefined;
}

/**
 * Tell the editor what the file says of the session: what it is called, and how full the context of the model chosen
 * is, as the last reply counted it. A reply that failed or was stopped first counted nothing.
 */
function describe(sid: string) {
  const all = lines(sid);
  const called = title(written(sid));
  const used = all.map((line) => (line.reply ? counted(line.reply.usage) : 0)).findLast(Boolean);
  const size = settings(sid).model.contextWindow;
  if (called) update(sid, { sessionUpdate: "session_info_update", title: called });
  if (used) update(sid, { sessionUpdate: "usage_update", used, size });
}

/** How many tokens a request was, and its reply. */
const counted = ({ input, output, cacheRead, cacheWrite }: Usage) => input + output + cacheRead + cacheWrite;

/** What was said, as plain text. */
const plain = (content: { type: string; text?: string }[]) => content.map((block) => block.text ?? "").join("");

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
  const status = answer.failed ? "failed" : "completed";
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
  for (const [at, { user, reply, result }] of lines(sid).entries()) {
    if (user) quote(sid, user, at);
    if (result) {
      const call = calls.get(result.call)!;
      showCall(sid, call);
      showResult(sid, call, result);
    }
    for (const block of reply?.content ?? []) {
      if (block.type === "text") say(sid, "agent_message", block.text);
      if (block.type === "thinking") say(sid, "agent_thought", block.text);
      if (block.type === "call") calls.set(block.id, block);
    }
  }
}

/** The settings, each as the editor changes it. Each one's id is its key in a line. */
function options(sid: string) {
  const { model, thinking, cache } = settings(sid);
  const models = available.map((one) => ({ value: ref(one), name: one.name }));
  const [levels, caches] = [model.levels, CACHES].map((values) => values.map((value) => ({ value, name: value })));
  return [
    { id: "model", name: "Model", category: "model", currentValue: ref(model), options: models },
    { id: "thinking", name: "Thinking", category: "thought_level", currentValue: thinking, options: levels },
    { id: "cache", name: "Cache", currentValue: cache, options: caches },
  ].map((option) => ({ type: "select", ...option }));
}

/** The sessions, latest first. */
function list(cwd?: string) {
  return readdirSync(SESSIONS)
    .flatMap((name) => /^([\w-]+)\.jsonl$/.exec(name)?.[1] ?? [])
    .map((sessionId) => {
      const all = written(sessionId);
      const updatedAt = statSync(file(sessionId)).mtime.toISOString();
      return { sessionId, cwd: lineAt(all, 0).began!.cwd, title: title(all), updatedAt };
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
    const told = user(parts(prompt));
    let under = turns.get(sessionId);
    if (under) under.said.push(told);
    else {
      under = { abort: new AbortController(), said: [told] };
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
