import {
  asPlainText,
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

function extractAccountId(jwt: string): string {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    const id = claims["https://api.openai.com/auth"].chatgpt_account_id;
    if (typeof id === "string") return id;
  } catch {}
  throw new Error("The key is not a ChatGPT token: it names no account.");
}

const headersFor = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`,
  "chatgpt-account-id": extractAccountId(apiKey),
});

export const codex: ProviderApi = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  // client_version=999.0.0 prevents the backend from hiding newer models behind CLI version checks.
  listing: ({ baseUrl, apiKey }) => ({
    url: `${baseUrl}/models?client_version=999.0.0`,
    headers: headersFor(apiKey),
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
        ...headersFor(model.apiKey),
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
