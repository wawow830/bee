import {
  cacheControl,
  normalizeCallId,
  THINKING_LEVELS,
  type AssistantReply,
  type MessageEntry,
  type ProviderApi,
  type TextBlock,
  type ThinkingBlock,
  type ToolCall,
  type UserMessage,
} from "../types";

const APPENDED_REASONING_FIELDS = ["text", "summary", "data"];

const supportedLevels = ({ reasoning }: any): string[] =>
  reasoning?.supported_efforts?.map((effort: string) => (effort === "none" ? "off" : effort)) ??
  (reasoning ? [...(reasoning.mandatory ? [] : ["off"]), "on"] : ["off"]);

export const openrouter: ProviderApi = {
  baseUrl: "https://openrouter.ai/api/v1",
  listing: ({ baseUrl, apiKey }) => ({ url: `${baseUrl}/models`, headers: { authorization: `Bearer ${apiKey}` } }),
  models: (payload) =>
    (payload.data ?? [])
      .filter((item: any) => item.supported_parameters?.includes("tools"))
      .map((item: any) => {
        const { id, name, context_length: contextWindow } = item;
        const levels = supportedLevels(item);
        return { id, name, contextWindow, levels: THINKING_LEVELS.filter((l) => levels.includes(l)), listed: item };
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
      if ("result" in entry) {
        return {
          role: "tool",
          tool_call_id: normalizeCallId(entry.result.call),
          content: encodeContent(entry.result.content),
        };
      }
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
