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
  toolCalls: ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
}
