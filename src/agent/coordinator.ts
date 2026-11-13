import type { ConfigStore } from "../config/store.js";
import type { ExtensionLoader } from "../extensions/loader.js";
import type { SnapshotManager } from "../extensions/snapshot.js";
import type { LlmClient } from "../llm/client.js";
import type { LlmImagePart, LlmMessage } from "../llm/types.js";
import type { AttachmentStore } from "../storage/attachment-store.js";
import type { ChatStore } from "../storage/chat-store.js";
import { ContextStore, estimateTokens } from "../storage/context-store.js";
import type { ChatMessage } from "../types.js";
import { buildCoordinatorSystemPrompt } from "./prompts.js";
import type { SubagentManager } from "./subagent.js";
import {
  executeCoordinatorTool,
  getCoordinatorToolDefinitions,
  type ToolRuntimeDeps,
} from "./tools.js";

const SUPPORTED_VISION_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const FILE_REF_REGEX = /\/api\/files\/(file_[a-z0-9_]+)/gi;

export class CoordinatorEngine {
  private running = false;
  private stopped = false;
  private rerunRequested = false;
  private lastActivityAt = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;
  private activeRunPromise: Promise<void> | undefined;
  private abortController: AbortController | undefined;
  private compactionPromise: Promise<string> | undefined;

  constructor(
    private readonly deps: {
      configStore: ConfigStore;
      chatStore: ChatStore;
      attachmentStore: AttachmentStore;
      contextStore: ContextStore;
      extensionLoader: ExtensionLoader;
      snapshotManager: SnapshotManager;
      subagentManager: SubagentManager;
      llm: LlmClient;
      onRelayConfigUpdated?: () => void;
      getRelayConnected?: () => boolean;
    }
  ) {}

  startBackgroundLoops(): void {
    this.stopped = false;
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.checkIdleCompaction();
    }, 60_000);
    this.idleTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.rerunRequested = false;
    this.stopBackgroundLoops();
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.activeRunPromise) {
      await this.activeRunPromise.catch(() => {});
    }
    if (this.compactionPromise) {
      await this.compactionPromise.catch(() => {});
    }
  }

  stopBackgroundLoops(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  notifyUserMessage(): void {
    if (this.stopped) return;
    this.lastActivityAt = Date.now();
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.activeRunPromise = this.runLoop().finally(() => {
      this.activeRunPromise = undefined;
    });
  }

  async sendWelcomeGreetingIfEmpty(): Promise<void> {
    if (this.deps.chatStore.getAllMessages().length > 0) return;
    const config = this.deps.configStore.getConfig();
    const model = config.models[config.coordinatorModelAlias];
    const greeting = model
      ? `你好！我是你的 Acrowly 主协调器（当前脑子接的是 **${model.provider} / ${model.model}**）。\n\n` +
        `先说下咱们怎么配合：以后你只要直接跟我聊天，脏活累活我都会拆给子代理去跑，自己专心帮你把关、顺便给你讲讲里面的门道。\n\n` +
        `现在咱们刚启动完最核心的无头后端（本机客户端 Ed25519 公钥已自动授权，整个服务只认密钥、不用记密码）。你接下来想先做哪几件事？比如：\n` +
        `1. 把你的手机 / 浏览器等客户端生成的 **Ed25519 公钥**直接贴给我，我帮你加进授权列表；\n` +
        `2. 配好 \`acrowly.com\` 穿透连接（没有公网 IP 也能随时随地连回来）；\n` +
        `3. 让我现场派个子代理给你写一个自带密钥登录的极简单对话框本地 WebUI！\n\n` +
        `直接用平时说话的方式告诉我你想先弄哪个就行。`
      : `你好！我是你的 Acrowly 主协调器，目前还没有配置模型，请先完成首次启动配置。`;

    await this.deps.chatStore.appendMessage({
      role: "assistant",
      text: greeting,
    });
  }

  private createToolDeps(): ToolRuntimeDeps {
    return {
      ...this.deps,
      onTriggerCompaction: () => this.compactContext("manual"),
    };
  }

  private async runLoop(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      do {
        this.rerunRequested = false;
        if (this.stopped) break;
        await this.executeTurn();
      } while (this.rerunRequested && !this.stopped);
    } finally {
      this.running = false;
      this.lastActivityAt = Date.now();
    }
  }

  private async executeTurn(): Promise<void> {
    const config = this.deps.configStore.getConfig();
    const profile = config.models[config.coordinatorModelAlias];
    if (!profile) {
      await this.deps.chatStore.appendMessage({
        role: "assistant",
        text: "目前还没有配置协调器模型，请先完成首次初始化或提供模型配置。",
      });
      return;
    }

    const allMessages = this.deps.chatStore.getAllMessages();
    const windowInfo = this.deps.contextStore.getPromptWindow(allMessages);

    if (windowInfo.estimatedTokens >= config.context.compactionTokenThreshold) {
      await this.compactContext("threshold_pre");
    }

    const refreshedWindow = this.deps.contextStore.getPromptWindow(
      this.deps.chatStore.getAllMessages()
    );

    const llmMessages: LlmMessage[] = [];
    let lastLoadedSeq = refreshedWindow.activeMessages[refreshedWindow.activeMessages.length - 1]?.seq ?? 0;

    for (const msg of refreshedWindow.activeMessages) {
      if (msg.role === "user") {
        llmMessages.push(await this.buildLlmUserMessage(msg.text));
      } else {
        llmMessages.push({
          role: "assistant",
          content: msg.text,
        });
      }
    }

    if (llmMessages.length === 0) return;

    const toolDeps = this.createToolDeps();
    const maxSteps = 20;
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      let latestPromptTokens = refreshedWindow.estimatedTokens;

      for (let step = 0; step < maxSteps; step += 1) {
        if (this.stopped || abortController.signal.aborted) break;
        // Pull in any user messages sent mid-turn (steering)
        const steered = await this.drainMidTurnMessages(lastLoadedSeq, llmMessages);
        if (steered.newLastSeq > lastLoadedSeq) {
          lastLoadedSeq = steered.newLastSeq;
        }

        const currentConfig = this.deps.configStore.getConfig();
        const currentProfile = currentConfig.models[currentConfig.coordinatorModelAlias] ?? profile;
        const loadedExtensions = this.deps.extensionLoader.getTools().map((t) => t.name);
        const systemPrompt = buildCoordinatorSystemPrompt(
          currentConfig,
          loadedExtensions,
          this.deps.contextStore.getState().frozenSummary,
          this.deps.configStore.paths
        );

        const tools = getCoordinatorToolDefinitions(this.deps.extensionLoader);

        const res = await this.deps.llm.chat({
          profile: currentProfile,
          systemPrompt,
          messages: llmMessages,
          tools,
          temperature: 0.4,
          signal: abortController.signal,
        });

        if (this.stopped || abortController.signal.aborted) break;

        if (res.promptTokens !== undefined) {
          latestPromptTokens = res.promptTokens;
          await this.deps.contextStore.recordPromptTokenEstimate(res.promptTokens);
        } else {
          const fallbackEstimate =
            estimateTokens(systemPrompt) +
            llmMessages.reduce(
              (acc, m) => acc + estimateTokens("content" in m ? m.content : "") + 20,
              0
            );
          latestPromptTokens = fallbackEstimate;
          await this.deps.contextStore.recordPromptTokenEstimate(fallbackEstimate);
        }

        llmMessages.push({
          role: "assistant",
          content: res.content,
          ...(res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}),
        });

        if (res.toolCalls.length === 0) {
          const replyText = res.content.trim();
          if (replyText) {
            await this.deps.chatStore.appendMessage({
              role: "assistant",
              text: replyText,
            });
          }
          // Check if a user message arrived while we were awaiting final LLM response
          const trailing = this.deps.chatStore.getMessages({ afterSeq: lastLoadedSeq, limit: 20 });
          if (trailing.messages.some((m) => m.role === "user")) {
            this.rerunRequested = true;
          }
          break;
        }

        // Execute tool calls concurrently when multiple are issued (e.g. parallel subagents)
        const results = await Promise.all(
          res.toolCalls.map(async (call) => {
            try {
              const output = await executeCoordinatorTool(call.name, call.arguments, toolDeps);
              return { call, output };
            } catch (err) {
              return {
                call,
                output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          })
        );

        for (const item of results) {
          llmMessages.push({
            role: "tool",
            toolCallId: item.call.id,
            toolName: item.call.name,
            content: item.output,
          });
        }
      }

      if (!this.stopped && latestPromptTokens >= this.deps.configStore.getConfig().context.compactionTokenThreshold) {
        await this.compactContext("threshold_post");
      }
    } catch (err) {
      if (this.stopped || abortController.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.chatStore.appendMessage({
        role: "assistant",
        text: `刚才调用模型或工具时出了点岔子：\`${msg}\`。你可以检查一下 API Key、额度或者网络连通性，修正后直接再跟我说一声就行。`,
      });
    } finally {
      if (this.abortController === abortController) {
        this.abortController = undefined;
      }
    }
  }

  private async drainMidTurnMessages(
    lastLoadedSeq: number,
    llmMessages: LlmMessage[]
  ): Promise<{ newLastSeq: number }> {
    const { messages } = this.deps.chatStore.getMessages({
      afterSeq: lastLoadedSeq,
      limit: 50,
    });
    let maxSeq = lastLoadedSeq;
    for (const msg of messages) {
      if (msg.seq > maxSeq) maxSeq = msg.seq;
      if (msg.role === "user") {
        llmMessages.push(await this.buildLlmUserMessage(msg.text));
      }
    }
    return { newLastSeq: maxSeq };
  }

  private async buildLlmUserMessage(text: string): Promise<LlmMessage> {
    const matches = Array.from(text.matchAll(FILE_REF_REGEX));
    if (matches.length === 0) {
      return { role: "user", content: text };
    }

    const seen = new Set<string>();
    const images: LlmImagePart[] = [];
    const attachmentLines: string[] = [];

    for (const match of matches) {
      const fileId = match[1];
      if (!fileId || seen.has(fileId)) continue;
      seen.add(fileId);

      const meta = this.deps.attachmentStore.getMeta(fileId);
      if (!meta) continue;

      attachmentLines.push(
        `- ${meta.name} | kind=${meta.kind} | mime=${meta.mime} | size=${meta.size} bytes | localPath=${meta.storedPath}`
      );

      if (
        meta.kind === "image" &&
        SUPPORTED_VISION_MIMES.has(meta.mime) &&
        meta.size <= 8 * 1024 * 1024
      ) {
        const loaded = await this.deps.attachmentStore.readFileBuffer(fileId);
        if (loaded) {
          images.push({
            mime: meta.mime,
            base64: loaded.data.toString("base64"),
          });
        }
      }
    }

    const content =
      attachmentLines.length > 0
        ? `${text}\n\n[附件元信息]\n${attachmentLines.join("\n")}`
        : text;

    return {
      role: "user",
      content,
      ...(images.length > 0 ? { images } : {}),
    };
  }

  private async checkIdleCompaction(): Promise<void> {
    if (this.running || this.compactionPromise) return;
    const config = this.deps.configStore.getConfig();
    if (!config.initialized || config.context.idleCompactionMinutes <= 0) return;

    const idleMs = Date.now() - this.lastActivityAt;
    if (idleMs < config.context.idleCompactionMinutes * 60_000) return;

    const allMsgs = this.deps.chatStore.getAllMessages();
    const windowInfo = this.deps.contextStore.getPromptWindow(allMsgs);
    if (windowInfo.estimatedTokens < config.context.minIdleTokens) return;

    try {
      await this.compactContext("idle");
    } catch {
      // Idle compaction failures should stay silent and retry next interval
    }
  }

  async compactContext(reason: string): Promise<string> {
    if (this.compactionPromise) return this.compactionPromise;

    this.compactionPromise = (async () => {
      const config = this.deps.configStore.getConfig();
      const profile = config.models[config.coordinatorModelAlias];
      if (!profile) {
        return this.deps.contextStore.getState().frozenSummary;
      }

      const allMsgs = this.deps.chatStore.getAllMessages();
      const plan = this.deps.contextStore.selectMessagesToCompact(allMsgs, config.context);
      if (!plan) {
        return this.deps.contextStore.getState().frozenSummary;
      }

      const previousSummary = this.deps.contextStore.getState().frozenSummary;
      const transcript = plan.toCompact
        .map((m: ChatMessage) => `[#${m.seq} ${m.role} ${m.createdAt}]\n${m.text}`)
        .join("\n\n");

      const compactionPrompt = `请将“旧记忆摘要”与“新增归档对话”合并浓缩为一份高密度、结构清晰的长期记忆摘要。
要求：
1. 保留：用户偏好与习惯、已配置的模型别名/提供商（严禁还原或猜测密钥明文）、访问口令/Token 存在状态、acrowly.com 中继配置、已开发的 WebUI 与扩展模块及重要文件路径、已做出的关键决定与未完成事项。
2. 删去寒暄和冗余重复内容，控制在紧凑篇幅内。
3. 触发原因: ${reason}

## 旧记忆摘要
${previousSummary || "（无）"}

## 新增归档对话
${transcript}`;

      const res = await this.deps.llm.chat({
        profile,
        systemPrompt:
          "你是精准的上下文压缩器。只输出压缩后的事实与上下文摘要，不要多余前言。",
        messages: [{ role: "user", content: compactionPrompt }],
        temperature: 0.1,
      });

      const newSummary = res.content.trim() || previousSummary;
      await this.deps.contextStore.applyCompaction(newSummary, plan.newActiveFromSeq);
      return newSummary;
    })();

    try {
      return await this.compactionPromise;
    } finally {
      this.compactionPromise = undefined;
    }
  }
}
