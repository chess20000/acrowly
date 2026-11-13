import crypto from "node:crypto";
import type { ModelProfile, SubagentRunRecord } from "../types.js";
import type { LlmClient } from "../llm/client.js";
import type { LlmMessage, ToolDefinition } from "../llm/types.js";
import { buildSubagentSystemPrompt } from "./prompts.js";

export interface SubagentToolExecutor {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export class SubagentManager {
  private runs = new Map<string, SubagentRunRecord>();

  constructor(
    private readonly llm: LlmClient,
    private readonly paths: { rootDir: string; webuiDir: string; extensionsDir: string }
  ) {}

  listRuns(limit = 20): SubagentRunRecord[] {
    return Array.from(this.runs.values()).slice(-limit).reverse();
  }

  async runTask(input: {
    label: string;
    task: string;
    profile: ModelProfile;
    tools: SubagentToolExecutor;
    maxSteps?: number;
  }): Promise<SubagentRunRecord> {
    const id = `sub_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    const record: SubagentRunRecord = {
      id,
      label: input.label,
      task: input.task,
      modelAlias: input.profile.alias,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.runs.set(id, record);

    const systemPrompt = buildSubagentSystemPrompt(this.paths);
    const messages: LlmMessage[] = [{ role: "user", content: input.task }];
    const maxSteps = input.maxSteps ?? 25;

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        const res = await this.llm.chat({
          profile: input.profile,
          systemPrompt,
          messages,
          tools: input.tools.definitions,
          temperature: 0.2,
        });

        messages.push({
          role: "assistant",
          content: res.content,
          ...(res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}),
        });

        if (res.toolCalls.length === 0) {
          record.status = "completed";
          record.finishedAt = new Date().toISOString();
          record.resultSummary = res.content.trim() || "(Task completed without text summary.)";
          return record;
        }

        for (const call of res.toolCalls) {
          let toolOutput: string;
          try {
            toolOutput = await input.tools.execute(call.name, call.arguments);
          } catch (err) {
            toolOutput = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
          }
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: toolOutput,
          });
        }
      }

      record.status = "completed";
      record.finishedAt = new Date().toISOString();
      record.resultSummary =
        "Reached maximum subagent execution steps; inspect modified files or logs for partial results.";
      return record;
    } catch (err) {
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      record.error = err instanceof Error ? err.message : String(err);
      return record;
    }
  }
}
