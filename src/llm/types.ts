export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Preserved provider-specific metadata (e.g. Gemini thoughtSignature) */
  providerMeta?: Record<string, unknown>;
}

export interface LlmImagePart {
  mime: string;
  base64: string;
}

export type LlmMessage =
  | {
      role: "user";
      content: string;
      images?: LlmImagePart[];
    }
  | {
      role: "assistant";
      content: string;
      reasoningContent?: string;
      toolCalls?: ToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      content: string;
    };

export interface LlmResponse {
  content: string;
  reasoningContent?: string;
  toolCalls: ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
}

export function toAssistantLlmMessage(
  res: Pick<LlmResponse, "content" | "reasoningContent" | "toolCalls">
): LlmMessage {
  return {
    role: "assistant",
    content: res.content,
    ...(res.reasoningContent !== undefined ? { reasoningContent: res.reasoningContent } : {}),
    ...(res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}),
  };
}
