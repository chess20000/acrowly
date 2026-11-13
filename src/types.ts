export type ProviderKind =
  | "openai"
  | "gemini"
  | "anthropic"
  | "deepseek"
  | "openrouter"
  | "ollama"
  | "custom";

export interface ModelProfile {
  /** Friendly alias used by Coordinator/subagents, e.g. "coordinator", "coder", "fast" */
  alias: string;
  provider: ProviderKind;
  model: string;
  /** Optional custom OpenAI-compatible or provider base URL */
  baseUrl?: string;
  /** Reference key name in secrets vault (never exposed in plain logs) */
  apiKeyRef: string;
}

export interface AuthorizedPublicKey {
  id: string;
  label: string;
  /** Canonical 32-byte raw Ed25519 public key in standard Base64 */
  rawPublicKeyBase64: string;
  /** OpenSSH wire-format string: "ssh-ed25519 AAAA..." */
  openssh: string;
  /** OpenSSH-style SHA256 fingerprint: "SHA256:..." */
  fingerprint: string;
  addedAt: string;
  lastUsedAt?: string;
}

export interface AuthConfig {
  cookieSecret: string;
  authorizedKeys: AuthorizedPublicKey[];
}

export interface RelayConfig {
  enabled: boolean;
  /** Default: wss://acrowly.com/tunnel */
  url: string;
  deviceId: string;
  tunnelSecret: string;
}

export interface ContextConfig {
  /** Default: 200_000 tokens */
  compactionTokenThreshold: number;
  /** Idle auto-compaction delay in minutes (default: 30). 0 disables idle trigger */
  idleCompactionMinutes: number;
  /** Minimum uncompacted tokens before idle compaction bothers running */
  minIdleTokens: number;
  /** Keep latest N chat messages verbatim during compaction */
  keepRecentMessages: number;
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface AcrowlyConfig {
  version: 1;
  initialized: boolean;
  coordinatorModelAlias: string;
  defaultSubagentModelAlias?: string;
  models: Record<string, ModelProfile>;
  auth: AuthConfig;
  relay: RelayConfig;
  context: ContextConfig;
  server: ServerConfig;
}

export interface ChatMessage {
  seq: number;
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  clientMsgId?: string;
}

export interface StoredFileMeta {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  storedPath: string;
  createdAt: string;
}

export interface ContextState {
  frozenSummary: string;
  activeFromSeq: number;
  lastEstimatedPromptTokens: number;
  lastCompactedAt?: string;
  totalCompactions: number;
}

export interface SubagentRunRecord {
  id: string;
  label: string;
  task: string;
  modelAlias: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  resultSummary?: string;
  error?: string;
}

export interface ExtensionToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    ctx: ExtensionExecutionContext
  ) => Promise<unknown> | unknown;
}

export interface ExtensionExecutionContext {
  workspaceDir: string;
  dataDir: string;
  webuiDir: string;
  signal?: AbortSignal;
  publishFile: (localPath: string, displayName?: string) => Promise<{
    id: string;
    kind: "image" | "file";
    url: string;
    markdown: string;
  }>;
  sendMessage: (text: string) => Promise<ChatMessage>;
}
