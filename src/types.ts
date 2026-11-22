import { existsSync, readFileSync } from "node:fs";

export type TextBlock = { type: "text"; text: string; sealed?: any };
export type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ThinkingBlock = { type: "thinking"; text: string; sealed?: any; redacted?: boolean };
export type ToolCall = { type: "call"; id: string; name: string; arguments: Record<string, unknown>; sealed?: any };
export type ToolSchema = { name: string; description: string; parameters: object };
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type SessionHeader = { cwd: string; prompt: string; tools: ToolSchema[]; timestamp: number };
export type UserMessage = { content: (TextBlock | ImageBlock)[]; timestamp: number };
export type AssistantReply = {
  provider: string;
  model: string;
  content: (TextBlock | ThinkingBlock | ToolCall)[];
  usage: Usage;
  timestamp: number;
  end?: "cut" | "stopped" | "failed" | "refused";
  why?: string;
  status?: number;
};
export type ToolResult = { call: string; content: (TextBlock | ImageBlock)[]; failed: boolean; timestamp: number };
export type MessageEntry = { user: UserMessage } | { reply: AssistantReply } | { result: ToolResult };

export const CONFIG_KEYS = ["model", "thinking", "cache"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type ConfigValues = Partial<Record<ConfigKey, string>>;
export type SessionLine = ConfigValues & {
  began?: SessionHeader;
  user?: UserMessage;
  reply?: AssistantReply;
  result?: ToolResult;
  forked?: string;
};

export const THINKING_LEVELS = ["off", "on", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CACHE_MODES = ["none", "short", "long"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type CacheMode = (typeof CACHE_MODES)[number];

export type ProviderConfig = { apiKey: string; baseUrl: string };
export type ModelMeta = { id: string; name: string; contextWindow: number; levels: ThinkingLevel[]; listed: any };
export type Model = ModelMeta & ProviderConfig & { provider: string };
export type RequestOptions = { origin: string; thinking: ThinkingLevel; cache: CacheMode; signal: AbortSignal };
export type StreamCallback = (kind: "text" | "thinking", delta: string) => void;

export type ProviderApi = {
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

export const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
export const readText = (path: string, fallback = "") => (existsSync(path) ? readFileSync(path, "utf8") : fallback);

export function parseJson(line: string) {
  try {
    return JSON.parse(line) ?? {};
  } catch {
    return {};
  }
}

export const isMessageEntry = (line: SessionLine): line is SessionLine & MessageEntry =>
  Boolean(line.user || line.reply || line.result);
export const isEmptyContent = (content: (TextBlock | ImageBlock)[]) =>
  content.every((block) => block.type === "text" && !block.text.trim());
export const notice = (text: string) => `(bee: ${text})`;
export const modelRef = (model: Model) => `${model.provider}/${model.id}`;
export const extractText = (content: { type: string; text?: string }[]) => content.map((b) => b.text ?? "").join("");
export const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 80);

export const makeUserMessage = (content: UserMessage["content"]): UserMessage => ({ content, timestamp: Date.now() });
export const makeToolResult = (call: ToolCall, content: ToolResult["content"], failed: boolean): ToolResult => ({
  call: call.id,
  content,
  failed,
  timestamp: Date.now(),
});

// Provider tool call IDs must match [\w-] and fit within 64 chars.
export const normalizeCallId = (id: string) => id.replace(/[^\w-]/g, "_").slice(0, 64);

export const asPlainText = (content: ToolResult["content"]) =>
  content.every((block): block is TextBlock => block.type === "text")
    ? content.map((block) => block.text).join("\n")
    : undefined;

export const cacheControl = (cache: CacheMode) =>
  cache === "none" ? {} : { cache_control: { type: "ephemeral", ...(cache === "long" && { ttl: "1h" }) } };
