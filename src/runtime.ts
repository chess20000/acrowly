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

export async function createAcrowlyDaemon(rootDir?: string): Promise<AcrowlyDaemon> {
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
      if (configStore.getConfig().initialized) {
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
