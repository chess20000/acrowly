import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../types.js";
import { maskSecret, writeFileAtomic } from "../config/store.js";

export type ChatListener = (message: ChatMessage) => void;

export class ChatStore {
  private readonly logPath: string;
  private messages: ChatMessage[] = [];
  private latestSeq = 0;
  private byClientMsgId = new Map<string, ChatMessage>();
  private listeners = new Set<ChatListener>();

  constructor(chatDir: string) {
    this.logPath = path.join(chatDir, "messages.jsonl");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    try {
      const content = await fs.readFile(this.logPath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      this.messages = [];
      this.byClientMsgId.clear();
      for (const line of lines) {
        const msg = JSON.parse(line) as ChatMessage;
        this.messages.push(msg);
        if (msg.seq > this.latestSeq) this.latestSeq = msg.seq;
        if (msg.clientMsgId) this.byClientMsgId.set(msg.clientMsgId, msg);
      }
    } catch {
      await fs.writeFile(this.logPath, "", "utf8");
    }
  }

  getLatestSeq(): number {
    return this.latestSeq;
  }

  getAllMessages(): readonly ChatMessage[] {
    return this.messages;
  }

  getMessages(options: { afterSeq?: number; beforeSeq?: number; limit?: number }): {
    messages: ChatMessage[];
    latestSeq: number;
  } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    if (options.afterSeq !== undefined) {
      const filtered = this.messages.filter((m) => m.seq > options.afterSeq!);
      return {
        messages: filtered.slice(0, limit),
        latestSeq: this.latestSeq,
      };
    }

    if (options.beforeSeq !== undefined) {
      const filtered = this.messages.filter((m) => m.seq < options.beforeSeq!);
      return {
        messages: filtered.slice(-limit),
        latestSeq: this.latestSeq,
      };
    }

    return {
      messages: this.messages.slice(-limit),
      latestSeq: this.latestSeq,
    };
  }

  async appendMessage(input: {
    role: "user" | "assistant";
    text: string;
    clientMsgId?: string;
  }): Promise<{ message: ChatMessage; duplicate: boolean }> {
    if (input.clientMsgId) {
      const existing = this.byClientMsgId.get(input.clientMsgId);
      if (existing) {
        return { message: existing, duplicate: true };
      }
    }

    this.latestSeq += 1;
    const message: ChatMessage = {
      seq: this.latestSeq,
      id: `msg_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
      role: input.role,
      text: input.text,
      createdAt: new Date().toISOString(),
      ...(input.clientMsgId ? { clientMsgId: input.clientMsgId } : {}),
    };

    this.messages.push(message);
    if (message.clientMsgId) {
      this.byClientMsgId.set(message.clientMsgId, message);
    }

    await fs.appendFile(this.logPath, `${JSON.stringify(message)}\n`, "utf8");

    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // Listener failures must never crash store writes
      }
    }

    return { message, duplicate: false };
  }

  /**
   * Redact newly registered secrets (e.g. API keys or passcodes sent in chat)
   * from stored timeline history so credentials aren't left exposed across devices.
   */
  async redactSecretInHistory(secret: string): Promise<number> {
    const trimmed = secret.trim();
    if (trimmed.length < 6) return 0;

    const masked = maskSecret(trimmed);
    let updatedCount = 0;

    for (const msg of this.messages) {
      if (msg.text.includes(trimmed)) {
        msg.text = msg.text.split(trimmed).join(masked);
        updatedCount += 1;
      }
    }

    if (updatedCount > 0) {
      const serialized = this.messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      await writeFileAtomic(this.logPath, serialized, 0o600);
    }

    return updatedCount;
  }

  subscribe(listener: ChatListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
