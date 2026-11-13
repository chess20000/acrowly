import fs from "node:fs/promises";
import type { ChatMessage, ContextConfig, ContextState } from "../types.js";
import { writeFileAtomic } from "../config/store.js";

/**
 * Rough token estimator (~3.5 chars per token on mixed CJK/English text).
 * Used as fallback when provider usage counters aren't available yet.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.2);
}

export class ContextStore {
  private state: ContextState = {
    frozenSummary: "",
    activeFromSeq: 0,
    lastEstimatedPromptTokens: 0,
    totalCompactions: 0,
  };

  constructor(private readonly contextPath: string) {}

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.contextPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ContextState>;
      this.state = {
        frozenSummary: parsed.frozenSummary ?? "",
        activeFromSeq: parsed.activeFromSeq ?? 0,
        lastEstimatedPromptTokens: parsed.lastEstimatedPromptTokens ?? 0,
        lastCompactedAt: parsed.lastCompactedAt,
        totalCompactions: parsed.totalCompactions ?? 0,
      };
    } catch {
      await this.save();
    }
  }

  getState(): ContextState {
    return this.state;
  }

  /**
   * Returns stable frozen summary + active messages strictly after activeFromSeq.
   * Because the prefix stays immutable between compactions, provider prompt caching stays hot.
   */
  getPromptWindow(allMessages: readonly ChatMessage[]): {
    frozenSummary: string;
    activeMessages: ChatMessage[];
    estimatedTokens: number;
  } {
    const activeMessages = allMessages.filter((m) => m.seq > this.state.activeFromSeq);
    const summaryTokens = estimateTokens(this.state.frozenSummary);
    const activeTokens = activeMessages.reduce((sum, m) => sum + estimateTokens(m.text) + 12, 0);
    return {
      frozenSummary: this.state.frozenSummary,
      activeMessages,
      estimatedTokens: summaryTokens + activeTokens,
    };
  }

  async recordPromptTokenEstimate(tokens: number): Promise<void> {
    this.state.lastEstimatedPromptTokens = tokens;
    await this.save();
  }

  selectMessagesToCompact(
    allMessages: readonly ChatMessage[],
    config: ContextConfig
  ): { toCompact: ChatMessage[]; newActiveFromSeq: number } | undefined {
    const active = allMessages.filter((m) => m.seq > this.state.activeFromSeq);
    const keepCount = Math.max(config.keepRecentMessages, 2);
    if (active.length <= keepCount + 2) {
      return undefined;
    }
    const splitIndex = active.length - keepCount;
    const toCompact = active.slice(0, splitIndex);
    const lastCompacted = toCompact[toCompact.length - 1];
    return {
      toCompact,
      newActiveFromSeq: lastCompacted.seq,
    };
  }

  async applyCompaction(newFrozenSummary: string, newActiveFromSeq: number): Promise<ContextState> {
    this.state.frozenSummary = newFrozenSummary.trim();
    this.state.activeFromSeq = newActiveFromSeq;
    this.state.lastCompactedAt = new Date().toISOString();
    this.state.totalCompactions += 1;
    this.state.lastEstimatedPromptTokens = estimateTokens(this.state.frozenSummary);
    await this.save();
    return this.state;
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.contextPath, JSON.stringify(this.state, null, 2));
  }
}
