import fs from "node:fs/promises";
import { CoordinatorEngine } from "./agent/coordinator.js";
import { SubagentManager } from "./agent/subagent.js";
import { ConfigStore, resolveRuntimePaths } from "./config/store.js";
import { ExtensionLoader } from "./extensions/loader.js";
import { SnapshotManager } from "./extensions/snapshot.js";
import { LlmClient } from "./llm/client.js";
import { AcrowlyHttpServer } from "./server/http.js";
import { TunnelClient } from "./server/tunnel-client.js";
import { AttachmentStore } from "./storage/attachment-store.js";
import { ChatStore } from "./storage/chat-store.js";
import { ContextStore } from "./storage/context-store.js";

export interface AcrowlyDaemon {
  configStore: ConfigStore;
  chatStore: ChatStore;
  attachmentStore: AttachmentStore;
  contextStore: ContextStore;
  extensionLoader: ExtensionLoader;
  snapshotManager: SnapshotManager;
  coordinator: CoordinatorEngine;
  httpServer: AcrowlyHttpServer;
  tunnelClient: TunnelClient;
  start: () => Promise<{ host: string; port: number }>;
  stop: () => Promise<void>;
}

export interface AcrowlyDaemonOptions {
  onRestartRequested?: (reason: string) => Promise<void> | void;
}

export async function createAcrowlyDaemon(
  rootDir?: string,
  options?: AcrowlyDaemonOptions
): Promise<AcrowlyDaemon> {
  const paths = resolveRuntimePaths(rootDir);
  const configStore = new ConfigStore(paths);
  await configStore.init();

  const chatStore = new ChatStore(paths.chatDir);
  await chatStore.init();

  const attachmentStore = new AttachmentStore(paths.filesDir);
  await attachmentStore.init();

  const contextStore = new ContextStore(paths.contextPath);
  await contextStore.init();

  const extensionLoader = new ExtensionLoader(paths.extensionsDir);
  await extensionLoader.reload();

  const snapshotManager = new SnapshotManager(
    paths.snapshotsDir,
    paths.webuiDir,
    paths.extensionsDir
  );

  const llm = new LlmClient(configStore);
  const subagentManager = new SubagentManager(llm, paths);

  let tunnelClient!: TunnelClient;
  let restartScheduled = false;

  const handleRestartRequested = (reason: string): void => {
    if (restartScheduled || !options?.onRestartRequested) return;
    restartScheduled = true;
    // Allow SSE flush of the pre-restart status message before closing server connections
    setTimeout(() => {
      void Promise.resolve(options.onRestartRequested!(reason)).catch((err) => {
        console.error("Failed to execute self-restart:", err);
      });
    }, 100);
  };

  const coordinator = new CoordinatorEngine({
    configStore,
    chatStore,
    attachmentStore,
    contextStore,
    extensionLoader,
    snapshotManager,
    subagentManager,
    llm,
    onRelayConfigUpdated: () => tunnelClient.syncConnection(),
    getRelayConnected: () => tunnelClient.isConnected(),
    ...(options?.onRestartRequested ? { onRestartRequested: handleRestartRequested } : {}),
  });

  const httpServer = new AcrowlyHttpServer({
    configStore,
    chatStore,
    attachmentStore,
    coordinator,
    getRelayConnected: () => tunnelClient.isConnected(),
  });

  tunnelClient = new TunnelClient(configStore, httpServer);

  return {
    configStore,
    chatStore,
    attachmentStore,
    contextStore,
    extensionLoader,
    snapshotManager,
    coordinator,
    httpServer,
    tunnelClient,
    start: async () => {
      const addr = await httpServer.start();
      tunnelClient.start();
      coordinator.startBackgroundLoops();

      let restartedFromMarker = false;
      try {
        const raw = await fs.readFile(paths.restartMarkerPath, "utf8");
        await fs.unlink(paths.restartMarkerPath).catch(() => {});
        const parsed = JSON.parse(raw) as { reason?: string };
        restartedFromMarker = true;
        if (configStore.getConfig().initialized) {
          const reasonNote = parsed.reason ? `（${parsed.reason}）` : "";
          await chatStore.appendMessage({
            role: "assistant",
            text: `服务已重启完成（PID ${process.pid}），新代码已生效${reasonNote}。`,
          });
        }
      } catch {
        // No pending restart marker
      }

      if (!restartedFromMarker && configStore.getConfig().initialized) {
        await coordinator.sendWelcomeGreetingIfEmpty();
      }
      return addr;
    },
    stop: async () => {
      await coordinator.stop();
      tunnelClient.stop();
      await httpServer.stop();
    },
  };
}
