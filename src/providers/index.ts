import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isEmptyContent,
  makeToolResult,
  modelRef,
  notice,
  readText,
  type AssistantReply,
  type MessageEntry,
  type Model,
  type ProviderApi,
  type ProviderConfig,
  type RequestOptions,
  type SessionHeader,
  type StreamCallback,
  type ToolCall,
  type Usage,
} from "../types";
import { anthropic } from "./anthropic";
import { codex } from "./codex";
import { openrouter } from "./openrouter";

export const PROVIDERS: Record<string, ProviderApi> = {
  anthropic,
  "openai-codex": codex,
  openrouter,
};

export const MAX_RETRIES = 6;
const REFUSAL_STATUSES = [400, 413];
const CATALOG_TIMEOUT_MS = 15_000;
const compareNames = new Intl.Collator("en", { numeric: true }).compare;

export const isRetryable = ({ end, status = 0 }: AssistantReply) =>
  end === "failed" && (!status || status === 429 || status >= 500);

/**
 * Prepare history for an LLM request: drop failed/stopped/refused replies and their orphaned results,
 * synthesize `(bee: not run)` for unanswered tool calls, mark empty results with `(bee: no output)`,
 * and replace tool results that triggered a 400/413 refusal with the error so the session can recover.
 */
export function sanitizeHistory(history: MessageEntry[]): MessageEntry[] {
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
          if ("result" in item) {
            out[i] = {
              result: { ...item.result, content: [{ type: "text", text: notice(`provider refused: ${reply.why}`) }] },
            };
          }
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
export const stripForeignSeals = (history: MessageEntry[], provider: string): MessageEntry[] =>
  history.map((entry) =>
    "reply" in entry && entry.reply.provider !== provider
      ? { reply: { ...entry.reply, content: entry.reply.content.map(({ sealed, ...block }) => block) } }
      : entry,
  );

export async function* parseSSE(body: ReadableStream<Uint8Array>) {
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

export async function streamReply(
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

async function refreshCatalog(catalogDir: string, provider: string, config: ProviderConfig) {
  const { url, headers } = PROVIDERS[provider].listing(config);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CATALOG_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetch(url, { headers, signal: abort.signal });
    if (!response.ok) return;
    const json = JSON.stringify(await response.json());
    const dest = join(catalogDir, `${provider}.json`);
    const tmp = `${dest}.${process.pid}`;
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(tmp, json);
    renameSync(tmp, dest);
  } finally {
    clearTimeout(timer);
  }
}

async function loadProviderModels(catalogDir: string, provider: string, config: ProviderConfig): Promise<Model[]> {
  // Refresh in the background for next startup; only block when no cached catalog exists yet.
  const refresh = refreshCatalog(catalogDir, provider, config).catch(() => {});
  const dest = join(catalogDir, `${provider}.json`);
  const readCached = () => PROVIDERS[provider].models(JSON.parse(readText(dest, "{}")));
  if (!readCached().length) await refresh;
  return readCached().map((meta) => ({ ...meta, ...config, provider }));
}

export async function loadModels(home: string): Promise<Model[]> {
  const modelsFile = join(home, "models.json");
  const catalogDir = join(home, "catalog");
  const configs: Record<string, { apiKey: string; baseUrl?: string }> =
    JSON.parse(readText(modelsFile, "{}")).providers ?? {};

  const lists = await Promise.all(
    Object.entries(configs)
      .filter(([provider]) => provider in PROVIDERS)
      .map(([provider, { apiKey, baseUrl }]) =>
        loadProviderModels(catalogDir, provider, { apiKey, baseUrl: baseUrl ?? PROVIDERS[provider].baseUrl }),
      ),
  );
  return lists.flat().sort((a, b) => compareNames(modelRef(a), modelRef(b)));
}
