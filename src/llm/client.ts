import crypto from "node:crypto";
import type { ModelProfile } from "../types.js";
import type { ConfigStore } from "../config/store.js";
import { getDefaultBaseUrlForProvider } from "../config/store.js";
import type { LlmMessage, LlmResponse, ToolCall, ToolDefinition } from "./types.js";

export interface LlmChatRequest {
  profile: ModelProfile;
  systemPrompt: string;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

function safeJsonParseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw };
    }
  }
  return {};
}

export class LlmClient {
  constructor(private readonly configStore: ConfigStore) {}

  async chat(req: LlmChatRequest): Promise<LlmResponse> {
    const apiKey = this.configStore.getSecret(req.profile.apiKeyRef) ?? "";
    if (!apiKey && req.profile.provider !== "ollama" && req.profile.provider !== "custom") {
      throw new Error(`Missing API key for model alias "${req.profile.alias}".`);
    }

    switch (req.profile.provider) {
      case "gemini":
        return this.callGemini(req, apiKey);
      case "anthropic":
        return this.callAnthropic(req, apiKey);
      case "openai":
      case "deepseek":
      case "openrouter":
      case "ollama":
      case "custom":
        return this.callOpenAiCompatible(req, apiKey);
    }
  }

  private async callOpenAiCompatible(req: LlmChatRequest, apiKey: string): Promise<LlmResponse> {
    const baseUrl = (
      req.profile.baseUrl ||
      getDefaultBaseUrlForProvider(req.profile.provider) ||
      "https://api.openai.com/v1"
    ).replace(/\/+$/, "");

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: req.systemPrompt },
    ];

    for (const msg of req.messages) {
      if (msg.role === "user") {
        if (msg.images && msg.images.length > 0) {
          const parts: Array<Record<string, unknown>> = [{ type: "text", text: msg.content }];
          for (const img of msg.images) {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${img.mime};base64,${img.base64}` },
            });
          }
          messages.push({ role: "user", content: parts });
        } else {
          messages.push({ role: "user", content: msg.content });
        }
      } else if (msg.role === "assistant") {
        const entry: Record<string, unknown> = {
          role: "assistant",
          content: msg.content || (msg.toolCalls?.length ? null : ""),
        };
        if (msg.reasoningContent !== undefined) {
          entry.reasoning_content = msg.reasoningContent;
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          entry.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        messages.push(entry);
      } else if (msg.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        });
      }
    }

    const body: Record<string, unknown> = {
      model: req.profile.model,
      messages,
      temperature: req.temperature ?? 0.4,
    };

    if (req.maxTokens) {
      body.max_tokens = req.maxTokens;
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM HTTP ${res.status} (${req.profile.provider}): ${errText.slice(0, 600)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choiceMsg = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (choiceMsg?.tool_calls ?? []).map((tc) => ({
      id: tc.id || `tc_${crypto.randomBytes(6).toString("hex")}`,
      name: tc.function?.name || "",
      arguments: safeJsonParseObject(tc.function?.arguments),
    }));

    return {
      content: choiceMsg?.content ?? "",
      ...(typeof choiceMsg?.reasoning_content === "string"
        ? { reasoningContent: choiceMsg.reasoning_content }
        : {}),
      toolCalls,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    };
  }

  private async callAnthropic(req: LlmChatRequest, apiKey: string): Promise<LlmResponse> {
    const baseUrl = (
      req.profile.baseUrl ||
      getDefaultBaseUrlForProvider("anthropic") ||
      "https://api.anthropic.com/v1"
    ).replace(/\/+$/, "");

    const messages: Array<Record<string, unknown>> = [];

    for (const msg of req.messages) {
      if (msg.role === "user") {
        if (msg.images && msg.images.length > 0) {
          const blocks: Array<Record<string, unknown>> = [];
          for (const img of msg.images) {
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: img.mime,
                data: img.base64,
              },
            });
          }
          blocks.push({ type: "text", text: msg.content });
          messages.push({ role: "user", content: blocks });
        } else {
          messages.push({ role: "user", content: msg.content });
        }
      } else if (msg.role === "assistant") {
        const blocks: Array<Record<string, unknown>> = [];
        if (msg.content) {
          blocks.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        messages.push({ role: "assistant", content: blocks.length ? blocks : "" });
      } else if (msg.role === "tool") {
        // Merge consecutive tool results into a single user message per Anthropic API rules
        const block = {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.content,
        };
        const prev = messages[messages.length - 1];
        if (prev && prev.role === "user" && Array.isArray(prev.content)) {
          (prev.content as Array<Record<string, unknown>>).push(block);
        } else {
          messages.push({ role: "user", content: [block] });
        }
      }
    }

    const body: Record<string, unknown> = {
      model: req.profile.model,
      max_tokens: req.maxTokens ?? 8192,
      system: [
        {
          type: "text",
          text: req.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
      temperature: req.temperature ?? 0.4,
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM HTTP ${res.status} (anthropic): ${errText.slice(0, 600)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use" && block.name) {
        toolCalls.push({
          id: block.id || `tc_${crypto.randomBytes(6).toString("hex")}`,
          name: block.name,
          arguments: safeJsonParseObject(block.input),
        });
      }
    }

    return {
      content: textParts.join("\n"),
      toolCalls,
      promptTokens: data.usage?.input_tokens,
      completionTokens: data.usage?.output_tokens,
    };
  }

  private async callGemini(req: LlmChatRequest, apiKey: string): Promise<LlmResponse> {
    const baseUrl = (
      req.profile.baseUrl ||
      getDefaultBaseUrlForProvider("gemini") ||
      "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");

    const contents: Array<Record<string, unknown>> = [];

    for (const msg of req.messages) {
      if (msg.role === "user") {
        const parts: Array<Record<string, unknown>> = [];
        for (const img of msg.images ?? []) {
          parts.push({
            inlineData: {
              mimeType: img.mime,
              data: img.base64,
            },
          });
        }
        parts.push({ text: msg.content });
        contents.push({ role: "user", parts });
      } else if (msg.role === "assistant") {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        for (const tc of msg.toolCalls ?? []) {
          const part: Record<string, unknown> = {
            functionCall: {
              name: tc.name,
              args: tc.arguments,
            },
          };
          if (tc.providerMeta?.thoughtSignature) {
            part.thoughtSignature = tc.providerMeta.thoughtSignature;
          }
          parts.push(part);
        }
        if (parts.length > 0) {
          contents.push({ role: "model", parts });
        }
      } else if (msg.role === "tool") {
        let responseObj: Record<string, unknown>;
        try {
          const parsed = JSON.parse(msg.content);
          responseObj =
            typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : { result: parsed };
        } catch {
          responseObj = { result: msg.content };
        }
        const part = {
          functionResponse: {
            name: msg.toolName,
            response: responseObj,
          },
        };
        const prev = contents[contents.length - 1];
        if (prev && prev.role === "user" && Array.isArray(prev.parts) && prev.parts.every((p: Record<string, unknown>) => "functionResponse" in p)) {
          (prev.parts as Array<Record<string, unknown>>).push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
        }
      }
    }

    const body: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: req.systemPrompt }],
      },
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.4,
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
      },
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const modelName = req.profile.model.replace(/^models\//, "");
    const res = await fetch(`${baseUrl}/models/${encodeURIComponent(modelName)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM HTTP ${res.status} (gemini): ${errText.slice(0, 600)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            thought?: boolean;
            thoughtSignature?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const p of parts) {
      if (p.thought) continue;
      if (p.text) {
        textParts.push(p.text);
      } else if (p.functionCall?.name) {
        toolCalls.push({
          id: `tc_${crypto.randomBytes(6).toString("hex")}`,
          name: p.functionCall.name,
          arguments: safeJsonParseObject(p.functionCall.args),
          ...(p.thoughtSignature ? { providerMeta: { thoughtSignature: p.thoughtSignature } } : {}),
        });
      }
    }

    return {
      content: textParts.join("\n"),
      toolCalls,
      promptTokens: data.usageMetadata?.promptTokenCount,
      completionTokens: data.usageMetadata?.candidatesTokenCount,
    };
  }
}
