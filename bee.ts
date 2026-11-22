#!/usr/bin/env bun
// bee: minimal ACP agent harness over stdio with a single bash tool and append-only JSONL sessions.
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

// stdout is reserved for ACP JSON-RPC framing.
console.log = console.error;

const HOME = process.env.BEE_HOME ?? join(homedir(), ".bee", "agent");
const MODELS_FILE = join(HOME, "models.json");
const CATALOG_DIR = join(HOME, "catalog");
const SESSIONS_DIR = join(HOME, "sessions");

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
const readText = (path: string, fallback = "") => (existsSync(path) ? readFileSync(path, "utf8") : fallback);

function parseJson(line: string) {
  try {
    return JSON.parse(line) ?? {};
  } catch {
    return {};
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

type TextBlock = { type: "text"; text: string; sealed?: any };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ThinkingBlock = { type: "thinking"; text: string; sealed?: any; redacted?: boolean };
type ToolCall = { type: "call"; id: string; name: string; arguments: Record<string, unknown>; sealed?: any };
type ToolSchema = { name: string; description: string; parameters: object };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

type SessionHeader = { cwd: string; prompt: string; tools: ToolSchema[]; timestamp: number };
type UserMessage = { content: (TextBlock | ImageBlock)[]; timestamp: number };
type AssistantReply = {
  provider: string;
  model: string;
  content: (TextBlock | ThinkingBlock | ToolCall)[];
  usage: Usage;
  timestamp: number;
  end?: "cut" | "stopped" | "failed" | "refused";
  why?: string;
  status?: number;
};
type ToolResult = { call: string; content: (TextBlock | ImageBlock)[]; failed: boolean; timestamp: number };
type MessageEntry = { user: UserMessage } | { reply: AssistantReply } | { result: ToolResult };

const CONFIG_KEYS = ["model", "thinking", "cache"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];
type ConfigValues = Partial<Record<ConfigKey, string>>;
type SessionLine = ConfigValues & {
  began?: SessionHeader;
  user?: UserMessage;
  reply?: AssistantReply;
  result?: ToolResult;
  forked?: string;
};

const THINKING_LEVELS = ["off", "on", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CACHE_MODES = ["none", "short", "long"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type CacheMode = (typeof CACHE_MODES)[number];

type ProviderConfig = { apiKey: string; baseUrl: string };
type ModelMeta = { id: string; name: string; contextWindow: number; levels: ThinkingLevel[]; listed: any };
type Model = ModelMeta & ProviderConfig & { provider: string };
type RequestOptions = { origin: string; thinking: ThinkingLevel; cache: CacheMode; signal: AbortSignal };
type StreamCallback = (kind: "text" | "thinking", delta: string) => void;

type ProviderApi = {
  baseUrl: string;
  listing(config: ProviderConfig): { url: string; headers: Record<string, string> };
  models(payload: any): ModelMeta[];
  request(
    model: Model,
    header: SessionHeader,
    history: MessageEntry[],
    options: RequestOptions,
  ): { url: string; headers: Record<string, string>; body: object };
  read(events: AsyncIterable<any>, reply: AssistantReply, onDelta: StreamCallback): Promise<void>;
};

const isMessageEntry = (line: SessionLine): line is SessionLine & MessageEntry =>
  Boolean(line.user || line.reply || line.result);
const isEmptyContent = (content: (TextBlock | ImageBlock)[]) =>
  content.every((block) => block.type === "text" && !block.text.trim());
const notice = (text: string) => `(bee: ${text})`;
const makeUserMessage = (content: UserMessage["content"]): UserMessage => ({ content, timestamp: Date.now() });
const makeToolResult = (call: ToolCall, content: ToolResult["content"], failed: boolean): ToolResult => ({
  call: call.id,
  content,
  failed,
  timestamp: Date.now(),
});

// ── Bash Tool ───────────────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT = 30;
const KILL_GRACE_MS = 1_000;
const MAX_TIMER_MS = 0x7fffffff;

const BASH_TOOL: ToolSchema = {
  name: "bash",
  description:
    "Run a shell command in the working directory. " +
    `Output is truncated at ${MAX_OUTPUT_CHARS.toLocaleString("en")} characters (full output saved to a file), or returned as an image. ` +
    `Default timeout is ${DEFAULT_TIMEOUT}s; pass timeout (seconds) for longer or shorter commands.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number", description: "Timeout in seconds" },
    },
    required: ["command"],
  },
};

const IMAGE_SIGNATURES: Record<string, RegExp> = {
  "image/png": /^\x89PNG/,
  "image/jpeg": /^\xff\xd8\xff/,
  "image/gif": /^GIF8/,
  "image/webp": /^RIFF....WEBP/s,
};

function truncateOutput(text: string, path: string) {
  const cut = text.lastIndexOf("\n", MAX_OUTPUT_CHARS);
  // Avoid splitting a UTF-16 surrogate pair at the slice boundary.
  const shown = text.slice(0, cut > 0 ? cut : MAX_OUTPUT_CHARS).replace(/[\ud800-\udbff]$/, "");
  const omitted = (text.length - shown.length).toLocaleString("en");
  return `${shown}\n${notice(`${omitted} characters not shown, full output in ${path}`)}`;
}

async function runBash(sid: string, call: ToolCall, signal: AbortSignal) {
  const { command, timeout = DEFAULT_TIMEOUT } = call.arguments;
  const { cwd } = sessionHeader(sid);
  if (call.name !== BASH_TOOL.name) throw new Error("tool does not exist");
  if (typeof command !== "string") throw new Error("command must be a string");
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    throw new Error("timeout must be a positive number");
  if (!existsSync(cwd)) throw new Error("working directory does not exist");

  // Redirect stdout/stderr to a file so detached child processes don't keep pipes open past shell exit.
  const outPath = join(tmpdir(), `bee-${randomUUID()}`);
  const outFd = openSync(outPath, "w");
  const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", outFd, outFd], detached: true });

  const killGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {}
  };

  let timedOut = false;
  let stopped = false;
  let graceTimer: Timer | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    killGroup("SIGINT");
    graceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
  };

  const timeoutTimer = setTimeout(
    () => {
      timedOut = true;
      stop();
    },
    Math.min(timeout * 1000, MAX_TIMER_MS),
  );
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();

  let truncated = false;
  try {
    const [status] = await once(child, "exit");
    const raw = readFileSync(outPath);
    const magic = raw.subarray(0, 12).toString("latin1");
    const format = isUtf8(raw)
      ? "text"
      : Object.keys(IMAGE_SIGNATURES).find((mime) => IMAGE_SIGNATURES[mime].test(magic));
    const text = raw.toString("utf8").trimEnd();
    truncated = format === "text" && text.length > MAX_OUTPUT_CHARS;

    const suffix = timedOut ? notice(`timeout after ${timeout}s`) : "";
    const withSuffix = (body: string): TextBlock => ({
      type: "text",
      text: [body, suffix].filter(Boolean).join("\n"),
    });

    const content: ToolResult["content"] =
      format === "text"
        ? [withSuffix(truncated ? truncateOutput(text, outPath) : text)]
        : format
          ? [{ type: "image", data: raw.toString("base64"), mimeType: format }, ...(suffix ? [withSuffix("")] : [])]
          : [withSuffix(notice("output is of unsupported format"))];

    return { content, failed: stopped || status !== 0 || !format };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    signal.removeEventListener("abort", stop);
    // Reap any grandchildren left in the process group after cancel/timeout.
    if (stopped) killGroup("SIGKILL");
    closeSync(outFd);
    if (!truncated) rmSync(outPath);
  }
}

// ── Providers ───────────────────────────────────────────────────────────────

const REFUSAL_STATUSES = [400, 413];
const MAX_RETRIES = 6;

const isRetryable = ({ end, status = 0 }: AssistantReply) =>
  end === "failed" && (!status || status === 429 || status >= 500);

const cacheControl = (cache: CacheMode) =>
  cache === "none" ? {} : { cache_control: { type: "ephemeral", ...(cache === "long" && { ttl: "1h" }) } };

const asPlainText = (content: ToolResult["content"]) =>
  content.every((block): block is TextBlock => block.type === "text")
    ? content.map((block) => block.text).join("\n")
    : undefined;

// Provider tool call IDs must match [\w-] and fit within 64 chars.
const normalizeCallId = (id: string) => id.replace(/[^\w-]/g, "_").slice(0, 64);

/**
 * Prepare history for an LLM request: drop failed/stopped/refused replies and their orphaned results,
 * synthesize `(bee: not run)` for unanswered tool calls, mark empty results with `(bee: no output)`,
 * and replace tool results that triggered a 400/413 refusal with the error so the session can recover.
 */
function sanitizeHistory(history: MessageEntry[]): MessageEntry[] {
  const out: MessageEntry[] = [];
  const pendingCalls = new Map<string, ToolCall>();
  let sinceLastReply = 0;

  const closePending = () => {
    for (const call of pendingCalls.values())
      out.push({ result: makeToolResult(call, [{ type: "text", text: notice("not run") }], true) });
    pendingCalls.clear();
  };

  for (const entry of history) {
    if ("result" in entry) {
      const { result } = entry;
      const normalized = isEmptyContent(result.content)
        ? { result: { ...result, content: [{ type: "text" as const, text: notice("no output") }] } }
        : entry;
      if (pendingCalls.delete(result.call)) out.push(normalized);
      continue;
    }
    closePending();
    if ("reply" in entry) {
      const { reply } = entry;
      if (reply.end === "refused") {
        for (let i = sinceLastReply; i < out.length; i++) {
          const item = out[i];
          if ("result" in item)
            out[i] = {
              result: { ...item.result, content: [{ type: "text", text: notice(`provider refused: ${reply.why}`) }] },
            };
        }
      }
      if (reply.end === "failed" || reply.end === "stopped" || reply.end === "refused") continue;
      sinceLastReply = out.length + 1;
      for (const block of reply.content) if (block.type === "call") pendingCalls.set(block.id, block);
    }
    out.push(entry);
  }
  closePending();
  return out;
}

// Provider-specific sealed metadata (thinking signatures, item IDs) is only valid for the provider that issued it.
const stripForeignSeals = (history: MessageEntry[], provider: string): MessageEntry[] =>
  history.map((entry) =>
    "reply" in entry && entry.reply.provider !== provider
      ? { reply: { ...entry.reply, content: entry.reply.content.map(({ sealed, ...block }) => block) } }
      : entry,
  );

async function* parseSSE(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    const frames = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n").split("\n\n");
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

async function streamReply(
  model: Model,
  header: SessionHeader,
  history: MessageEntry[],
  options: RequestOptions,
  onDelta: StreamCallback,
): Promise<AssistantReply> {
  const api = PROVIDERS[model.provider];
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const reply: AssistantReply = {
    provider: model.provider,
    model: model.id,
    content: [],
    usage,
    timestamp: Date.now(),
  };
  try {
    const prepared = stripForeignSeals(sanitizeHistory(history), model.provider);
    const { url, headers, body } = api.request(model, header, prepared, options);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    const { status } = response;
    if (!response.ok) throw Object.assign(new Error(`${status} ${await response.text()}`), { status });
    await api.read(parseSSE(response.body!), reply, onDelta);
  } catch (error: any) {
    reply.end = options.signal.aborted ? "stopped" : REFUSAL_STATUSES.includes(error.status) ? "refused" : "failed";
    reply.why = error.message;
    reply.status = error.status;
  }
  return reply;
}

// Anthropic Messages API

const ANTHROPIC_STOP_REASONS: Record<string, AssistantReply["end"]> = {
  end_turn: undefined,
  pause_turn: undefined,
  stop_sequence: undefined,
  tool_use: undefined,
  max_tokens: "cut",
};

const isAnthropicOAuth = (apiKey: string) => apiKey.includes("sk-ant-oat");

const anthropicHeaders = (apiKey: string) => ({
  "anthropic-version": "2023-06-01",
  ...(isAnthropicOAuth(apiKey)
    ? { authorization: `Bearer ${apiKey}`, "anthropic-beta": "oauth-2025-04-20" }
    : { "x-api-key": apiKey }),
});

const anthropic: ProviderApi = {
  baseUrl: "https://api.anthropic.com",
  listing: ({ baseUrl, apiKey }) => ({ url: `${baseUrl}/v1/models?limit=1000`, headers: anthropicHeaders(apiKey) }),
  models: (payload) =>
    (payload.data ?? []).map((item: any) => {
      const { thinking, effort } = item.capabilities;
      const supports = (level: ThinkingLevel) =>
        (level === "off" ? thinking?.types?.disabled : effort?.[level])?.supported;
      const { id, display_name: name, max_input_tokens: contextWindow } = item;
      return { id, name, contextWindow, levels: THINKING_LEVELS.filter(supports), listed: item };
    }),

  request(model, header, history, { thinking, cache }) {
    const mark = cacheControl(cache);
    const encodeContent = (content: UserMessage["content"]) =>
      content
        .filter((block) => block.type === "image" || block.text.trim())
        .map((block) =>
          block.type === "image"
            ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
            : { type: "text", text: block.text },
        );
    const encodeAssistantBlock = (block: TextBlock | ThinkingBlock | ToolCall): object[] => {
      if (block.type === "text") return block.text.trim() ? [{ type: "text", text: block.text }] : [];
      if (block.type === "call")
        return [{ type: "tool_use", id: normalizeCallId(block.id), name: block.name, input: block.arguments }];
      // Anthropic rejects thinking blocks without a valid signature.
      if (!block.sealed) return [];
      return block.redacted
        ? [{ type: "redacted_thinking", data: block.sealed }]
        : [{ type: "thinking", thinking: block.text, signature: block.sealed }];
    };
    const encodeEntry = (entry: MessageEntry): { role: string; content: object[] } => {
      if ("reply" in entry) return { role: "assistant", content: entry.reply.content.flatMap(encodeAssistantBlock) };
      if ("user" in entry) return { role: "user", content: encodeContent(entry.user.content) };
      const { call, content, failed } = entry.result;
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: normalizeCallId(call),
            content: asPlainText(content) ?? encodeContent(content),
            is_error: failed,
          },
        ],
      };
    };

    // Coalesce adjacent same-role turns (e.g. tool_result + steering user message) and cache up to the last block.
    const messages: { role: string; content: object[] }[] = [];
    for (const msg of history.map(encodeEntry).filter((m) => m.content.length)) {
      if (messages.at(-1)?.role === msg.role) messages.at(-1)!.content.push(...msg.content);
      else messages.push(msg);
    }
    Object.assign(messages.at(-1)?.content.at(-1) ?? {}, mark);

    const claudeCodeIdentity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
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
        system: [
          ...(isAnthropicOAuth(model.apiKey) ? [claudeCodeIdentity] : []),
          { type: "text", text: header.prompt, ...mark },
        ],
        tools: header.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          input_schema: parameters,
        })),
        messages,
        ...reasoning,
      },
    };
  },

  async read(events, reply, onDelta) {
    const openBlocks = new Map<number, { block: any; json: string }>();
    let stopDelta: { stop_reason?: string; stop_details?: { explanation?: string } } = {};
    const mergeUsage = (u: any = {}) => {
      reply.usage.input = u.input_tokens ?? reply.usage.input;
      reply.usage.output = u.output_tokens ?? reply.usage.output;
      reply.usage.cacheRead = u.cache_read_input_tokens ?? reply.usage.cacheRead;
      reply.usage.cacheWrite = u.cache_creation_input_tokens ?? reply.usage.cacheWrite;
    };
    const createBlock = (raw: any): AssistantReply["content"][number] | undefined => {
      if (raw.type === "text") return { type: "text", text: raw.text };
      if (raw.type === "thinking") return { type: "thinking", text: raw.thinking, sealed: raw.signature };
      if (raw.type === "redacted_thinking") return { type: "thinking", text: "", sealed: raw.data, redacted: true };
      if (raw.type === "tool_use") return { type: "call", id: raw.id, name: raw.name, arguments: {} };
    };

    for await (const event of events) {
      const { delta } = event;
      const open = openBlocks.get(event.index);
      switch (event.type) {
        case "error":
          throw new Error(`${event.error.type}: ${event.error.message}`);
        case "message_start":
          mergeUsage(event.message.usage);
          break;
        case "content_block_start": {
          const block = createBlock(event.content_block);
          if (!block) break;
          openBlocks.set(event.index, { block, json: "" });
          reply.content.push(block);
          break;
        }
        case "content_block_delta":
          if (!open) break;
          if (delta.type === "text_delta" || delta.type === "thinking_delta") {
            const chunk = delta.text ?? delta.thinking;
            open.block.text += chunk;
            onDelta(open.block.type, chunk);
          }
          if (delta.type === "signature_delta") open.block.sealed = (open.block.sealed ?? "") + delta.signature;
          if (delta.type === "input_json_delta") open.json += delta.partial_json;
          break;
        case "content_block_stop":
          if (open?.block.type === "call") open.block.arguments = JSON.parse(open.json || "{}");
          openBlocks.delete(event.index);
          break;
        case "message_delta":
          stopDelta = delta;
          mergeUsage(event.usage);
          break;
        case "message_stop":
          if (!(stopDelta.stop_reason! in ANTHROPIC_STOP_REASONS))
            throw new Error(stopDelta.stop_details?.explanation ?? `The model stopped: ${stopDelta.stop_reason}`);
          reply.end = ANTHROPIC_STOP_REASONS[stopDelta.stop_reason!];
          return;
      }
    }
    throw new Error("The stream ended before the reply did");
  },
};

// OpenAI Codex Responses API

function extractAccountId(jwt: string): string {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    const id = claims["https://api.openai.com/auth"].chatgpt_account_id;
    if (typeof id === "string") return id;
  } catch {}
  throw new Error("The key is not a ChatGPT token: it names no account.");
}

const codexHeaders = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`,
  "chatgpt-account-id": extractAccountId(apiKey),
});

const codex: ProviderApi = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  // client_version=999.0.0 ensures the backend doesn't gate newer models behind CLI version checks.
  listing: ({ baseUrl, apiKey }) => ({
    url: `${baseUrl}/models?client_version=999.0.0`,
    headers: codexHeaders(apiKey),
  }),
  models: (payload) =>
    (payload.models ?? [])
      .filter((item: any) => item.visibility === "list")
      .map((item: any) => {
        const efforts = item.supported_reasoning_levels.map((level: any) => level.effort);
        const { slug: id, display_name: name, context_window: contextWindow } = item;
        return { id, name, contextWindow, levels: THINKING_LEVELS.filter((l) => efforts.includes(l)), listed: item };
      }),

  request(model, header, history, { origin, thinking, cache }) {
    const encodeContent = (content: UserMessage["content"]) =>
      content.map((block) =>
        block.type === "text"
          ? { type: "input_text", text: block.text }
          : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` },
      );
    const encodeAssistantBlock = ({ sealed, ...block }: TextBlock | ThinkingBlock | ToolCall): object[] => {
      if (block.type === "thinking") return sealed ? [sealed] : [];
      if (block.type === "call") {
        return [
          {
            type: "function_call",
            ...(sealed && { id: sealed }),
            call_id: normalizeCallId(block.id),
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          },
        ];
      }
      if (!block.text.trim()) return [];
      if (!sealed) return [{ role: "assistant", content: block.text }];
      const content = [{ type: "output_text", text: block.text, annotations: [] }];
      return [{ type: "message", role: "assistant", content, status: "completed", ...sealed }];
    };
    const encodeEntry = (entry: MessageEntry): object[] => {
      if ("reply" in entry) return entry.reply.content.flatMap(encodeAssistantBlock);
      if ("user" in entry) return [{ role: "user", content: encodeContent(entry.user.content) }];
      const output = asPlainText(entry.result.content) ?? encodeContent(entry.result.content);
      return [{ type: "function_call_output", call_id: normalizeCallId(entry.result.call), output }];
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
        instructions: header.prompt,
        input: history.flatMap(encodeEntry),
        tools: header.tools.map(({ name, description, parameters }) => ({
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

  async read(events, reply, onDelta) {
    const parseItem = (item: any): AssistantReply["content"][number] | undefined => {
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

    for await (const event of events) {
      const { type, delta, item, response } = event;
      if (type === "error") throw new Error(`${event.code}: ${event.message}`);
      if (type === "response.failed") throw new Error(`${response.error?.code}: ${response.error?.message}`);
      if (type === "response.output_text.delta") onDelta("text", delta);
      if (type === "response.reasoning_summary_text.delta") onDelta("thinking", delta);
      if (type === "response.reasoning_summary_part.done") onDelta("thinking", "\n\n");
      if (type === "response.output_item.done") {
        const block = parseItem(item);
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

// OpenRouter Chat Completions API

const APPENDED_REASONING_FIELDS = ["text", "summary", "data"];

const openRouterLevels = ({ reasoning }: any): string[] =>
  reasoning?.supported_efforts?.map((effort: string) => (effort === "none" ? "off" : effort)) ??
  (reasoning ? [...(reasoning.mandatory ? [] : ["off"]), "on"] : ["off"]);

const openrouter: ProviderApi = {
  baseUrl: "https://openrouter.ai/api/v1",
  listing: ({ baseUrl, apiKey }) => ({ url: `${baseUrl}/models`, headers: { authorization: `Bearer ${apiKey}` } }),
  models: (payload) =>
    (payload.data ?? [])
      .filter((item: any) => item.supported_parameters?.includes("tools"))
      .map((item: any) => {
        const { id, name, context_length: contextWindow } = item;
        const supported = openRouterLevels(item);
        return { id, name, contextWindow, levels: THINKING_LEVELS.filter((l) => supported.includes(l)), listed: item };
      }),

  request(model, header, history, { origin, thinking, cache }) {
    const mark = cacheControl(cache);
    const encodeContent = (content: UserMessage["content"]) =>
      content.map((block) =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
      );
    const encodeEntry = (entry: MessageEntry): { role: string; content: any; [key: string]: unknown } => {
      if ("user" in entry) return { role: "user", content: encodeContent(entry.user.content) };
      if ("result" in entry)
        return {
          role: "tool",
          tool_call_id: normalizeCallId(entry.result.call),
          content: encodeContent(entry.result.content),
        };
      const ofType = <T extends AssistantReply["content"][number]["type"]>(type: T) =>
        entry.reply.content.filter(
          (block): block is Extract<AssistantReply["content"][number], { type: T }> => block.type === type,
        );
      const text = ofType("text")
        .map((block) => block.text)
        .join("");
      const toolCalls = ofType("call").map(({ id, name, arguments: input }) => ({
        id: normalizeCallId(id),
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      }));
      const sealedReasoning = ofType("thinking").flatMap((block) => block.sealed ?? []);
      const plainReasoning = ofType("thinking")
        .filter((block) => !block.sealed)
        .map((block) => block.text)
        .join("\n\n");
      return {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length && { tool_calls: toolCalls }),
        ...(sealedReasoning.length && { reasoning_details: sealedReasoning }),
        ...(plainReasoning && { reasoning: plainReasoning }),
      };
    };

    const messages = history.map(encodeEntry);
    Object.assign(messages.at(-1)?.content?.at?.(-1) ?? {}, mark);
    return {
      url: `${model.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${model.apiKey}` },
      body: {
        model: model.id,
        stream: true,
        messages: [{ role: "system", content: [{ type: "text", text: header.prompt, ...mark }] }, ...messages],
        tools: header.tools.map(({ name, description, parameters }) => ({
          type: "function",
          function: { name, description, parameters },
        })),
        reasoning: thinking === "off" || thinking === "on" ? { enabled: thinking === "on" } : { effort: thinking },
        ...(cache !== "none" && { session_id: origin }),
      },
    };
  },

  async read(events, reply, onDelta) {
    const pushBlock = <T extends AssistantReply["content"][number]>(block: T) => (reply.content.push(block), block);
    let thinking: ThinkingBlock | undefined;
    let text: TextBlock | undefined;
    const ensureThinking = () => (thinking ??= pushBlock<ThinkingBlock>({ type: "thinking", text: "", sealed: [] }));
    const ensureText = () => (text ??= pushBlock<TextBlock>({ type: "text", text: "" }));
    const openCalls: { call: ToolCall; json: string }[] = [];
    let finishReason: string | undefined;

    for await (const { error, usage, choices } of events) {
      if (error) throw new Error(`${error.code}: ${error.message}`);
      if (usage) {
        const { prompt_tokens, completion_tokens: output, prompt_tokens_details: cached = {} } = usage;
        const cacheRead = cached.cached_tokens ?? 0;
        const cacheWrite = cached.cache_write_tokens ?? 0;
        reply.usage = { input: prompt_tokens - cacheRead - cacheWrite, output, cacheRead, cacheWrite };
      }
      const { delta = {}, finish_reason } = choices?.[0] ?? {};
      if (delta.reasoning) {
        ensureThinking().text += delta.reasoning;
        onDelta("thinking", delta.reasoning);
      }
      for (const piece of delta.reasoning_details ?? []) {
        const { sealed } = ensureThinking();
        let detail = sealed.find((entry: any) => entry.index === piece.index);
        if (!detail) sealed.push((detail = {}));
        for (const [key, value] of Object.entries(piece))
          detail[key] = APPENDED_REASONING_FIELDS.includes(key) ? (detail[key] ?? "") + value : value;
      }
      if (delta.content) {
        ensureText().text += delta.content;
        onDelta("text", delta.content);
      }
      for (const piece of delta.tool_calls ?? []) {
        const entry = (openCalls[piece.index] ??= {
          call: pushBlock<ToolCall>({ type: "call", id: "", name: "", arguments: {} }),
          json: "",
        });
        entry.call.id ||= piece.id ?? "";
        entry.call.name ||= piece.function?.name ?? "";
        entry.json += piece.function?.arguments ?? "";
      }
      finishReason = finish_reason ?? finishReason;
    }

    if (!finishReason) throw new Error("The stream ended before the reply did");
    for (const { call, json } of openCalls.filter(Boolean)) call.arguments = JSON.parse(json || "{}");
    if (!["stop", "tool_calls", "length"].includes(finishReason)) throw new Error(`The model stopped: ${finishReason}`);
    reply.end = finishReason === "length" ? "cut" : undefined;
  },
};

const PROVIDERS: Record<string, ProviderApi> = { anthropic, "openai-codex": codex, openrouter };

// ── Model Catalog ───────────────────────────────────────────────────────────

const CATALOG_TIMEOUT_MS = 15_000;
const providerConfigs: Record<string, { apiKey: string; baseUrl?: string }> =
  JSON.parse(readText(MODELS_FILE, "{}")).providers ?? {};

const catalogPath = (provider: string) => join(CATALOG_DIR, `${provider}.json`);
const modelRef = (model: Model) => `${model.provider}/${model.id}`;
const compareNames = new Intl.Collator("en", { numeric: true }).compare;

async function refreshCatalog(provider: string, config: ProviderConfig) {
  const { url, headers } = PROVIDERS[provider].listing(config);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CATALOG_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetch(url, { headers, signal: abort.signal });
    if (!response.ok) return;
    const json = JSON.stringify(await response.json());
    const tmp = `${catalogPath(provider)}.${process.pid}`;
    mkdirSync(CATALOG_DIR, { recursive: true });
    writeFileSync(tmp, json);
    renameSync(tmp, catalogPath(provider));
  } finally {
    clearTimeout(timer);
  }
}

async function loadProviderModels(provider: string, config: ProviderConfig): Promise<Model[]> {
  // Refresh in the background for next startup; only block when no cached catalog exists yet.
  const refresh = refreshCatalog(provider, config).catch(() => {});
  const readCached = () => PROVIDERS[provider].models(JSON.parse(readText(catalogPath(provider), "{}")));
  if (!readCached().length) await refresh;
  return readCached().map((meta) => ({ ...meta, ...config, provider }));
}

const models = (
  await Promise.all(
    Object.entries(providerConfigs)
      .filter(([provider]) => provider in PROVIDERS)
      .map(([provider, { apiKey, baseUrl }]) =>
        loadProviderModels(provider, { apiKey, baseUrl: baseUrl ?? PROVIDERS[provider].baseUrl }),
      ),
  )
)
  .flat()
  .sort((a, b) => compareNames(modelRef(a), modelRef(b)));

// ── Sessions ────────────────────────────────────────────────────────────────
// Sessions are append-only JSONL files. Keeping lines strictly append-only preserves prompt-cache
// prefixes across turns. Empty sessions and fresh forks stay in memory until the first message.

const sessionPath = (sid: string) => join(SESSIONS_DIR, `${sid}.jsonl`);
const pendingSessions = new Map<string, SessionLine[]>();
const sessionCache = new Map<string, { size: number; lines: SessionLine[] }>();

function loadInstructions(cwd: string) {
  const dirs = [cwd];
  while (dirs[0] !== dirname(dirs[0])) dirs.unshift(dirname(dirs[0]));
  return [HOME, ...dirs]
    .map((dir) => join(dir, "AGENTS.md"))
    .filter(existsSync)
    .map((path) => `<file path="${path}">\n${readText(path).trim()}\n</file>`)
    .join("\n\n");
}

function createSessionHeader(cwd: string): SessionLine {
  const config: ConfigValues = JSON.parse(readText(join(HOME, "settings.json"), "{}"));
  for (const key of CONFIG_KEYS) if (!(key in config)) throw new Error(`settings.json sets no ${key}`);
  const began: SessionHeader = {
    cwd,
    prompt: `\nYou are an agent in the bee harness.\n\n${loadInstructions(cwd)}`.trimEnd(),
    tools: [BASH_TOOL],
    timestamp: Date.now(),
  };
  return { ...config, began };
}

function readSession(sid: string): SessionLine[] {
  const pending = pendingSessions.get(sid);
  if (pending) return pending;
  if (!/^[\w-]+$/.test(sid) || !existsSync(sessionPath(sid))) throw rpcError(-32002, `No session ${sid}`);
  const { size } = statSync(sessionPath(sid));
  if (sessionCache.get(sid)?.size !== size) {
    sessionCache.set(sid, { size, lines: readText(sessionPath(sid)).trimEnd().split("\n").map(parseJson) });
  }
  return sessionCache.get(sid)!.lines;
}

function appendSession(sid: string, ...added: SessionLine[]) {
  const pending = pendingSessions.get(sid);
  if (pending && !added.some(isMessageEntry)) return void pending.push(...added);

  const batch = [...(pending ?? []), ...added];
  const payload = batch.map((line) => JSON.stringify(line) + "\n").join("");
  let fd: number;
  try {
    // Use O_APPEND for existing sessions so a deleted session file stays deleted rather than recreated headless.
    fd = openSync(sessionPath(sid), pending ? "wx" : constants.O_WRONLY | constants.O_APPEND);
  } catch (error: any) {
    throw error.code === "ENOENT" ? rpcError(-32002, `No session ${sid}`) : error;
  }
  try {
    writeSync(fd, payload);
    pendingSessions.delete(sid);
  } finally {
    closeSync(fd);
  }

  const bytes = Buffer.byteLength(payload);
  const size = statSync(sessionPath(sid)).size;
  const cached = sessionCache.get(sid);
  if (pending && size === bytes) sessionCache.set(sid, { size, lines: batch });
  else if (cached && cached.size + bytes === size) {
    cached.size = size;
    cached.lines.push(...added);
  }
  emitSessionMeta(sid);
}

const sessionHeader = (sid: string) => readSession(sid)[0].began!;
// Stable hash of the first line; shared across forks so provider prompt caches stay warm.
const sessionOrigin = (sid: string) => Bun.hash(JSON.stringify(readSession(sid)[0])).toString(36);
const sessionHistory = (sid: string): MessageEntry[] => readSession(sid).filter(isMessageEntry);

function sessionConfig(sid: string) {
  const entries = readSession(sid);
  return Object.fromEntries(CONFIG_KEYS.map((key) => [key, entries.findLast((line) => key in line)![key]!])) as Record<
    ConfigKey,
    string
  >;
}

const sessionModel = (sid: string) => models.find((m) => modelRef(m) === sessionConfig(sid).model);

function validateConfig(sid: string, key: string, value: string) {
  const option = configOptions(sid).find((opt) => opt.id === key);
  if (!option?.options.some((choice) => choice.value === value)) throw rpcError(-32602, `No ${key} ${value}`);
}

function resolveConfig(sid: string) {
  const config = sessionConfig(sid);
  for (const key of CONFIG_KEYS) validateConfig(sid, key, config[key]);
  return { model: sessionModel(sid)!, thinking: config.thinking as ThinkingLevel, cache: config.cache as CacheMode };
}

function forkSession(sid: string, cursorId?: string) {
  const entries = readSession(sid);
  const index = cursorId == null ? entries.length : entries.findIndex((line, i) => String(i) === cursorId && line.user);
  if (index < 0) throw rpcError(-32602, `No cursor ${cursorId}`);
  const forkedId = randomUUID();
  // Preserve config changes made after the fork point so the fork inherits current settings.
  const trailingConfig = entries.slice(index).filter((line) => CONFIG_KEYS.some((key) => key in line));
  pendingSessions.set(forkedId, [...entries.slice(0, index), { forked: sid }, ...trailingConfig]);
  return forkedId;
}

// ── Agent Loop ──────────────────────────────────────────────────────────────

type ActiveTurn = { abort: AbortController; queued: UserMessage[]; done?: Promise<string> };
const activeTurns = new Map<string, ActiveTurn>();

function flushUserMessages(sid: string, queue: UserMessage[]) {
  for (const msg of queue.splice(0).filter((m) => !isEmptyContent(m.content))) {
    const cursor = readSession(sid).length;
    appendSession(sid, { user: msg });
    if (clientSupportsCursors) emitUserMessage(sid, msg, cursor);
  }
}

function needsReply(sid: string) {
  const last = sanitizeHistory(sessionHistory(sid)).at(-1);
  return Boolean(last && !("reply" in last));
}

async function executeToolCall(sid: string, call: ToolCall, signal: AbortSignal) {
  emitToolStart(sid, call);
  const { content, failed } = await runBash(sid, call, signal).catch((error: Error) => ({
    content: [{ type: "text" as const, text: notice(error.message) }],
    failed: true,
  }));
  const result = makeToolResult(call, content, failed);
  emitToolResult(sid, call, result);
  return result;
}

async function requestReply(sid: string, signal: AbortSignal) {
  const { model, thinking, cache } = resolveConfig(sid);
  const onDelta: StreamCallback = (kind, delta) =>
    sendChunk(sid, kind === "text" ? "agent_message" : "agent_thought", delta);
  return streamReply(
    model,
    sessionHeader(sid),
    sessionHistory(sid),
    { origin: sessionOrigin(sid), thinking, cache, signal },
    onDelta,
  );
}

async function runTurn(sid: string, { abort: { signal }, queued }: ActiveTurn): Promise<string> {
  let lastResults: ToolResult[] = [];
  let retries = 0;
  try {
    for (;;) {
      flushUserMessages(sid, queued);
      if (signal.aborted) return "cancelled";
      if (!needsReply(sid)) return "end_turn";

      const reply = await requestReply(sid, signal);
      // If tool output caused a 400/413 refusal, persist the refusal so sanitizeHistory replaces those results on retry.
      const retryRefusal = reply.end === "refused" && lastResults.length > 0;
      const calls = reply.end ? [] : reply.content.filter((block) => block.type === "call");
      lastResults = [];
      for (const call of calls) if (!signal.aborted) lastResults.push(await executeToolCall(sid, call, signal));

      // Write reply and its tool results in one append so tool calls and results never interleave with other writes.
      appendSession(sid, { reply }, ...lastResults.map((result) => ({ result })));
      if (retryRefusal) continue;

      retries = isRetryable(reply) ? retries + 1 : 0;
      if (retries && retries <= MAX_RETRIES) {
        await sleep(1000 * 2 ** (retries - 1), null, { signal }).catch(() => {});
        continue;
      }
      if (reply.end === "failed" || reply.end === "refused") throw new Error(reply.why);
      if (!calls.length && !queued.length && !signal.aborted) return reply.end === "cut" ? "max_tokens" : "end_turn";
    }
  } finally {
    // Delete turn before flushing so a write error can't leave a zombie turn absorbing future prompts.
    activeTurns.delete(sid);
    flushUserMessages(sid, queued);
  }
}

// ── ACP Protocol ────────────────────────────────────────────────────────────

let clientSupportsCursors = false;

const sendRpc = (payload: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
const sendUpdate = (sessionId: string, update: object) =>
  sendRpc({ method: "session/update", params: { sessionId, update } });
const sendChunk = (
  sid: string,
  kind: "user_message" | "agent_message" | "agent_thought",
  text: string,
  messageId?: string,
) => text && sendUpdate(sid, { sessionUpdate: `${kind}_chunk`, messageId, content: { type: "text", text } });

const extractText = (content: { type: string; text?: string }[]) => content.map((b) => b.text ?? "").join("");
const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 80);
const totalTokens = ({ input, output, cacheRead, cacheWrite }: Usage) => input + output + cacheRead + cacheWrite;
const callCommand = (call: ToolCall) => String(call.arguments.command ?? "");

function codeBlock(body: string, language = "") {
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return { type: "content", content: { type: "text", text: `${fence}${language}\n${body.trim()}\n${fence}` } };
}

function emitUserMessage(sid: string, msg: UserMessage, cursor: number) {
  const messageId = randomUUID();
  sendChunk(sid, "user_message", extractText(msg.content), messageId);
  if (!clientSupportsCursors) return;
  sendUpdate(sid, {
    sessionUpdate: "cursor_update",
    cursorId: String(cursor),
    capabilities: { fork: {} },
    anchor: { type: "user_message", messageId, position: "before" },
  });
}

function sessionTitle(entries: SessionLine[]) {
  const start = entries.findLastIndex((line) => line.forked) + 1;
  const firstUser = entries.slice(start).find((line) => line.user);
  return firstUser ? firstLine(extractText(firstUser.user!.content)) || undefined : undefined;
}

function emitSessionMeta(sid: string) {
  const entries = readSession(sid);
  const title = sessionTitle(entries);
  const used = entries.map((line) => (line.reply ? totalTokens(line.reply.usage) : 0)).findLast(Boolean);
  const size = sessionModel(sid)?.contextWindow;
  if (title) sendUpdate(sid, { sessionUpdate: "session_info_update", title });
  if (used && size) sendUpdate(sid, { sessionUpdate: "usage_update", used, size });
}

function emitToolStart(sid: string, call: ToolCall) {
  sendUpdate(sid, {
    sessionUpdate: "tool_call",
    toolCallId: call.id,
    title: firstLine(callCommand(call)),
    kind: "execute",
    status: "in_progress",
    content: [codeBlock(callCommand(call), "bash")],
    rawInput: call.arguments,
  });
}

function emitToolResult(sid: string, call: ToolCall, result: ToolResult) {
  const output = result.content.map((block) =>
    block.type === "image" ? { type: "content", content: block } : codeBlock(block.text),
  );
  sendUpdate(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.id,
    status: result.failed ? "failed" : "completed",
    content: [codeBlock(callCommand(call), "bash"), ...output],
    rawOutput: extractText(result.content),
  });
}

function replaySession(sid: string) {
  const calls = new Map<string, ToolCall>();
  for (const [index, { user, reply, result }] of readSession(sid).entries()) {
    if (user) emitUserMessage(sid, user, index);
    if (result) {
      const call = calls.get(result.call)!;
      emitToolStart(sid, call);
      emitToolResult(sid, call, result);
    }
    for (const block of reply?.content ?? []) {
      if (block.type === "text") sendChunk(sid, "agent_message", block.text);
      if (block.type === "thinking") sendChunk(sid, "agent_thought", block.text);
      if (block.type === "call") calls.set(block.id, block);
    }
  }
}

function configOptions(sid: string) {
  const { model, thinking, cache } = sessionConfig(sid);
  const modelChoices = models.map((m) => ({ value: modelRef(m), name: m.name }));
  const [thinkingChoices, cacheChoices] = [sessionModel(sid)?.levels ?? [], CACHE_MODES].map((values) =>
    values.map((value) => ({ value, name: value })),
  );
  return [
    { id: "model", name: "Model", category: "model", currentValue: model, options: modelChoices },
    { id: "thinking", name: "Thinking", category: "thought_level", currentValue: thinking, options: thinkingChoices },
    { id: "cache", name: "Cache", currentValue: cache, options: cacheChoices },
  ].map((option) => ({ type: "select", ...option }));
}

// Fast raw-buffer line scan for session/list so listing large session histories avoids parsing every JSONL line.
const parseLineAt = (buf: Buffer, offset: number): SessionLine =>
  parseJson(buf.toString("utf8", offset, buf.indexOf("\n", offset)));

function extractTitleFromBuffer(buf: Buffer) {
  const offset = buf.indexOf('\n{"user":', buf.lastIndexOf('\n{"forked":') + 1);
  return offset < 0 ? undefined : firstLine(extractText(parseLineAt(buf, offset + 1).user!.content)) || undefined;
}

function listSessions(cwd?: string) {
  return readdirSync(SESSIONS_DIR)
    .flatMap((name) => /^([\w-]+)\.jsonl$/.exec(name)?.[1] ?? [])
    .map((sessionId) => {
      const path = sessionPath(sessionId);
      const buf = readFileSync(path);
      const updatedAt = statSync(path).mtime.toISOString();
      return { sessionId, cwd: parseLineAt(buf, 0).began!.cwd, title: extractTitleFromBuffer(buf), updatedAt };
    })
    .filter((session) => !cwd || session.cwd === cwd)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function saveTempImage(bytes: Buffer, mimeType: string) {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const path = join(tmpdir(), `bee-${hash}.${mimeType.split("/")[1]}`);
  writeFileSync(path, bytes);
  return path;
}

const parsePromptBlocks = (blocks: any[]): UserMessage["content"] =>
  blocks.map((block) =>
    block.type === "image"
      ? { type: "text", text: saveTempImage(Buffer.from(block.data, "base64"), block.mimeType) }
      : block.type === "resource"
        ? { type: "text", text: `<file uri="${block.resource.uri}">\n${block.resource.text ?? ""}\n</file>` }
        : { type: "text", text: block.text ?? block.uri ?? "" },
  );

function openSession(sessionId: string) {
  emitSessionMeta(sessionId);
  return { sessionId, configOptions: configOptions(sessionId) };
}

const handlers: Record<string, (params: any) => unknown> = {
  initialize: ({ clientCapabilities }) => {
    clientSupportsCursors = Boolean(clientCapabilities?.session?.cursors);
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
    pendingSessions.set(sessionId, [createSessionHeader(cwd)]);
    return openSession(sessionId);
  },
  "session/resume": ({ sessionId }) => openSession(sessionId),
  "session/load": ({ sessionId }) => {
    replaySession(sessionId);
    return openSession(sessionId);
  },
  "session/fork": ({ sessionId, cursorId }) => openSession(forkSession(sessionId, cursorId)),
  "session/list": ({ cwd }) => ({ sessions: listSessions(cwd) }),
  "session/set_config_option": ({ sessionId, configId, value }) => {
    validateConfig(sessionId, configId, value);
    appendSession(sessionId, { [configId]: value });
    return { configOptions: configOptions(sessionId) };
  },
  "session/cancel": ({ sessionId }) => activeTurns.get(sessionId)?.abort.abort(),
  "session/prompt": async ({ sessionId, prompt }) => {
    const msg = makeUserMessage(parsePromptBlocks(prompt));
    let active = activeTurns.get(sessionId);
    if (active) active.queued.push(msg);
    else {
      active = { abort: new AbortController(), queued: [msg] };
      activeTurns.set(sessionId, active);
      active.done = runTurn(sessionId, active);
    }
    return { stopReason: await active.done };
  },
};

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const running = [...activeTurns.values()];
  for (const active of running) active.abort.abort();
  await Promise.allSettled(running.map((active) => active.done));
  process.exit();
}

for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(sig, shutdown);
process.stdout.on("error", () => {});

mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = parseJson(line);
  if (!method) continue;
  const respond = (payload: object) => id !== undefined && sendRpc({ id, ...payload });
  const unknownMethod = () => Promise.reject(rpcError(-32601, `No method ${method}`));
  Promise.resolve(params ?? {})
    .then(Object.hasOwn(handlers, method) ? handlers[method] : unknownMethod)
    .then(
      (result) => respond({ result: result ?? {} }),
      (error) =>
        respond({ error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } }),
    );
}
await shutdown();
