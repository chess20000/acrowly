import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { ConfigStore } from "../config/store.js";
import {
  getDefaultBaseUrlForProvider,
  getDefaultModelForProvider,
} from "../config/store.js";
import { ensureClientEd25519KeyPair } from "../server/ed25519.js";
import type { ProviderKind } from "../types.js";

const PROVIDER_CHOICES: Array<{ index: string; kind: ProviderKind; label: string }> = [
  { index: "1", kind: "deepseek", label: "DeepSeek" },
  { index: "2", kind: "openai", label: "OpenAI" },
  { index: "3", kind: "gemini", label: "Google Gemini" },
  { index: "4", kind: "anthropic", label: "Anthropic Claude" },
  { index: "5", kind: "openrouter", label: "OpenRouter" },
  { index: "6", kind: "ollama", label: "Ollama (本地开源模型)" },
  { index: "7", kind: "custom", label: "自定义 OpenAI 兼容接口" },
];

function resolveProviderChoice(raw: string): ProviderKind | undefined {
  const cleaned = raw.trim().toLowerCase();
  const byIndex = PROVIDER_CHOICES.find((p) => p.index === cleaned);
  if (byIndex) return byIndex.kind;
  const byName = PROVIDER_CHOICES.find((p) => p.kind === cleaned);
  if (byName) return byName.kind;
  return undefined;
}

function createSafeLineReader() {
  const rl = readline.createInterface({ input, output });
  const queue: string[] = [];
  let closed = false;
  let waiting: ((value: string | null) => void) | undefined;

  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else {
      queue.push(line);
    }
  });

  rl.on("close", () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(null);
    }
  });

  return {
    async question(prompt: string): Promise<string> {
      output.write(prompt);
      if (queue.length > 0) {
        return queue.shift()!;
      }
      if (closed) {
        throw new Error("输入流已提前结束，未能完成首次配置。");
      }
      const line = await new Promise<string | null>((resolve) => {
        waiting = resolve;
      });
      if (line === null) {
        throw new Error("输入流已提前结束，未能完成首次配置。");
      }
      return line;
    },
    close() {
      rl.close();
    },
  };
}

export async function runFirstBootSetup(configStore: ConfigStore): Promise<void> {
  const rl = createSafeLineReader();
  try {
    output.write("\n=== Acrowly 首次启动：设置协调器模型 ===\n");
        output.write("仅需填这一次模型提供商和 Key，之后所有设置（添加设备公钥、穿透、加模型、写网页）都在聊天里直接说。\n\n");

    for (const item of PROVIDER_CHOICES) {
      output.write(`  ${item.index}. ${item.label} (${item.kind})\n`);
    }
    output.write("\n");

    let provider: ProviderKind | undefined;
    while (!provider) {
      const answer = await rl.question("选择模型提供商 [1-7 或名称, 默认 1]: ");
      provider = resolveProviderChoice(answer || "1");
      if (!provider) {
        output.write("输入无效，请输入 1-7 或提供商名称。\n");
      }
    }

    let baseUrl = getDefaultBaseUrlForProvider(provider);
    if (provider === "custom" || provider === "ollama") {
      const defaultHint = baseUrl ? ` [默认 ${baseUrl}]` : "";
      const enteredUrl = await rl.question(`接口 Base URL${defaultHint}: `);
      if (enteredUrl.trim()) {
        baseUrl = enteredUrl.trim();
      }
    }

    const defaultModel = getDefaultModelForProvider(provider);
    const enteredModel = await rl.question(`模型名称 [默认 ${defaultModel}]: `);
    const model = enteredModel.trim() || defaultModel;

    let apiKey = "";
    if (provider !== "ollama") {
      while (!apiKey) {
        const enteredKey = await rl.question(
          provider === "custom" ? "API Key (若本地免密可直接回车): " : "输入 API Key: "
        );
        apiKey = enteredKey.trim();
        if (!apiKey && provider === "custom") {
          break;
        }
        if (!apiKey) {
          output.write("API Key 不能为空。\n");
        }
      }
    }

    await configStore.setBootstrapModel({
      provider,
      apiKey,
      model,
      baseUrl,
    });

    const localKey = await ensureClientEd25519KeyPair();
    await configStore.addAuthorizedPublicKey(localKey.publicKeyOpenSsh, "local-cli");

    output.write(`\n已保存协调器模型：${provider} / ${model}\n`);
    output.write(`已为本机终端生成并授权 Ed25519 密钥：${localKey.fingerprint}\n`);
  } finally {
    rl.close();
  }
}
