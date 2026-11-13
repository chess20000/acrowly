import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcrowlyConfig, AuthorizedPublicKey, ModelProfile, ProviderKind } from "../types.js";
import { parseEd25519PublicKey } from "../server/ed25519.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RuntimePaths {
  rootDir: string;
  dataDir: string;
  webuiDir: string;
  extensionsDir: string;
  snapshotsDir: string;
  filesDir: string;
  chatDir: string;
  configPath: string;
  secretsPath: string;
  contextPath: string;
}

export function resolveRuntimePaths(rootDir?: string): RuntimePaths {
  const effectiveRoot = rootDir
    ? path.resolve(rootDir)
    : process.env.ACROWLY_HOME
      ? path.resolve(process.env.ACROWLY_HOME)
      : PACKAGE_ROOT;
  const dataDir = process.env.ACROWLY_DATA_DIR
    ? path.resolve(process.env.ACROWLY_DATA_DIR)
    : path.join(effectiveRoot, "data");
  const webuiDir = process.env.ACROWLY_WEBUI_DIR
    ? path.resolve(process.env.ACROWLY_WEBUI_DIR)
    : path.join(effectiveRoot, "webui");

  return {
    rootDir: effectiveRoot,
    dataDir,
    webuiDir,
    extensionsDir: path.join(dataDir, "extensions"),
    snapshotsDir: path.join(dataDir, ".snapshots"),
    filesDir: path.join(dataDir, "files"),
    chatDir: path.join(dataDir, "chat"),
    configPath: path.join(dataDir, "config.json"),
    secretsPath: path.join(dataDir, "secrets.json"),
    contextPath: path.join(dataDir, "context.json"),
  };
}

export function getDefaultModelForProvider(provider: ProviderKind): string {
  switch (provider) {
    case "openai":
      return "gpt-4.1";
    case "gemini":
      return "gemini-2.5-pro";
    case "anthropic":
      return "claude-sonnet-4-5";
    case "deepseek":
      return "deepseek-flash";
    case "openrouter":
      return "anthropic/claude-sonnet-4.5";
    case "ollama":
      return "qwen2.5:14b";
    case "custom":
      return "default";
  }
}

export function getDefaultBaseUrlForProvider(provider: ProviderKind): string | undefined {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "ollama":
      return "http://127.0.0.1:11434/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "custom":
      return undefined;
  }
}

export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export async function writeFileAtomic(filePath: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, { encoding: "utf8", mode });
  await fs.rename(tmpPath, filePath);
}

function defaultDeviceId(): string {
  const suffix = crypto.randomBytes(3).toString("hex");
  return `acrowly-${suffix}`;
}

export function createDefaultConfig(): AcrowlyConfig {
  const parsedPort = process.env.PORT !== undefined ? Number(process.env.PORT) : 8787;
  const port = Number.isFinite(parsedPort) && parsedPort >= 0 ? parsedPort : 8787;
  const host = process.env.HOST ?? "127.0.0.1";
  return {
    version: 1,
    initialized: false,
    coordinatorModelAlias: "coordinator",
    models: {},
    auth: {
      cookieSecret: crypto.randomBytes(32).toString("hex"),
      authorizedKeys: [],
    },
    relay: {
      enabled: false,
      url: process.env.ACROWLY_RELAY_URL ?? "wss://acrowly.com/tunnel",
      deviceId: defaultDeviceId(),
      tunnelSecret: crypto.randomBytes(24).toString("hex"),
    },
    context: {
      compactionTokenThreshold: 200_000,
      idleCompactionMinutes: 30,
      minIdleTokens: 20_000,
      keepRecentMessages: 10,
    },
    server: {
      host,
      port,
    },
  };
}

export class ConfigStore {
  private config: AcrowlyConfig;
  private secrets: Record<string, string> = {};

  constructor(public readonly paths: RuntimePaths) {
    this.config = createDefaultConfig();
  }

  async init(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.paths.dataDir, { recursive: true }),
      fs.mkdir(this.paths.webuiDir, { recursive: true }),
      fs.mkdir(this.paths.extensionsDir, { recursive: true }),
      fs.mkdir(this.paths.snapshotsDir, { recursive: true }),
      fs.mkdir(this.paths.filesDir, { recursive: true }),
      fs.mkdir(this.paths.chatDir, { recursive: true }),
    ]);

    try {
      const raw = await fs.readFile(this.paths.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AcrowlyConfig>;
      const defaults = createDefaultConfig();
      this.config = {
        ...defaults,
        ...parsed,
        auth: { ...defaults.auth, ...(parsed.auth ?? {}) },
        relay: { ...defaults.relay, ...(parsed.relay ?? {}) },
        context: { ...defaults.context, ...(parsed.context ?? {}) },
        server: { ...defaults.server, ...(parsed.server ?? {}) },
        models: parsed.models ?? {},
      };
    } catch {
      await this.saveConfig();
    }

    try {
      const rawSecrets = await fs.readFile(this.paths.secretsPath, "utf8");
      this.secrets = JSON.parse(rawSecrets) as Record<string, string>;
    } catch {
      await this.saveSecrets();
    }
  }

  getConfig(): AcrowlyConfig {
    return this.config;
  }

  getSecret(keyRef: string): string | undefined {
    return this.secrets[keyRef];
  }

  async setSecret(keyRef: string, value: string): Promise<void> {
    this.secrets[keyRef] = value;
    await this.saveSecrets();
  }

  async deleteSecret(keyRef: string): Promise<void> {
    delete this.secrets[keyRef];
    await this.saveSecrets();
  }

  async setBootstrapModel(input: {
    provider: ProviderKind;
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }): Promise<ModelProfile> {
    const alias = "coordinator";
    const apiKeyRef = `model.${alias}.apiKey`;
    await this.setSecret(apiKeyRef, input.apiKey.trim());

    const profile: ModelProfile = {
      alias,
      provider: input.provider,
      model: input.model?.trim() || getDefaultModelForProvider(input.provider),
      baseUrl: input.baseUrl?.trim() || getDefaultBaseUrlForProvider(input.provider),
      apiKeyRef,
    };

    this.config.models[alias] = profile;
    this.config.coordinatorModelAlias = alias;
    this.config.initialized = true;
    await this.saveConfig();
    return profile;
  }

  async upsertModel(input: {
    alias: string;
    provider: ProviderKind;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    makeCoordinator?: boolean;
    makeDefaultSubagent?: boolean;
  }): Promise<ModelProfile> {
    const alias = input.alias.trim().toLowerCase();
    const existing = this.config.models[alias];
    const apiKeyRef = existing?.apiKeyRef ?? `model.${alias}.apiKey`;

    if (input.apiKey !== undefined) {
      await this.setSecret(apiKeyRef, input.apiKey.trim());
    }

    const profile: ModelProfile = {
      alias,
      provider: input.provider,
      model: input.model.trim() || getDefaultModelForProvider(input.provider),
      baseUrl: input.baseUrl?.trim() ?? existing?.baseUrl ?? getDefaultBaseUrlForProvider(input.provider),
      apiKeyRef,
    };

    this.config.models[alias] = profile;
    if (input.makeCoordinator) {
      this.config.coordinatorModelAlias = alias;
    }
    if (input.makeDefaultSubagent) {
      this.config.defaultSubagentModelAlias = alias;
    }
    this.config.initialized = true;
    await this.saveConfig();
    return profile;
  }

  async removeModel(alias: string): Promise<boolean> {
    const normalized = alias.trim().toLowerCase();
    const existing = this.config.models[normalized];
    if (!existing || normalized === this.config.coordinatorModelAlias) {
      return false;
    }
    delete this.config.models[normalized];
    if (this.config.defaultSubagentModelAlias === normalized) {
      delete this.config.defaultSubagentModelAlias;
    }
    await this.deleteSecret(existing.apiKeyRef);
    await this.saveConfig();
    return true;
  }

  async addAuthorizedPublicKey(
    publicKeyInput: string,
    label?: string
  ): Promise<{ key: AuthorizedPublicKey; alreadyExists: boolean }> {
    const parsed = parseEd25519PublicKey(publicKeyInput);
    const existing = this.config.auth.authorizedKeys.find(
      (k) => k.fingerprint === parsed.fingerprint
    );
    if (existing) {
      if (label && label.trim() && label.trim() !== existing.label) {
        existing.label = label.trim();
        await this.saveConfig();
      }
      return { key: existing, alreadyExists: true };
    }

    const record: AuthorizedPublicKey = {
      id: `key_${crypto.randomBytes(6).toString("hex")}`,
      label: label?.trim() || parsed.comment || "client-device",
      rawPublicKeyBase64: parsed.rawPublicKeyBase64,
      openssh: parsed.openssh,
      fingerprint: parsed.fingerprint,
      addedAt: new Date().toISOString(),
    };

    this.config.auth.authorizedKeys.push(record);
    await this.saveConfig();
    return { key: record, alreadyExists: false };
  }

  findAuthorizedKey(query: { fingerprint?: string; publicKey?: string }): AuthorizedPublicKey | undefined {
    if (query.fingerprint) {
      const targetFp = query.fingerprint.trim();
      const byFp = this.config.auth.authorizedKeys.find((k) => k.fingerprint === targetFp);
      if (byFp) return byFp;
    }
    if (query.publicKey) {
      try {
        const parsed = parseEd25519PublicKey(query.publicKey);
        return this.config.auth.authorizedKeys.find((k) => k.fingerprint === parsed.fingerprint);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async touchAuthorizedKeyLastUsed(keyId: string): Promise<void> {
    const item = this.config.auth.authorizedKeys.find((k) => k.id === keyId);
    if (!item) return;
    item.lastUsedAt = new Date().toISOString();
    await this.saveConfig();
  }

  async removeAuthorizedPublicKey(idOrFingerprint: string): Promise<boolean> {
    const target = idOrFingerprint.trim();
    const before = this.config.auth.authorizedKeys.length;
    this.config.auth.authorizedKeys = this.config.auth.authorizedKeys.filter(
      (k) => k.id !== target && k.fingerprint !== target
    );
    if (this.config.auth.authorizedKeys.length === before) return false;
    await this.saveConfig();
    return true;
  }

  async updateContextConfig(patch: Partial<AcrowlyConfig["context"]>): Promise<AcrowlyConfig["context"]> {
    this.config.context = { ...this.config.context, ...patch };
    await this.saveConfig();
    return this.config.context;
  }

  async updateRelayConfig(patch: Partial<AcrowlyConfig["relay"]>): Promise<AcrowlyConfig["relay"]> {
    this.config.relay = { ...this.config.relay, ...patch };
    await this.saveConfig();
    return this.config.relay;
  }

  async updateServerConfig(patch: Partial<AcrowlyConfig["server"]>): Promise<AcrowlyConfig["server"]> {
    this.config.server = { ...this.config.server, ...patch };
    await this.saveConfig();
    return this.config.server;
  }

  private async saveConfig(): Promise<void> {
    await writeFileAtomic(this.paths.configPath, JSON.stringify(this.config, null, 2), 0o600);
  }

  private async saveSecrets(): Promise<void> {
    await writeFileAtomic(this.paths.secretsPath, JSON.stringify(this.secrets, null, 2), 0o600);
  }
}
