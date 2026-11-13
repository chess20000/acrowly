import crypto from "node:crypto";
import type { ModelProfile, SubagentRunRecord } from "../types.js";
import type { LlmClient } from "../llm/client.js";
import { toAssistantLlmMessage, type LlmMessage, type ToolDefinition } from "../llm/types.js";
import { buildSubagentSystemPrompt } from "./prompts.js";

export interface SubagentToolExecutor {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export class SubagentManager {
  private runs = new Map<string, SubagentRunRecord>();
  private activePromises = new Set<Promise<SubagentRunRecord>>();

  constructor(
    private readonly llm: LlmClient,
    private readonly paths: { rootDir: string; webuiDir: string; extensionsDir: string }
  ) {}

  listRuns(limit = 20): SubagentRunRecord[] {
    return Array.from(this.runs.values()).slice(-limit).reverse();
  }

  async waitForAll(): Promise<void> {
    if (this.activePromises.size === 0) return;
    await Promise.allSettled(Array.from(this.activePromises));
  }

  async runTask(input: {
    label: string;
    task: string;
    profile: ModelProfile;
    tools: SubagentToolExecutor;
    maxSteps?: number;
    signal?: AbortSignal;
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

    const taskPromise = this.executeRun(record, input);
    this.activePromises.add(taskPromise);
    try {
      return await taskPromise;
    } finally {
      this.activePromises.delete(taskPromise);
    }
  }

  private async executeRun(
    record: SubagentRunRecord,
    input: {
      label: string;
      task: string;
      profile: ModelProfile;
      tools: SubagentToolExecutor;
      maxSteps?: number;
      signal?: AbortSignal;
    }
  ): Promise<SubagentRunRecord> {

    const systemPrompt = buildSubagentSystemPrompt(this.paths);
    const messages: LlmMessage[] = [{ role: "user", content: input.task }];
    const maxSteps = input.maxSteps ?? 25;

    const markInterrupted = (): SubagentRunRecord => {
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      record.error = "Interrupted";
      return record;
    };

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        if (input.signal?.aborted) {
          return markInterrupted();
        }

        const res = await this.llm.chat({
          profile: input.profile,
          systemPrompt,
          messages,
          tools: input.tools.definitions,
          temperature: 0.2,
          signal: input.signal,
        });

        messages.push(toAssistantLlmMessage(res));

        if (res.toolCalls.length === 0) {
          record.status = "completed";
          record.finishedAt = new Date().toISOString();
          record.resultSummary = res.content.trim() || "(Task completed without text summary.)";
          return record;
        }

        for (const call of res.toolCalls) {
          if (input.signal?.aborted) {
            return markInterrupted();
          }
          let toolOutput: string;
          try {
            toolOutput = await input.tools.execute(call.name, call.arguments);
          } catch (err) {
            if (input.signal?.aborted) {
              return markInterrupted();
            }
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
      if (input.signal?.aborted) {
        return markInterrupted();
      }
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      record.error = err instanceof Error ? err.message : String(err);
      return record;
    }
  }
}
