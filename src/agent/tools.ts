import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic, type ConfigStore } from "../config/store.js";
import type { ExtensionLoader } from "../extensions/loader.js";
import type { SnapshotManager } from "../extensions/snapshot.js";
import type { ToolDefinition } from "../llm/types.js";
import type { AttachmentStore } from "../storage/attachment-store.js";
import type { ChatStore } from "../storage/chat-store.js";
import type { ContextStore } from "../storage/context-store.js";
import type { ExtensionExecutionContext, ProviderKind, SubagentRunRecord } from "../types.js";
import { createActor, currentActor, releaseActor, runWithActor } from "./actor.js";
import {
  formatUserVisibleReply,
  reviewCoordinatorReply,
  type TurnEvidence,
} from "./reply-policy.js";
import { runShellCommand } from "./shell-runner.js";
import type { SubagentManager, SubagentToolExecutor } from "./subagent.js";

export { stripCoordinatorMarkdown } from "./reply-policy.js";

export interface ToolRuntimeDeps {
  configStore: ConfigStore;
  chatStore: ChatStore;
  attachmentStore: AttachmentStore;
  contextStore: ContextStore;
  extensionLoader: ExtensionLoader;
  snapshotManager: SnapshotManager;
  subagentManager: SubagentManager;
  /** Coordinator turn signal (aborted when a new user message interrupts Coordinator) */
  signal?: AbortSignal;
  /** Daemon shutdown signal (subagents keep running across Coordinator turn interrupts) */
  subagentSignal?: AbortSignal;
  onDetachedSubagentFinished?: (run: SubagentRunRecord) => void;
  onRequestRestart?: (reason: string) => void;
  onTriggerCompaction: () => Promise<string>;
  onRelayConfigUpdated?: () => void;
  getRelayConnected?: () => boolean;
  /** Mutable evidence for the coordinator turn that invoked the tool. */
  turn?: TurnEvidence;
}

const SUBAGENT_TOOL_DEFS: ToolDefinition[] = [
  {
    name: "run_shell",
    description: "Run a shell command on the host machine with full permissions.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command string to execute." },
        cwd: { type: "string", description: "Optional working directory." },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default 60000)." },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read contents of a local file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to root or absolute)." },
        startLine: { type: "number", description: "1-based start line (optional)." },
        endLine: { type: "number", description: "1-based end line inclusive (optional)." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a local file. Automatically creates parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write." },
        content: { type: "string", description: "Full text content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact string occurrence inside an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to edit." },
        target: { type: "string", description: "Exact existing text to replace." },
        replacement: { type: "string", description: "New replacement text." },
      },
      required: ["path", "target", "replacement"],
    },
  },
  {
    name: "list_dir",
    description: "List files and directories inside a path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (defaults to project root)." },
      },
    },
  },
  {
    name: "publish_file",
    description:
      "Publish any local file (image, document, archive, audio, video, binary, etc.) to /api/files/... and return its URL and Markdown snippet for chat.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Local file path to publish." },
        displayName: { type: "string", description: "Optional display filename." },
      },
      required: ["path"],
    },
  },
  {
    name: "get_api_spec",
    description: "Read the authoritative Acrowly Pure Chat API & WebUI specification.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "snapshot_backup",
    description: "Create a backup snapshot of webui/ and extensions/ before making changes.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason label." },
      },
    },
  },
  {
    name: "snapshot_restore",
    description: "Restore webui/ and extensions/ from a backup snapshot.",
    parameters: {
      type: "object",
      properties: {
        snapshotId: { type: "string", description: "Optional snapshot ID (defaults to latest)." },
      },
    },
  },
  {
    name: "reload_extensions",
    description: "Hot-reload all JS/MJS extension tool modules in data/extensions/ without restarting.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

const COORDINATOR_BASE_TOOL_DEFS: ToolDefinition[] = [
  {
    name: "dispatch_subagent",
    description:
      "Delegate an execution task (coding, building local WebUI, writing extensions, shell operations, research, file processing) to an isolated Subagent.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short label for this subagent run, e.g. 'build-webui'." },
        task: {
          type: "string",
          description:
            "Complete, self-contained instructions for the subagent, including exact paths, requirements, and what to verify.",
        },
        modelAlias: {
          type: "string",
          description: "Optional registered model alias to run this subagent on.",
        },
        maxSteps: {
          type: "number",
          description: "Optional step cap (1-40). Default 25. Hitting it stops the run as unfinished.",
        },
      },
      required: ["label", "task"],
    },
  },
  {
    name: "list_subagents",
    description: "List recent subagent runs and their outcomes.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of runs to list." },
      },
    },
  },
  {
    name: "send_chat_message",
    description:
      "Send an immediate plain-text reply to the user (keep under 100 Chinese characters, no Markdown) before starting longer work.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Plain text message under 100 Chinese characters (no Markdown formatting).",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "get_system_status",
    description:
      "Inspect current Acrowly configuration, server address, relay state, WebUI status, models, context usage, and extensions.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_api_spec",
    description: "Read the authoritative Acrowly Pure Chat API & WebUI specification.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "configure_auth",
    description:
      "Manage SSH-style authorized Ed25519 client public keys (add, list, or remove a device public key).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add_public_key", "list_public_keys", "remove_public_key"],
          description: "Authorized key operation to perform.",
        },
        publicKey: {
          type: "string",
          description:
            "Ed25519 public key (ssh-ed25519 AAAA..., 32-byte raw Base64, or PEM) when action=add_public_key.",
        },
        label: {
          type: "string",
          description: "Device label when action=add_public_key, e.g. 'iphone' or 'browser'.",
        },
        idOrFingerprint: {
          type: "string",
          description: "Key ID (key_...) or SHA256 fingerprint when action=remove_public_key.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "configure_relay",
    description:
      "Enable/disable or update outbound tunnel relay settings (e.g. acrowly.com) for users without a public IP.",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Enable or disable outbound relay tunnel." },
        deviceId: { type: "string", description: "Optional unique device ID on relay (e.g. 'chen-home')." },
        url: { type: "string", description: "Optional relay WebSocket URL (default wss://acrowly.com/tunnel)." },
      },
    },
  },
  {
    name: "manage_models",
    description:
      "List, add/update, switch, or remove LLM models and API keys. Automatically redacts newly supplied keys from recent chat logs.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "upsert", "remove"],
          description: "Model registry operation.",
        },
        alias: { type: "string", description: "Model alias, e.g. 'coder', 'fast', 'coordinator'." },
        provider: {
          type: "string",
          enum: ["openai", "gemini", "anthropic", "deepseek", "openrouter", "ollama", "custom"],
          description: "Provider kind.",
        },
        model: { type: "string", description: "Model identifier string." },
        apiKey: { type: "string", description: "API key to store in secrets vault." },
        baseUrl: { type: "string", description: "Optional custom API base URL." },
        makeCoordinator: { type: "boolean", description: "Set this alias as the Coordinator model." },
        makeDefaultSubagent: { type: "boolean", description: "Set this alias as default for Subagents." },
      },
      required: ["action"],
    },
  },
  {
    name: "configure_context",
    description: "View or update Coordinator context compaction thresholds (token threshold and idle minutes).",
    parameters: {
      type: "object",
      properties: {
        compactionTokenThreshold: {
          type: "number",
          description: "Auto-compaction token limit (default 200000).",
        },
        idleCompactionMinutes: {
          type: "number",
          description: "Auto-compact after N idle minutes (0 to disable, default 30).",
        },
        keepRecentMessages: {
          type: "number",
          description: "Number of recent chat messages kept verbatim during compaction (default 10).",
        },
      },
    },
  },
  {
    name: "trigger_compaction",
    description: "Manually run Coordinator context compaction now.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "reload_extensions",
    description: "Hot-reload runtime extension modules in data/extensions/ without restarting server.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_extensions",
    description: "List all loaded extension tools and any load errors.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "publish_file",
    description:
      "Publish any local file (image, document, archive, audio, video, binary, etc.) to /api/files/... for sending in chat.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Local file path." },
        displayName: { type: "string", description: "Optional display filename." },
      },
      required: ["path"],
    },
  },
  {
    name: "snapshot_restore",
    description: "Restore webui/ and extensions/ from a backup snapshot if an edit broke something.",
    parameters: {
      type: "object",
      properties: {
        snapshotId: { type: "string", description: "Optional snapshot ID (defaults to latest)." },
      },
    },
  },
  {
    name: "restart_service",
    description:
      "Self-restart the Acrowly backend daemon to load updated dist/ code after git pull or npm run build. Reconnects chat clients automatically.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short plain reason for the restart, e.g. '加载最新构建产物'.",
        },
        force: {
          type: "boolean",
          description: "Set true to restart even if background subagents are still running (default false).",
        },
      },
    },
  },
];

export function createExtensionContext(deps: ToolRuntimeDeps): ExtensionExecutionContext {
  const { paths } = deps.configStore;
  return {
    workspaceDir: paths.rootDir,
    dataDir: paths.dataDir,
    webuiDir: paths.webuiDir,
    ...(deps.signal ? { signal: deps.signal } : {}),
    publishFile: async (localPath, displayName) => {
      const saved = await deps.attachmentStore.importLocalFile(localPath, displayName);
      return {
        id: saved.id,
        kind: saved.kind,
        url: saved.url,
        markdown: saved.markdown,
      };
    },
    sendMessage: async (text) => {
      const actor = currentActor();
      const evidence = deps.turn ?? { humanRequestSeq: 0, incomplete: false };
      const decision = reviewCoordinatorReply(text, evidence, deps.chatStore.getAllMessages());
      const visible = decision.blocked ? decision.fallback : decision.text;
      const { message } = await deps.chatStore.appendMessage({
        role: "assistant",
        origin: "extension",
        actor: actor?.label ?? "extension",
        text: visible || "（空消息）",
      });
      return message;
    },
  };
}

function resolvePath(rootDir: string, targetPath?: unknown): string {
  const raw = typeof targetPath === "string" && targetPath.trim().length > 0 ? targetPath.trim() : ".";
  return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
}

async function executeHostTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolRuntimeDeps
): Promise<string | undefined> {
  const { rootDir } = deps.configStore.paths;

  switch (name) {
    case "run_shell": {
      const command = String(args.command ?? "");
      const cwd = resolvePath(rootDir, args.cwd);
      try {
        const actorLabel = currentActor()?.label;
        const result = await runShellCommand({
          command,
          cwd,
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          signal: deps.signal,
          markIncomplete: () => {
            if (deps.turn) deps.turn.incomplete = true;
          },
          onBackgroundSettled: async (text) => {
            await deps.chatStore.appendMessage({
              role: "system",
              origin: "system",
              ...(actorLabel ? { actor: actorLabel } : {}),
              text,
            });
          },
        });
        return result.output;
      } catch (err) {
        if (deps.signal?.aborted) throw err;
        return `EXIT 1\n${err instanceof Error ? err.message : String(err)}`.slice(0, 16_000);
      }
    }

    case "read_file": {
      const filePath = resolvePath(rootDir, args.path);
      const text = await fs.readFile(filePath, "utf8");
      const lines = text.split("\n");
      const start = Math.max(Number(args.startLine ?? 1), 1);
      const end = args.endLine ? Math.min(Number(args.endLine), lines.length) : Math.min(start + 399, lines.length);
      const slice = lines.slice(start - 1, end);
      return JSON.stringify(
        {
          path: filePath,
          totalLines: lines.length,
          range: `${start}-${end}`,
          content: slice.join("\n"),
        },
        null,
        2
      );
    }

    case "write_file": {
      const filePath = resolvePath(rootDir, args.path);
      const content = String(args.content ?? "");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`;
    }

    case "edit_file": {
      const filePath = resolvePath(rootDir, args.path);
      const target = String(args.target ?? "");
      const replacement = String(args.replacement ?? "");
      const current = await fs.readFile(filePath, "utf8");
      if (!current.includes(target)) {
        throw new Error(`Target string not found in ${filePath}`);
      }
      const next = current.split(target).join(replacement);
      await fs.writeFile(filePath, next, "utf8");
      return `Updated ${filePath}`;
    }

    case "list_dir": {
      const dirPath = resolvePath(rootDir, args.path);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return JSON.stringify(
        entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
        })),
        null,
        2
      );
    }

    case "publish_file": {
      const filePath = resolvePath(rootDir, args.path);
      const displayName = typeof args.displayName === "string" ? args.displayName : undefined;
      const saved = await deps.attachmentStore.importLocalFile(filePath, displayName);
      return JSON.stringify(
        {
          id: saved.id,
          kind: saved.kind,
          url: saved.url,
          markdown: saved.markdown,
        },
        null,
        2
      );
    }

    case "get_api_spec": {
      const specPath = path.join(rootDir, "docs", "API_SPEC.md");
      try {
        return await fs.readFile(specPath, "utf8");
      } catch {
        return `Acrowly Chat & File API Endpoints:
- GET /api/auth/status
- POST /api/auth/challenge ({ fingerprint? | publicKey? }) -> { challengeId, nonce, message, expiresAt }
- POST /api/auth/verify ({ challengeId, signature }) -> { ok, token, keyId, label, fingerprint }
- GET /api/chat/messages?after_seq=&before_seq=&limit=
- POST /api/chat/messages (JSON { text, clientMsgId? } OR multipart/form-data fields text, clientMsgId + file/files parts of any type) -> 202 { message, duplicate, attachments? }
- GET /api/chat/stream?after_seq= (SSE event: message, data: ChatMessage JSON)
- POST /api/files (multipart/form-data single/multiple files or raw + X-Filename; any file type allowed) -> { id, kind, name, mime, size, url, markdown, files? }
- GET /api/files/:id/:filename (supports HTTP Range 206 & ?download=1)`;
      }
    }

    case "snapshot_backup": {
      const snap = await deps.snapshotManager.createSnapshot(String(args.reason ?? "agent"));
      return JSON.stringify(snap, null, 2);
    }

    case "snapshot_restore": {
      const res = await deps.snapshotManager.restoreSnapshot(
        typeof args.snapshotId === "string" ? args.snapshotId : undefined
      );
      await deps.extensionLoader.reload();
      return JSON.stringify(res, null, 2);
    }

    case "reload_extensions": {
      const report = await deps.extensionLoader.reload();
      return JSON.stringify(report, null, 2);
    }

    default:
      return undefined;
  }
}

export function buildSubagentToolExecutor(deps: ToolRuntimeDeps): SubagentToolExecutor {
  return {
    definitions: SUBAGENT_TOOL_DEFS,
    execute: async (name, args) => {
      const res = await executeHostTool(name, args, deps);
      if (res !== undefined) return res;
      throw new Error(`Unknown subagent tool: ${name}`);
    },
  };
}

export function getCoordinatorToolDefinitions(extensionLoader: ExtensionLoader): ToolDefinition[] {
  const extDefs: ToolDefinition[] = extensionLoader.getTools().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  return [...COORDINATOR_BASE_TOOL_DEFS, ...extDefs];
}

export async function executeCoordinatorTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolRuntimeDeps
): Promise<string> {
  const config = deps.configStore.getConfig();

  // Check dynamically loaded extension tools first. Their loopback chat posts
  // carry this actor token so they cannot land as the user's own messages.
  if (deps.extensionLoader.getTool(name)) {
    const actor = createActor("extension", name);
    try {
      return await runWithActor(actor, () =>
        deps.extensionLoader.executeTool(name, args, createExtensionContext(deps))
      );
    } finally {
      releaseActor(actor);
    }
  }

  switch (name) {
    case "dispatch_subagent": {
      const label = String(args.label ?? "worker");
      const task = String(args.task ?? "");
      const requestedAlias =
        typeof args.modelAlias === "string" && args.modelAlias.trim()
          ? args.modelAlias.trim().toLowerCase()
          : config.defaultSubagentModelAlias || config.coordinatorModelAlias;
      const profile = config.models[requestedAlias] ?? config.models[config.coordinatorModelAlias];
      if (!profile) {
        throw new Error("No valid model profile configured for subagent.");
      }
      const turnSignal = deps.signal;
      const subagentSignal = deps.subagentSignal;
      const maxSteps =
        typeof args.maxSteps === "number" && Number.isFinite(args.maxSteps)
          ? Math.min(40, Math.max(1, Math.floor(args.maxSteps)))
          : undefined;
      const actor = createActor("subagent", label);
      try {
        const run = await runWithActor(actor, () =>
          deps.subagentManager.runTask({
            label,
            task,
            profile,
            tools: buildSubagentToolExecutor({
              ...deps,
              signal: subagentSignal,
            }),
            signal: subagentSignal,
            ...(maxSteps !== undefined ? { maxSteps } : {}),
            onTerminal: async (finished) => {
              if (deps.turn) deps.turn.incomplete = true;
              const detail =
                finished.status === "step_limit"
                  ? `子代理 ${finished.label} 到了步数上限，停了，任务没完成。`
                  : `子代理 ${finished.label} 失败了，卡在：${(finished.error ?? "未知错误").replace(/\s+/g, " ")}`;
              await deps.chatStore.appendMessage({
                role: "system",
                origin: "system",
                actor: finished.label,
                text: formatUserVisibleReply(detail),
              });
            },
          })
        );
        if (
          deps.turn &&
          (run.status === "step_limit" || (run.status === "failed" && run.error !== "Interrupted"))
        ) {
          deps.turn.incomplete = true;
        }
        if (turnSignal?.aborted && !subagentSignal?.aborted) {
          deps.onDetachedSubagentFinished?.(run);
        }
        return JSON.stringify(run, null, 2);
      } finally {
        releaseActor(actor);
      }
    }

    case "list_subagents": {
      const limit = Number(args.limit ?? 15);
      return JSON.stringify(deps.subagentManager.listRuns(limit), null, 2);
    }

    case "send_chat_message": {
      const decision = reviewCoordinatorReply(
        String(args.text ?? ""),
        deps.turn ?? { humanRequestSeq: 0, incomplete: false },
        deps.chatStore.getAllMessages()
      );
      if (decision.blocked) {
        if (deps.turn) deps.turn.honestFallback = decision.fallback;
        return decision.reason;
      }
      if (!decision.text) return JSON.stringify({ skipped: true });
      const { message } = await deps.chatStore.appendMessage({
        role: "assistant",
        origin: "coordinator",
        text: decision.text,
      });
      return JSON.stringify({ sent: true, seq: message.seq, id: message.id, text: message.text });
    }

    case "get_system_status": {
      let webuiExists = false;
      try {
        await fs.access(path.join(deps.configStore.paths.webuiDir, "index.html"));
        webuiExists = true;
      } catch {
        webuiExists = false;
      }
      const allMsgs = deps.chatStore.getAllMessages();
      const windowInfo = deps.contextStore.getPromptWindow(allMsgs);
      const relayHttpBase = config.relay.url
        .replace(/^wss:/, "https:")
        .replace(/^ws:/, "http:")
        .replace(/\/tunnel\/?$/, "");

      return JSON.stringify(
        {
          localUrl: `http://${config.server.host}:${config.server.port}`,
          webuiReady: webuiExists,
          authConfigured: config.auth.authorizedKeys.length > 0,
          authorizedKeys: config.auth.authorizedKeys.map((k) => ({
            id: k.id,
            label: k.label,
            fingerprint: k.fingerprint,
            addedAt: k.addedAt,
            lastUsedAt: k.lastUsedAt,
          })),
          relay: {
            enabled: config.relay.enabled,
            connected: deps.getRelayConnected ? deps.getRelayConnected() : false,
            url: config.relay.url,
            deviceId: config.relay.deviceId,
            remotePathUrl: `${relayHttpBase}/d/${config.relay.deviceId}/`,
          },
          coordinatorModelAlias: config.coordinatorModelAlias,
          defaultSubagentModelAlias: config.defaultSubagentModelAlias ?? config.coordinatorModelAlias,
          models: Object.values(config.models).map((m) => ({
            alias: m.alias,
            provider: m.provider,
            model: m.model,
            baseUrl: m.baseUrl,
            hasKey: Boolean(deps.configStore.getSecret(m.apiKeyRef)),
          })),
          context: {
            totalMessages: allMsgs.length,
            activeMessages: windowInfo.activeMessages.length,
            estimatedPromptTokens: windowInfo.estimatedTokens,
            ...config.context,
            ...deps.contextStore.getState(),
          },
          extensions: deps.extensionLoader.getReport(),
          process: {
            pid: process.pid,
            supervised: process.env.ACROWLY_SUPERVISED === "1",
            uptimeSec: Math.round(process.uptime()),
          },
        },
        null,
        2
      );
    }

    case "configure_auth": {
      const action = String(args.action ?? "");
      if (action === "add_public_key") {
        const publicKey = String(args.publicKey ?? "").trim();
        if (!publicKey) {
          throw new Error("publicKey is required.");
        }
        const label = typeof args.label === "string" ? args.label : undefined;
        const { key, alreadyExists } = await deps.configStore.addAuthorizedPublicKey(publicKey, label);
        return JSON.stringify(
          {
            ok: true,
            alreadyExists,
            id: key.id,
            label: key.label,
            fingerprint: key.fingerprint,
          },
          null,
          2
        );
      }
      if (action === "list_public_keys") {
        return JSON.stringify(
          config.auth.authorizedKeys.map((k) => ({
            id: k.id,
            label: k.label,
            fingerprint: k.fingerprint,
            openssh: k.openssh,
            addedAt: k.addedAt,
            lastUsedAt: k.lastUsedAt,
          })),
          null,
          2
        );
      }
      if (action === "remove_public_key") {
        const ok = await deps.configStore.removeAuthorizedPublicKey(
          String(args.idOrFingerprint ?? "")
        );
        return JSON.stringify({ ok });
      }
      throw new Error(`Unsupported configure_auth action: ${action}`);
    }

    case "configure_relay": {
      const patch: Partial<typeof config.relay> = {};
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
      if (typeof args.deviceId === "string" && args.deviceId.trim()) {
        patch.deviceId = args.deviceId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
      }
      if (typeof args.url === "string" && args.url.trim()) {
        patch.url = args.url.trim();
      }
      const updated = await deps.configStore.updateRelayConfig(patch);
      if (deps.onRelayConfigUpdated) {
        deps.onRelayConfigUpdated();
      }
      const relayHttpBase = updated.url
        .replace(/^wss:/, "https:")
        .replace(/^ws:/, "http:")
        .replace(/\/tunnel\/?$/, "");
      return JSON.stringify(
        {
          ...updated,
          tunnelSecret: undefined,
          remotePathUrl: `${relayHttpBase}/d/${updated.deviceId}/`,
          headerHint: `X-Acrowly-Device: ${updated.deviceId}`,
        },
        null,
        2
      );
    }

    case "manage_models": {
      const action = String(args.action ?? "");
      if (action === "list") {
        return JSON.stringify(
          {
            coordinatorModelAlias: config.coordinatorModelAlias,
            defaultSubagentModelAlias: config.defaultSubagentModelAlias ?? config.coordinatorModelAlias,
            models: Object.values(config.models).map((m) => ({
              alias: m.alias,
              provider: m.provider,
              model: m.model,
              baseUrl: m.baseUrl,
              hasKey: Boolean(deps.configStore.getSecret(m.apiKeyRef)),
            })),
          },
          null,
          2
        );
      }
      if (action === "upsert") {
        const alias = String(args.alias ?? "").trim().toLowerCase();
        const provider = String(args.provider ?? "openai") as ProviderKind;
        const model = String(args.model ?? "");
        const apiKey = typeof args.apiKey === "string" ? args.apiKey.trim() : undefined;
        if (!alias) throw new Error("Model alias is required.");
        const profile = await deps.configStore.upsertModel({
          alias,
          provider,
          model,
          apiKey,
          baseUrl: typeof args.baseUrl === "string" ? args.baseUrl : undefined,
          makeCoordinator: Boolean(args.makeCoordinator),
          makeDefaultSubagent: Boolean(args.makeDefaultSubagent),
        });
        if (apiKey) {
          await deps.chatStore.redactSecretInHistory(apiKey);
        }
        return JSON.stringify({
          ok: true,
          alias: profile.alias,
          provider: profile.provider,
          model: profile.model,
          baseUrl: profile.baseUrl,
          apiKeyRedactedFromHistory: Boolean(apiKey),
        });
      }
      if (action === "remove") {
        const alias = String(args.alias ?? "");
        const removed = await deps.configStore.removeModel(alias);
        return JSON.stringify({ ok: removed });
      }
      throw new Error(`Unsupported manage_models action: ${action}`);
    }

    case "configure_context": {
      const patch: Partial<typeof config.context> = {};
      if (typeof args.compactionTokenThreshold === "number") {
        patch.compactionTokenThreshold = Math.max(10_000, Math.floor(args.compactionTokenThreshold));
      }
      if (typeof args.idleCompactionMinutes === "number") {
        patch.idleCompactionMinutes = Math.max(0, Math.floor(args.idleCompactionMinutes));
      }
      if (typeof args.keepRecentMessages === "number") {
        patch.keepRecentMessages = Math.max(2, Math.floor(args.keepRecentMessages));
      }
      const updated = await deps.configStore.updateContextConfig(patch);
      return JSON.stringify(updated, null, 2);
    }

    case "trigger_compaction": {
      const summary = await deps.onTriggerCompaction();
      return JSON.stringify({ ok: true, summaryLength: summary.length });
    }

    case "list_extensions": {
      return JSON.stringify(deps.extensionLoader.getReport(), null, 2);
    }

    case "restart_service": {
      const reason = typeof args.reason === "string" ? formatUserVisibleReply(args.reason) : "";
      const force = args.force === true;
      if (!force) {
        const running = deps.subagentManager.listRuns(50).filter((r) => r.status === "running");
        if (running.length > 0) {
          return (
            `BLOCKED_RUNNING_SUBAGENTS: 仍有 ${running.length} 个后台子代理在运行` +
            `（${running.map((r) => r.label).join(", ")}），请等其完成后再重启，或传 force=true 强制重启。`
          );
        }
      }
      if (!deps.onRequestRestart) {
        return "ERROR: 当前运行模式未挂载自重启控制器（仅 CLI daemon/acl 模式支持自重启）。";
      }
      await writeFileAtomic(
        deps.configStore.paths.restartMarkerPath,
        JSON.stringify({ requestedAt: new Date().toISOString(), reason })
      );
      await deps.chatStore.appendMessage({
        role: "assistant",
        origin: "coordinator",
        text: formatUserVisibleReply("正在重启服务加载新代码，1~2 秒后自动恢复。"),
      });
      deps.onRequestRestart(reason);
      return JSON.stringify({ restarting: true, reason });
    }

    default: {
      const sharedRes = await executeHostTool(name, args, deps);
      if (sharedRes !== undefined) return sharedRes;
      throw new Error(`Unknown coordinator tool: ${name}`);
    }
  }
}
