#!/usr/bin/env node
import { runFirstBootSetup } from "./cli/bootstrap.js";
import { startPlainTerminalChat } from "./cli/chat.js";
import { ConfigStore, resolveRuntimePaths } from "./config/store.js";
import { AcrowlyRelayServer } from "./relay/server.js";
import { createAcrowlyDaemon } from "./runtime.js";
import { ensureClientEd25519KeyPair } from "./server/ed25519.js";

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

async function isLocalServerAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function printHelp(): void {
  console.log(`Acrowly CLI (v0.1.0)

用法:
  acl                      首次引导配置协调器模型，启动后端并进入纯终端对话
  acl setup                重新配置协调器模型（保留授权密钥与历史数据）
  acl keygen               生成或查看本机客户端 Ed25519 密钥与公钥
  acl add-key <pubkey>     添加已授权设备公钥（可加 --label <设备名>）
  acl daemon               仅启动无头后端服务（默认 http://127.0.0.1:8787）
  acl chat [--url <url>]   连接到本地或远端服务端终端对话（自动 Ed25519 签名登录）
  acl relay [--port 8788]  启动自托管无状态穿透中继服务器
  acl --help | -h          显示本帮助信息`);
}

const KNOWN_SUBCOMMANDS = new Set([
  "start",
  "setup",
  "daemon",
  "chat",
  "relay",
  "keygen",
  "add-key",
  "help",
]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    printHelp();
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log("0.1.0");
    return;
  }

  const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : "start";
  if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
    printHelp();
    throw new Error(`未知命令: ${subcommand}`);
  }

  if (subcommand === "keygen") {
    const pair = await ensureClientEd25519KeyPair();
    console.log(pair.created ? "已生成新的 Ed25519 密钥对：" : "本机已有 Ed25519 密钥对：");
    console.log(`私钥路径: ${pair.privateKeyPath}`);
    console.log(`公钥指纹: ${pair.fingerprint}`);
    console.log(`\n公钥（复制到任何服务端即可授权）：\n${pair.publicKeyOpenSsh}`);
    return;
  }

  if (subcommand === "add-key") {
    const rest = args.slice(1);
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--label") {
        i += 1;
        continue;
      }
      if (!rest[i].startsWith("--")) {
        positional.push(rest[i]);
      }
    }
    const rawKey = positional[0] === "ssh-ed25519" ? positional.join(" ") : positional[0];
    const label = parseFlag(args, "--label");
    if (!rawKey) {
      throw new Error("用法: acl add-key <ssh-ed25519公钥或Base64> [--label 手机名]");
    }
    const paths = resolveRuntimePaths();
    const configStore = new ConfigStore(paths);
    await configStore.init();
    const { key, alreadyExists } = await configStore.addAuthorizedPublicKey(rawKey, label);
    console.log(
      alreadyExists
        ? `公钥已存在: ${key.label} (${key.fingerprint})`
        : `已添加授权公钥: ${key.label} (${key.fingerprint})`
    );
    return;
  }

  if (subcommand === "relay") {
    const port = Number(parseFlag(args, "--port") ?? process.env.PORT ?? 8788) || 8788;
    const host = parseFlag(args, "--host") ?? process.env.HOST ?? "0.0.0.0";
    const domain = parseFlag(args, "--domain") ?? process.env.ACROWLY_RELAY_DOMAIN ?? "acrowly.com";
    const relay = new AcrowlyRelayServer({ host, port, baseDomain: domain });
    const addr = await relay.start();
    console.log(`Acrowly stateless relay listening on http://${addr.host}:${addr.port} (domain: ${domain})`);

    const shutdown = async () => {
      await relay.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return;
  }

  if (subcommand === "chat") {
    const paths = resolveRuntimePaths();
    const configStore = new ConfigStore(paths);
    await configStore.init();
    const cfg = configStore.getConfig().server;
    const targetUrl = parseFlag(args, "--url") ?? `http://${cfg.host}:${cfg.port}`;
    const token = parseFlag(args, "--token");
    await startPlainTerminalChat({ baseUrl: targetUrl, token });
    return;
  }

  // Ensure initial model provider & API key are set on first boot
  const paths = resolveRuntimePaths();
  const preConfig = new ConfigStore(paths);
  await preConfig.init();
  if (!preConfig.getConfig().initialized || subcommand === "setup") {
    await runFirstBootSetup(preConfig);
    if (subcommand === "setup") return;
  }

  if (subcommand === "daemon") {
    const daemon = await createAcrowlyDaemon();
    const addr = await daemon.start();
    console.log(`Acrowly headless daemon listening on http://${addr.host}:${addr.port}`);
    if (daemon.configStore.getConfig().relay.enabled) {
      const relay = daemon.configStore.getConfig().relay;
      console.log(`Outbound relay enabled: ${relay.url} (deviceId: ${relay.deviceId})`);
    }
    const shutdown = async () => {
      await daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return;
  }

  // Default "start" flow: if daemon is already listening on port, attach terminal chat;
  // otherwise boot daemon in-process and drop directly into plain terminal chat.
  const cfgServer = preConfig.getConfig().server;
  const localUrl = `http://${cfgServer.host}:${cfgServer.port}`;

  if (await isLocalServerAlive(localUrl)) {
    await startPlainTerminalChat({ baseUrl: localUrl });
    return;
  }

  const daemon = await createAcrowlyDaemon();
  const addr = await daemon.start();
  const startedUrl = `http://${addr.host}:${addr.port}`;
  console.log(`Acrowly 无头后端已启动: ${startedUrl}`);

  await startPlainTerminalChat({
    baseUrl: startedUrl,
    onExit: async () => {
      await daemon.stop();
    },
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
