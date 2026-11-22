import {
  asPlainText,
  cacheControl,
  normalizeCallId,
  THINKING_LEVELS,
  type AssistantReply,
  type MessageEntry,
  type ProviderApi,
  type TextBlock,
  type ThinkingBlock,
  type ThinkingLevel,
  type ToolCall,
  type UserMessage,
} from "../types";

const STOP_REASONS: Record<string, AssistantReply["end"]> = {
  end_turn: undefined,
  pause_turn: undefined,
  stop_sequence: undefined,
  tool_use: undefined,
  max_tokens: "cut",
};

const isOAuth = (apiKey: string) => apiKey.includes("sk-ant-oat");

const headersFor = (apiKey: string) => ({
  "anthropic-version": "2023-06-01",
  ...(isOAuth(apiKey)
    ? { authorization: `Bearer ${apiKey}`, "anthropic-beta": "oauth-2025-04-20" }
    : { "x-api-key": apiKey }),
});

export const anthropic: ProviderApi = {
  baseUrl: "https://api.anthropic.com",
  listing: ({ baseUrl, apiKey }) => ({ url: `${baseUrl}/v1/models?limit=1000`, headers: headersFor(apiKey) }),
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
      headers: headersFor(model.apiKey),
      body: {
        model: model.id,
        max_tokens: model.listed.max_tokens,
        stream: true,
        system: [
          ...(isOAuth(model.apiKey) ? [claudeCodeIdentity] : []),
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
          if (!(stopDelta.stop_reason! in STOP_REASONS))
            throw new Error(stopDelta.stop_details?.explanation ?? `The model stopped: ${stopDelta.stop_reason}`);
          reply.end = STOP_REASONS[stopDelta.stop_reason!];
          return;
      }
    }
    throw new Error("The stream ended before the reply did");
  },
};
