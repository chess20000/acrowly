import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AcrowlyRelayServer } from "../relay/server.js";
import { createAcrowlyDaemon } from "../runtime.js";
import {
  generateEd25519KeyPair,
  signWithEd25519PrivateKey,
} from "../server/ed25519.js";
import type { ChatMessage } from "../types.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acrowly-e2e-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for condition");
}

interface MockLlmCall {
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: string[];
}

test("End-to-end: acrowly.com Relay tunnel + Coordinator delegates WebUI & live Extension to Subagent + SSE stream + 200K compaction", async () => {
  await withTempDir(async (dir) => {
    const llmCalls: MockLlmCall[] = [];
    let scriptStep = 0;

    // 1. Mock OpenAI-compatible LLM Server
    const mockLlmServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
          tools?: Array<{ function?: { name?: string } }>;
        };
        const system = String(body.messages[0]?.content ?? "");
        const tools = (body.tools ?? []).map((t) => t.function?.name ?? "");
        llmCalls.push({ system, messages: body.messages, tools });

        const isSubagent = system.includes("执行型子代理");
        const isCompactor = system.includes("上下文压缩器");

        let reply: Record<string, unknown>;

        if (isCompactor) {
          reply = {
            choices: [
              {
                message: {
                  content: "【已压缩记忆】用户已配置本地 WebUI 与 greet 热扩展，偏好极简纯对话框。",
                },
              },
            ],
            usage: { prompt_tokens: 500, completion_tokens: 30 },
          };
        } else if (isSubagent) {
          // Subagent step 1: write webui/index.html & data/extensions/greet.mjs, then reload_extensions
          const lastRole = body.messages[body.messages.length - 1]?.role;
          if (lastRole === "user") {
            const extCode = `export default {
  name: "greet_user",
  description: "Return a custom greeting from the hot-reloaded extension.",
  parameters: {
    type: "object",
    properties: { target: { type: "string", description: "Who to greet" } },
    required: ["target"]
  },
  async execute(args) {
    return "Extension says hello to " + args.target;
  }
};`;
            reply = {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "sub_call_1",
                        type: "function",
                        function: {
                          name: "write_file",
                          arguments: JSON.stringify({
                            path: "webui/index.html",
                            content: "<!doctype html><html><body><h1>Minimal Single Chatbox</h1></body></html>",
                          }),
                        },
                      },
                      {
                        id: "sub_call_2",
                        type: "function",
                        function: {
                          name: "write_file",
                          arguments: JSON.stringify({
                            path: "data/extensions/greet.mjs",
                            content: extCode,
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            };
          } else {
            const alreadyReloaded = body.messages.some(
              (m) => m.role === "tool" && String(m.content).includes("ext_greet_user")
            );
            if (!alreadyReloaded) {
              reply = {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "sub_call_3",
                          type: "function",
                          function: {
                            name: "reload_extensions",
                            arguments: "{}",
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            } else {
              reply = {
                choices: [
                  {
                    message: {
                      content: "已完成：写入 webui/index.html 并成功热加载扩展 ext_greet_user。",
                    },
                  },
                ],
              };
            }
          }
        } else {
          // Coordinator turns
          const lastMsg = body.messages[body.messages.length - 1];
          if (lastMsg?.role === "user") {
            const text = String(lastMsg.content);
            if (text.includes("写一个本地网页") && scriptStep === 0) {
              scriptStep = 1;
              reply = {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "coord_call_1",
                          type: "function",
                          function: {
                            name: "send_chat_message",
                            arguments: JSON.stringify({
                              text: "好嘞，我这就派子代理去写本地 WebUI 和热扩展，顺便跟你讲一下免构建 HTML 为什么最稳！",
                            }),
                          },
                        },
                        {
                          id: "coord_call_2",
                          type: "function",
                          function: {
                            name: "dispatch_subagent",
                            arguments: JSON.stringify({
                              label: "build-webui-and-ext",
                              task: "Write webui/index.html and data/extensions/greet.mjs and reload extensions.",
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 1200, completion_tokens: 40 },
              };
            } else if (text.includes("调用刚加的扩展")) {
              reply = {
                choices: [
                  {
                    message: {
                      content: "好，我这就调用 ext_greet_user 测试一下。",
                      tool_calls: [
                        {
                          id: "coord_call_ext",
                          type: "function",
                          function: {
                            name: "ext_greet_user",
                            arguments: JSON.stringify({ target: "Acrowly" }),
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 1500, completion_tokens: 20 },
              };
            } else {
              reply = {
                choices: [
                  {
                    message: {
                      content: "收到，都安排妥当了！",
                    },
                  },
                ],
              };
            }
          } else {
            // Tool response came back to Coordinator
            const toolText = String(lastMsg?.content ?? "");
            if (toolText.includes("Extension says hello to Acrowly")) {
              reply = {
                choices: [
                  {
                    message: {
                      content: `扩展运行成功，返回结果是：${toolText}`,
                    },
                  },
                ],
              };
            } else {
              reply = {
                choices: [
                  {
                    message: {
                      content: "搞定了！子代理已经把 webui/index.html 和 ext_greet_user 扩展全部就绪，刷新网页就能直接聊。",
                    },
                  },
                ],
              };
            }
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });

    await new Promise<void>((resolve) => mockLlmServer.listen(0, "127.0.0.1", resolve));
    const llmAddr = mockLlmServer.address() as { port: number };
    const mockLlmBaseUrl = `http://127.0.0.1:${llmAddr.port}/v1`;

    // 2. Start Stateless Relay Server (simulating acrowly.com)
    const relay = new AcrowlyRelayServer({ host: "127.0.0.1", port: 0, baseDomain: "acrowly.com" });
    const relayAddr = await relay.start();
    const relayHttpBase = `http://127.0.0.1:${relayAddr.port}`;
    const relayWsUrl = `ws://127.0.0.1:${relayAddr.port}/tunnel`;

    const prevPort = process.env.PORT;
    process.env.PORT = "0";
    const daemon = await createAcrowlyDaemon(dir);

    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-mock-key-123456",
        model: "gpt-4.1",
        baseUrl: mockLlmBaseUrl,
      });

      const deviceId = "test-home";
      await daemon.configStore.updateRelayConfig({
        enabled: true,
        url: relayWsUrl,
        deviceId,
      });

      await daemon.start();
      await waitFor(() => daemon.tunnelClient.isConnected());

      // 3. Before any authorized Ed25519 key is added, remote relay requests MUST be denied (403)
      const remoteUnauth = await fetch(`${relayHttpBase}/d/${deviceId}/api/chat/messages`);
      assert.equal(remoteUnauth.status, 403);

      // 4. Add client Ed25519 public key and authenticate over Relay via SSH-style challenge/verify
      const clientKey = generateEd25519KeyPair("e2e-phone");
      await daemon.configStore.addAuthorizedPublicKey(clientKey.publicKeyOpenSsh, "e2e-phone");

      const chRes = await fetch(`${relayHttpBase}/d/${deviceId}/api/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: clientKey.fingerprint }),
      });
      assert.equal(chRes.status, 200);
      const ch = (await chRes.json()) as { challengeId: string; message: string };
      const sig = signWithEd25519PrivateKey(clientKey.privateKeyPem, ch.message);

      const verRes = await fetch(`${relayHttpBase}/d/${deviceId}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: ch.challengeId, signature: sig }),
      });
      assert.equal(verRes.status, 200);
      const { token: sessionToken } = (await verRes.json()) as { token: string };

      // Redirect check on /d/<deviceId> without trailing slash
      const redirectRes = await fetch(`${relayHttpBase}/d/${deviceId}`, { redirect: "manual" });
      assert.equal(redirectRes.status, 302);
      assert.equal(redirectRes.headers.get("location"), `/d/${deviceId}/`);

      // 5. Subscribe to SSE stream THROUGH THE RELAY using Ed25519 session Bearer token
      const receivedSse: ChatMessage[] = [];
      const sseController = new AbortController();
      const sseDone = (async () => {
        const res = await fetch(`${relayHttpBase}/d/${deviceId}/api/chat/stream?after_seq=0`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
          signal: sseController.signal,
        });
        assert.equal(res.status, 200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf("\n\n");
          while (idx !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
            if (dataLine) {
              receivedSse.push(JSON.parse(dataLine.slice(5).trim()) as ChatMessage);
            }
            idx = buf.indexOf("\n\n");
          }
        }
      })().catch(() => {
        // expected on abort
      });

      // 6. Send user message through Relay asking Coordinator to build WebUI + extension
      const send1 = await fetch(`${relayHttpBase}/d/${deviceId}/api/chat/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ text: "帮我写一个本地网页并加个打招呼扩展" }),
      });
      assert.equal(send1.status, 202);

      // Wait until Coordinator finishes subagent task and sends final reply via SSE
      await waitFor(() =>
        receivedSse.some((m) => m.role === "assistant" && m.text.includes("webui/index.html"))
      );

      // Verify WebUI is live through Relay right away without restarting daemon!
      const webuiRes = await fetch(`${relayHttpBase}/d/${deviceId}/`);
      assert.equal(webuiRes.status, 200);
      assert.match(await webuiRes.text(), /Minimal Single Chatbox/);

      // 7. Ask Coordinator to invoke the hot-loaded extension tool
      const send2 = await fetch(`${relayHttpBase}/d/${deviceId}/api/chat/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ text: "现在调用刚加的扩展跟 Acrowly 打个招呼" }),
      });
      assert.equal(send2.status, 202);

      await waitFor(() =>
        receivedSse.some(
          (m) => m.role === "assistant" && m.text.includes("Extension says hello to Acrowly")
        )
      );

      // 8. Verify context compaction freezes summary while preserving full user-visible timeline
      for (let i = 0; i < 6; i += 1) {
        await daemon.chatStore.appendMessage({ role: "user", text: `历史消息 ${i}` });
      }
      await daemon.configStore.updateContextConfig({ keepRecentMessages: 3 });
      const totalBefore = daemon.chatStore.getAllMessages().length;
      const summary = await daemon.coordinator.compactContext("test-200k");
      assert.match(summary, /已压缩记忆/);
      const state = daemon.contextStore.getState();
      assert.equal(state.totalCompactions, 1);
      assert.ok(state.activeFromSeq > 0);
      const win = daemon.contextStore.getPromptWindow(daemon.chatStore.getAllMessages());
      assert.equal(win.activeMessages.length, 3);
      // User-visible full history remains 100% intact
      assert.equal(daemon.chatStore.getAllMessages().length, totalBefore);

      sseController.abort();
      await sseDone;
    } finally {
      await daemon.stop();
      await relay.stop();
      await new Promise<void>((resolve) => mockLlmServer.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});
