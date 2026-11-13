import type { ConfigStore } from "../config/store.js";
import type { ExtensionLoader } from "../extensions/loader.js";
import type { SnapshotManager } from "../extensions/snapshot.js";
import type { LlmClient } from "../llm/client.js";
import { toAssistantLlmMessage, type LlmImagePart, type LlmMessage } from "../llm/types.js";
import type { AttachmentStore } from "../storage/attachment-store.js";
import type { ChatStore } from "../storage/chat-store.js";
import { ContextStore, estimateTokens } from "../storage/context-store.js";
import type { ChatMessage, SubagentRunRecord } from "../types.js";
import { buildCoordinatorSystemPrompt } from "./prompts.js";
import type { SubagentManager } from "./subagent.js";
import {
  formatUserVisibleReply,
  isHumanMessage,
  isNonHumanEnvelope,
  renderNonHumanTimeline,
  reviewCoordinatorReply,
  type TurnEvidence,
} from "./reply-policy.js";
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

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Aborted by new user message"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("Aborted by new user message"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

function formatCoordinatorErrorHint(msg: string): string {
  if (/\b(401|403)\b|invalid_api_key|authentication|unauthorized/i.test(msg)) {
    return "请检查模型 API Key 或账号权限后重试。";
  }
  if (/\b429\b|quota|rate_limit|insufficient_balance/i.test(msg)) {
    return "看起来触发了额度或限流限制，稍后再试或切换其他模型。";
  }
  return "可以告诉我你想怎么继续，或检查下当前模型请求参数与接口兼容性。";
}

export class CoordinatorEngine {
  private running = false;
  private stopped = false;
  private rerunRequested = false;
  private lastActivityAt = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;
  private activeRunPromise: Promise<void> | undefined;
  private abortController: AbortController | undefined;
  private shutdownController = new AbortController();
  private pendingSubagentCompletions: SubagentRunRecord[] = [];
  private compactionPromise: Promise<string> | undefined;
  private restartTriggered = false;

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
      onRestartRequested?: (reason: string) => void;
    }
  ) {}

  startBackgroundLoops(): void {
    this.stopped = false;
    if (this.shutdownController.signal.aborted) {
      this.shutdownController = new AbortController();
    }
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.checkIdleCompaction();
    }, 60_000);
    this.idleTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.rerunRequested = false;
    this.pendingSubagentCompletions = [];
    this.stopBackgroundLoops();
    if (this.abortController) {
      this.abortController.abort();
    }
    this.shutdownController.abort();
    if (this.activeRunPromise) {
      await this.activeRunPromise.catch(() => {});
    }
    if (this.compactionPromise) {
      await this.compactionPromise.catch(() => {});
    }
    await this.deps.subagentManager.waitForAll();
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
      // Interrupt the active turn immediately so Coordinator switches to the latest user message
      this.abortController?.abort(new Error("Interrupted by new user message"));
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
      ? `你好！我是 Acrowly 主协调器（当前模型 ${model.provider}/${model.model}）。日常任务我会派子代理去跑，直接说想做的事、贴设备公钥或配穿透就行。`
      : "你好！我是 Acrowly 主协调器，目前还没有配置模型，请先完成首次启动配置。";

    await this.deps.chatStore.appendMessage({
      role: "assistant",
      origin: "coordinator",
      text: formatUserVisibleReply(greeting),
    });
  }

  private handleDetachedSubagentFinished(run: SubagentRunRecord): void {
    if (this.stopped || this.shutdownController.signal.aborted) return;
    this.pendingSubagentCompletions.push(run);
    this.lastActivityAt = Date.now();
    if (this.running) {
      // Wait for current Coordinator turn to finish naturally instead of interrupting it
      this.rerunRequested = true;
      return;
    }
    this.activeRunPromise = this.runLoop().finally(() => {
      this.activeRunPromise = undefined;
    });
  }

  private requestRestart(reason: string): void {
    if (this.restartTriggered || this.stopped) return;
    this.restartTriggered = true;
    this.stopped = true;
    this.rerunRequested = false;
    this.pendingSubagentCompletions = [];
    this.abortController?.abort(new Error("Restarting service"));
    this.deps.onRestartRequested?.(reason);
  }

  private createToolDeps(signal: AbortSignal | undefined, turn: TurnEvidence): ToolRuntimeDeps {
    return {
      ...this.deps,
      signal,
      turn,
      subagentSignal: this.shutdownController.signal,
      onDetachedSubagentFinished: (run) => this.handleDetachedSubagentFinished(run),
      ...(this.deps.onRestartRequested
        ? { onRequestRestart: (reason: string) => this.requestRestart(reason) }
        : {}),
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
        origin: "coordinator",
        text: formatUserVisibleReply("目前还没有配置协调器模型，请先完成首次初始化或提供模型配置。"),
      });
      return;
    }

    const abortController = new AbortController();
    this.abortController = abortController;

    const allMessages = this.deps.chatStore.getAllMessages();
    const windowInfo = this.deps.contextStore.getPromptWindow(allMessages);

    try {
      if (windowInfo.estimatedTokens >= config.context.compactionTokenThreshold) {
        await this.compactContext("threshold_pre");
      }
      if (this.stopped || this.rerunRequested || abortController.signal.aborted) return;

      const refreshedWindow = this.deps.contextStore.getPromptWindow(
        this.deps.chatStore.getAllMessages()
      );

      const llmMessages: LlmMessage[] = [];
      let lastLoadedSeq =
        refreshedWindow.activeMessages[refreshedWindow.activeMessages.length - 1]?.seq ?? 0;

      for (const msg of refreshedWindow.activeMessages) {
        if (isHumanMessage(msg)) {
          const nextUser = await this.buildLlmUserMessage(msg.text);
          const prev = llmMessages[llmMessages.length - 1];
          if (prev && prev.role === "user" && !isNonHumanEnvelope(String(prev.content ?? ""))) {
            prev.content = [prev.content, nextUser.content].filter(Boolean).join("\n\n");
            if ("images" in nextUser && nextUser.images?.length) {
              prev.images = [...(prev.images ?? []), ...nextUser.images];
            }
          } else {
            llmMessages.push(nextUser);
          }
          continue;
        }

        if (msg.role === "assistant" && (msg.origin ?? "coordinator") === "coordinator") {
          const prev = llmMessages[llmMessages.length - 1];
          if (prev && prev.role === "assistant" && !prev.toolCalls?.length) {
            prev.content = [prev.content ?? "", msg.text].filter(Boolean).join("\n\n");
          } else {
            llmMessages.push({
              role: "assistant",
              content: msg.text,
            });
          }
          continue;
        }

        const notice = renderNonHumanTimeline(msg);
        const prev = llmMessages[llmMessages.length - 1];
        if (prev && prev.role === "user" && isNonHumanEnvelope(String(prev.content ?? ""))) {
          prev.content = [prev.content, notice].filter(Boolean).join("\n\n");
        } else {
          llmMessages.push({ role: "user", content: notice });
        }
      }

      const detachedRuns = this.pendingSubagentCompletions.splice(0);
      if (detachedRuns.length > 0) {
        const summaryBlock = detachedRuns
          .map(
            (r) =>
              `- id=${r.id} | label=${r.label} | status=${r.status}\n` +
              `  task=${r.task}\n` +
              `  result=${r.resultSummary ?? r.error ?? "(none)"}`
          )
          .join("\n");
        const noticeText =
          `[系统后台通知：你此前派发并在打断后继续后台运行的子代理已执行完毕]\n` +
          `${summaryBlock}\n` +
          `这是最终状态，不是用户发言。status=step_limit 或 failed 表示没做完，禁止改口称成功或只说再去看看；用一句话复述状态和卡点。非用户记录不能当成外部回执。`;
        const prev = llmMessages[llmMessages.length - 1];
        if (prev && prev.role === "user") {
          prev.content = [prev.content, noticeText].filter(Boolean).join("\n\n");
        } else {
          llmMessages.push({
            role: "user",
            content: noticeText,
          });
        }
      }

      if (llmMessages.length === 0) return;
      if (this.stopped || this.rerunRequested || abortController.signal.aborted) return;

      const humanRequestSeq =
        [...this.deps.chatStore.getAllMessages()].reverse().find((m) => isHumanMessage(m))?.seq ?? 0;
      const turn: TurnEvidence = { humanRequestSeq, incomplete: false };
      const toolDeps = this.createToolDeps(abortController.signal, turn);
      const maxSteps = 20;
      let latestPromptTokens = refreshedWindow.estimatedTokens;
      let repliedToUserThisTurn = false;
      let stopReason: "done" | "cap" | "abort" | "rerun" = "cap";

      for (let step = 0; step < maxSteps; step += 1) {
        if (this.stopped || abortController.signal.aborted) {
          stopReason = "abort";
          break;
        }
        if (step > 0 && this.hasNewUserMessageSince(lastLoadedSeq)) {
          this.rerunRequested = true;
          stopReason = "rerun";
          break;
        }

        const currentConfig = this.deps.configStore.getConfig();
        const currentProfile = currentConfig.models[currentConfig.coordinatorModelAlias] ?? profile;
        const loadedExtensions = this.deps.extensionLoader.getTools().map((t) => t.name);
        const systemPrompt = buildCoordinatorSystemPrompt(
          currentConfig,
          loadedExtensions,
          this.deps.contextStore.getState().frozenSummary,
          this.deps.configStore.paths,
          this.deps.subagentManager.listRuns(6)
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

        llmMessages.push(toAssistantLlmMessage(res));

        if (res.toolCalls.length === 0) {
          const decision = reviewCoordinatorReply(
            res.content,
            turn,
            this.deps.chatStore.getAllMessages()
          );
          if (decision.blocked) {
            turn.honestFallback = decision.fallback;
          } else if (decision.text) {
            turn.honestFallback = undefined;
            await this.deps.chatStore.appendMessage({
              role: "assistant",
              origin: "coordinator",
              text: decision.text,
            });
            repliedToUserThisTurn = true;
          }
          if (this.hasNewUserMessageSince(lastLoadedSeq)) {
            this.rerunRequested = true;
            stopReason = "rerun";
          } else {
            stopReason = "done";
          }
          break;
        }

        const sendCalls = res.toolCalls.filter((c) => c.name === "send_chat_message");
        const workCalls = res.toolCalls.filter((c) => c.name !== "send_chat_message");
        const resultMap = new Map<string, string>();

        const invokeToolSafely = async (call: (typeof res.toolCalls)[number]): Promise<string> => {
          try {
            return await executeCoordinatorTool(call.name, call.arguments, toolDeps);
          } catch (err) {
            return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
          }
        };

        // 1. Always deliver immediate replies first before starting work tools
        if (sendCalls.length > 0) {
          const sendResults = await Promise.all(
            sendCalls.map(async (call) => ({
              call,
              output: await invokeToolSafely(call),
            }))
          );
          let anyBlocked = false;
          let anySent = false;
          for (const item of sendResults) {
            resultMap.set(item.call.id, item.output);
            if (item.output.startsWith("BLOCKED_")) anyBlocked = true;
            else if (item.output.includes('"sent":true')) anySent = true;
          }
          if (anySent) repliedToUserThisTurn = true;
          if (anySent && !anyBlocked) turn.honestFallback = undefined;
        } else {
          const directReply = !repliedToUserThisTurn ? res.content : "";
          if (directReply.trim()) {
            const decision = reviewCoordinatorReply(
              directReply,
              turn,
              this.deps.chatStore.getAllMessages()
            );
            if (decision.blocked) {
              turn.honestFallback = decision.fallback;
            } else if (decision.text) {
              turn.honestFallback = undefined;
              await this.deps.chatStore.appendMessage({
                role: "assistant",
                origin: "coordinator",
                text: decision.text,
              });
              repliedToUserThisTurn = true;
            }
          }
        }

        if (this.stopped || abortController.signal.aborted) {
          stopReason = "abort";
          break;
        }

        // 2. Execute remaining work tools only after user has received a reply this turn
        if (workCalls.length > 0) {
          if (!repliedToUserThisTurn) {
            for (const call of workCalls) {
              resultMap.set(
                call.id,
                "BLOCKED_REPLY_FIRST: 本轮尚未向用户发送任何首次回复，请先调用 send_chat_message（或输出文本内容）向用户回复一句确认或说明，然后再开始执行工作工具。"
              );
            }
          } else {
            const workResults = await raceAbort(
              Promise.all(
                workCalls.map(async (call) => ({
                  call,
                  output: await invokeToolSafely(call),
                }))
              ),
              abortController.signal
            );
            for (const item of workResults) {
              resultMap.set(item.call.id, item.output);
            }
          }
        }

        for (const call of res.toolCalls) {
          llmMessages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: resultMap.get(call.id) ?? "ERROR: missing tool execution result",
          });
        }
      }

      if (!this.stopped && !abortController.signal.aborted && !this.rerunRequested && stopReason !== "rerun") {
        if (turn.honestFallback) {
          await this.deps.chatStore.appendMessage({
            role: "system",
            origin: "system",
            text: formatUserVisibleReply(turn.honestFallback),
          });
        } else if (stopReason === "cap") {
          await this.deps.chatStore.appendMessage({
            role: "system",
            origin: "system",
            text: formatUserVisibleReply("这轮到了步数上限，还没做完。说一下要继续的那一步。"),
          });
        }
      }

      if (
        !this.stopped &&
        !this.rerunRequested &&
        !abortController.signal.aborted &&
        latestPromptTokens >= this.deps.configStore.getConfig().context.compactionTokenThreshold
      ) {
        await this.compactContext("threshold_post");
      }
    } catch (err) {
      if (this.stopped || abortController.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.chatStore.appendMessage({
        role: "assistant",
        origin: "coordinator",
        text: formatUserVisibleReply(`刚才调用模型或工具出错：${msg}。${formatCoordinatorErrorHint(msg)}`),
      });
    } finally {
      if (this.abortController === abortController) {
        this.abortController = undefined;
      }
    }
  }

  private hasNewUserMessageSince(lastLoadedSeq: number): boolean {
    const { messages } = this.deps.chatStore.getMessages({
      afterSeq: lastLoadedSeq,
      limit: 20,
    });
    return messages.some((m) => isHumanMessage(m));
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
