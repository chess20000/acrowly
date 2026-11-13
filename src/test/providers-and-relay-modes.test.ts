import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, resolveRuntimePaths } from "../config/store.js";
import { LlmClient } from "../llm/client.js";
import { AcrowlyRelayServer } from "../relay/server.js";
import { createAcrowlyDaemon } from "../runtime.js";
import {
  generateEd25519KeyPair,
  signWithEd25519PrivateKey,
} from "../server/ed25519.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acrowly-prov-"));
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
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("Timed out waiting for condition");
}

test("LlmClient formats Gemini (with thoughtSignature) and Anthropic (with ephemeral cache) requests properly", async () => {
  await withTempDir(async (dir) => {
    const capturedRequests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];

    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        capturedRequests.push({ path: req.url ?? "", headers: req.headers, body });

        if ((req.url ?? "").includes(":generateContent")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      { thought: true, text: "internal reasoning" },
                      {
                        functionCall: { name: "ping", args: { n: 1 } },
                        thoughtSignature: "sig_abc_123",
                      },
                    ],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 111, candidatesTokenCount: 22 },
            })
          );
          return;
        }

        if ((req.url ?? "").endsWith("/messages")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              content: [
                { type: "text", text: "Hello from Claude" },
                { type: "tool_use", id: "tu_1", name: "ping", input: { n: 2 } },
              ],
              usage: { input_tokens: 222, output_tokens: 33 },
            })
          );
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = (mockServer.address() as { port: number }).port;

    try {
      const configStore = new ConfigStore(resolveRuntimePaths(dir));
      await configStore.init();

      const gemProfile = await configStore.upsertModel({
        alias: "gem",
        provider: "gemini",
        model: "gemini-2.5-pro",
        apiKey: "gem-key-123",
        baseUrl: `http://127.0.0.1:${port}/v1beta`,
      });

      const claudeProfile = await configStore.upsertModel({
        alias: "claude",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        apiKey: "ant-key-123",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });

      const client = new LlmClient(configStore);

      const gemRes = await client.chat({
        profile: gemProfile,
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "ping",
            description: "ping tool",
            parameters: { type: "object", properties: { n: { type: "number" } } },
          },
        ],
      });
      assert.equal(gemRes.promptTokens, 111);
      assert.equal(gemRes.toolCalls.length, 1);
      assert.equal(gemRes.toolCalls[0].providerMeta?.thoughtSignature, "sig_abc_123");

      // Second Gemini call echoes thoughtSignature back properly
      await client.chat({
        profile: gemProfile,
        systemPrompt: "sys",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", toolCalls: gemRes.toolCalls },
          { role: "tool", toolCallId: gemRes.toolCalls[0].id, toolName: "ping", content: '{"ok":true}' },
        ],
      });
      const secondGemBody = capturedRequests[1].body as {
        contents: Array<{ parts: Array<{ thoughtSignature?: string }> }>;
      };
      assert.equal(secondGemBody.contents[1].parts[0].thoughtSignature, "sig_abc_123");

      const claudeRes = await client.chat({
        profile: claudeProfile,
        systemPrompt: "sys prompt",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(claudeRes.content, "Hello from Claude");
      assert.equal(claudeRes.promptTokens, 222);
      assert.equal(capturedRequests[2].headers["x-api-key"], "ant-key-123");
      const claudeBody = capturedRequests[2].body as {
        system: Array<{ cache_control?: { type: string } }>;
      };
      assert.equal(claudeBody.system[0].cache_control?.type, "ephemeral");
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});

test("Relay supports X-Acrowly-Device header routing, binary /api/files uploads, and multipart /api/chat/messages over tunnel", async () => {
  await withTempDir(async (dir) => {
    const relay = new AcrowlyRelayServer({ host: "127.0.0.1", port: 0, baseDomain: "acrowly.com" });
    const relayAddr = await relay.start();
    const relayBase = `http://127.0.0.1:${relayAddr.port}`;

    const prevPort = process.env.PORT;
    process.env.PORT = "0";
    const daemon = await createAcrowlyDaemon(dir);

    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-dummy",
        model: "gpt-4.1",
        baseUrl: "http://127.0.0.1:9/v1",
      });
      const iosKey = generateEd25519KeyPair("ios-app");
      await daemon.configStore.addAuthorizedPublicKey(iosKey.rawPublicKeyBase64, "ios-app");
      await daemon.configStore.updateRelayConfig({
        enabled: true,
        url: `ws://127.0.0.1:${relayAddr.port}/tunnel`,
        deviceId: "iphone-node",
      });
      await daemon.start();
      await waitFor(() => daemon.tunnelClient.isConnected());

      // Authenticate via X-Acrowly-Device header using Ed25519 challenge-verify
      const chRes = await fetch(`${relayBase}/api/auth/challenge`, {
        method: "POST",
        headers: {
          "X-Acrowly-Device": "iphone-node",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fingerprint: iosKey.fingerprint }),
      });
      assert.equal(chRes.status, 200);
      const ch = (await chRes.json()) as { challengeId: string; message: string };
      const sig = signWithEd25519PrivateKey(iosKey.privateKeyPem, ch.message);

      const verRes = await fetch(`${relayBase}/api/auth/verify`, {
        method: "POST",
        headers: {
          "X-Acrowly-Device": "iphone-node",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ challengeId: ch.challengeId, signature: sig }),
      });
      assert.equal(verRes.status, 200);
      const { token: sessionToken } = (await verRes.json()) as { token: string };

      // Upload image via X-Acrowly-Device header (as iOS App does to https://acrowly.com/api/files)
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      const upRes = await fetch(`${relayBase}/api/files`, {
        method: "POST",
        headers: {
          "X-Acrowly-Device": "iphone-node",
          Authorization: `Bearer ${sessionToken}`,
          "X-Filename": "ios-photo.png",
          "Content-Type": "image/png",
        },
        body: pngBytes,
      });
      assert.equal(upRes.status, 201);
      const upJson = (await upRes.json()) as { url: string; kind: string };
      assert.equal(upJson.kind, "image");

      const downRes = await fetch(`${relayBase}${upJson.url}`, {
        headers: {
          "X-Acrowly-Device": "iphone-node",
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      assert.equal(downRes.status, 200);
      assert.deepEqual(Buffer.from(await downRes.arrayBuffer()), pngBytes);

      // Arbitrary file (including video) upload over tunnel succeeds with 201
      const vidRes = await fetch(`${relayBase}/api/files`, {
        method: "POST",
        headers: {
          "X-Acrowly-Device": "iphone-node",
          Authorization: `Bearer ${sessionToken}`,
          "X-Filename": "movie.mp4",
          "Content-Type": "video/mp4",
        },
        body: Buffer.from("fake-video-bytes"),
      });
      assert.equal(vidRes.status, 201);
      const vidJson = (await vidRes.json()) as { kind: string; mime: string; url: string };
      assert.equal(vidJson.kind, "file");
      assert.equal(vidJson.mime, "video/mp4");

      const vidRangeRes = await fetch(`${relayBase}${vidJson.url}`, {
        headers: {
          "X-Acrowly-Device": "iphone-node",
          Authorization: `Bearer ${sessionToken}`,
          Range: "bytes=0-3",
        },
      });
      assert.equal(vidRangeRes.status, 206);
      assert.equal(await vidRangeRes.text(), "fake");

      // Multipart POST /api/chat/messages with text + file over tunnel
      const boundary = "----relayMultipartBoundary";
      const mpBody = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n看下这个附件\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.pdf"\r\nContent-Type: application/pdf\r\n\r\n` +
            `%PDF-1.4-mock` +
            `\r\n--${boundary}--\r\n`
        ),
      ]);
      const mpChatRes = await fetch(`${relayBase}/api/chat/messages`, {
        method: "POST",
        headers: {
          "X-Acrowly-Device": "iphone-node",
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: mpBody,
      });
      assert.equal(mpChatRes.status, 202);
      const mpChatJson = (await mpChatRes.json()) as {
        message: { text: string };
        attachments: Array<{ name: string; mime: string; url: string }>;
      };
      assert.equal(mpChatJson.attachments.length, 1);
      assert.equal(mpChatJson.attachments[0].name, "report.pdf");
      assert.equal(mpChatJson.attachments[0].mime, "application/pdf");
      assert.match(mpChatJson.message.text, /看下这个附件/);
      assert.match(mpChatJson.message.text, /\[report\.pdf\]\(\/api\/files\//);
    } finally {
      await daemon.stop();
      await relay.stop();
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});

test("DeepSeek thinking-mode preserves reasoning_content (including empty string) across Coordinator and Subagent tool loops", async () => {
  await withTempDir(async (dir) => {
    const prevPort = process.env.PORT;
    process.env.PORT = "0";

    const observedReasonings: Array<{ roleType: string; value: unknown }> = [];

    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{
            role: string;
            content?: string | null;
            reasoning_content?: string;
            tool_calls?: Array<{ id: string }>;
          }>;
        };

        // Strict DeepSeek validation: any assistant message with tool_calls MUST carry reasoning_content
        for (const msg of body.messages) {
          if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            if (msg.reasoning_content === undefined) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: {
                    message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
                    type: "invalid_request_error",
                    param: null,
                    code: "invalid_request_error",
                  },
                })
              );
              return;
            }
          }
        }

        const systemContent = body.messages[0]?.content ?? "";
        const isSubagent = systemContent.includes("执行型子代理");
        const lastMsg = body.messages[body.messages.length - 1];

        let reply: unknown;
        if (isSubagent) {
          if (lastMsg?.role === "tool") {
            const assistantWithTools = [...body.messages]
              .reverse()
              .find((m) => m.role === "assistant" && m.tool_calls?.length);
            observedReasonings.push({
              roleType: "subagent",
              value: assistantWithTools?.reasoning_content,
            });
            reply = {
              choices: [
                {
                  message: {
                    role: "assistant",
                    reasoning_content: "Subagent finished inspecting workspace.",
                    content: "子代理核查完成：环境就绪。",
                  },
                },
              ],
            };
          } else {
            // Exercise empty-string reasoning_content preservation edge case
            reply = {
              choices: [
                {
                  message: {
                    role: "assistant",
                    reasoning_content: "",
                    content: null,
                    tool_calls: [
                      {
                        id: "sub_list_1",
                        type: "function",
                        function: { name: "list_files", arguments: JSON.stringify({ path: "." }) },
                      },
                    ],
                  },
                },
              ],
            };
          }
        } else if (lastMsg?.role === "tool") {
          const assistantWithTools = [...body.messages]
            .reverse()
            .find((m) => m.role === "assistant" && m.tool_calls?.length);
          observedReasonings.push({
            roleType: "coordinator",
            value: assistantWithTools?.reasoning_content,
          });
          reply = {
            choices: [
              {
                message: {
                  role: "assistant",
                  reasoning_content: "Everything succeeded without HTTP 400.",
                  content: `最终完成：${String(lastMsg.content ?? "")}`,
                },
              },
            ],
          };
        } else {
          reply = {
            choices: [
              {
                message: {
                  role: "assistant",
                  reasoning_content: "I should reply to the user first then dispatch a subagent.",
                  content: null,
                  tool_calls: [
                    {
                      id: "coord_reply_1",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "收到，我先派子代理去看下。" }),
                      },
                    },
                    {
                      id: "coord_sub_1",
                      type: "function",
                      function: {
                        name: "dispatch_subagent",
                        arguments: JSON.stringify({ task: "检查当前目录", context: "测试思维链" }),
                      },
                    },
                  ],
                },
              },
            ],
          };
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = (mockServer.address() as { port: number }).port;
    const daemon = await createAcrowlyDaemon(dir);

    try {
      await daemon.configStore.setBootstrapModel({
        provider: "deepseek",
        apiKey: "sk-ds-test",
        model: "deepseek-flash",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
      await daemon.start();

      const userMsg = await daemon.chatStore.appendMessage({ role: "user", text: "帮我检查下环境" });
      daemon.coordinator.notifyUserMessage();

      await waitFor(() =>
        daemon.chatStore
          .getAllMessages()
          .some((m) => m.role === "assistant" && m.text.includes("最终完成："))
      );

      const msgs = daemon.chatStore
        .getAllMessages()
        .filter((m) => m.role === "assistant" && m.seq > userMsg.message.seq);
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].text, "收到，我先派子代理去看下。");
      assert.match(msgs[1].text, /子代理核查完成：环境就绪/);
      assert.deepEqual(observedReasonings, [
        { roleType: "subagent", value: "" },
        { roleType: "coordinator", value: "I should reply to the user first then dispatch a subagent." },
      ]);
    } finally {
      await daemon.stop();
      mockServer.closeAllConnections();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});

test("Coordinator blocks silent work tools on step 0 until an immediate reply is sent first", async () => {
  await withTempDir(async (dir) => {
    const prevPort = process.env.PORT;
    process.env.PORT = "0";

    const timeline: string[] = [];
    let coordCallIndex = 0;
    let sawReplyBeforeWork = false;
    let daemon!: Awaited<ReturnType<typeof createAcrowlyDaemon>>;

    const mockServer = http.createServer((req, res) => {
      if (req.url === "/work-callback") {
        sawReplyBeforeWork = daemon.chatStore
          .getAllMessages()
          .some((m) => m.role === "assistant" && m.text === "好的，我现在帮你执行。");
        timeline.push("work_executed");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content?: string | null }>;
        };
        const lastMsg = body.messages[body.messages.length - 1];
        coordCallIndex += 1;

        let reply: unknown;
        if (coordCallIndex === 1) {
          // Step 0 attempt: tries silent work tool without send_chat_message and without text content
          reply = {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_work_silent",
                      type: "function",
                      function: { name: "ext_probe_work", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          };
        } else if (coordCallIndex === 2) {
          assert.equal(lastMsg?.role, "tool");
          assert.match(String(lastMsg.content ?? ""), /^BLOCKED_REPLY_FIRST:/);
          timeline.push("blocked_seen");
          // Step 1 recovery: replies first via send_chat_message AND runs work tool
          reply = {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_reply_now",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "好的，我现在帮你执行。" }),
                      },
                    },
                    {
                      id: "call_work_allowed",
                      type: "function",
                      function: { name: "ext_probe_work", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          };
        } else {
          assert.equal(lastMsg?.role, "tool");
          assert.equal(lastMsg?.content, "probe_ok");
          reply = {
            choices: [
              {
                message: {
                  content: "工作已顺利结束。",
                },
              },
            ],
          };
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = (mockServer.address() as { port: number }).port;
    daemon = await createAcrowlyDaemon(dir);

    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-test",
        model: "gpt-4.1",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
      await fs.mkdir(daemon.configStore.paths.extensionsDir, { recursive: true });
      await fs.writeFile(
        path.join(daemon.configStore.paths.extensionsDir, "probe.mjs"),
        `export default {
  name: "ext_probe_work",
  description: "Record work execution",
  parameters: { type: "object", properties: {} },
  async execute() {
    await fetch("http://127.0.0.1:${port}/work-callback");
    return "probe_ok";
  }
};
`,
        "utf8"
      );
      await daemon.extensionLoader.reload();

      await daemon.start();

      const userMsg = await daemon.chatStore.appendMessage({ role: "user", text: "帮我跑个扩展" });
      daemon.coordinator.notifyUserMessage();

      await waitFor(() =>
        daemon.chatStore
          .getAllMessages()
          .some((m) => m.role === "assistant" && m.text.includes("工作已顺利结束"))
      );

      assert.deepEqual(timeline, ["blocked_seen", "work_executed"]);
      assert.equal(sawReplyBeforeWork, true);
      const assistantMsgs = daemon.chatStore
        .getAllMessages()
        .filter((m) => m.role === "assistant" && m.seq > userMsg.message.seq);
      assert.equal(assistantMsgs[0].text, "好的，我现在帮你执行。");
      assert.equal(assistantMsgs[1].text, "工作已顺利结束。");
    } finally {
      await daemon.stop();
      mockServer.closeAllConnections();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});

test("Coordinator interrupts its own wait immediately on new user message without interrupting running subagent", async () => {
  await withTempDir(async (dir) => {
    const prevPort = process.env.PORT;
    process.env.PORT = "0";

    let subagentAborted = false;
    let subagentFinished = false;
    let resolveSubagentStarted: (() => void) | undefined;
    const subagentStartedPromise = new Promise<void>((resolve) => {
      resolveSubagentStarted = resolve;
    });
    const turn2SeenMessages: Array<Array<{ role: string; content: unknown }>> = [];

    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content: unknown }>;
        };
        const sys = String(body.messages[0]?.content ?? "");
        const isSubagent = sys.includes("执行型子代理");

        if (isSubagent) {
          resolveSubagentStarted?.();
          const timer = setTimeout(() => {
            if (!res.writableEnded) {
              subagentFinished = true;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  choices: [{ message: { content: "子代理后台完成：微信 Bot 已就绪" } }],
                })
              );
            }
          }, 500);

          res.on("close", () => {
            clearTimeout(timer);
            if (!res.writableFinished && !subagentFinished) {
              subagentAborted = true;
            }
          });
          return;
        }

        const userContents = body.messages
          .filter((m) => m.role === "user")
          .map((m) => String(m.content ?? ""));
        const latestUser = userContents[userContents.length - 1] ?? "";

        if (latestUser.includes("系统后台通知")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                { message: { content: "顺便同步：后台子代理任务已完成（微信 Bot 已就绪）" } },
              ],
            })
          );
          return;
        }

        if (latestUser.includes("任务B")) {
          turn2SeenMessages.push(body.messages);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                { message: { content: "已立即打断协调器等待，先按你的最新指令“任务B”处理！" } },
              ],
            })
          );
          return;
        }

        // Turn 1 for 任务A: reply first then start slow subagent
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "好的，正在执行任务A...",
                  tool_calls: [
                    {
                      id: "call_slow_sub",
                      type: "function",
                      function: {
                        name: "dispatch_subagent",
                        arguments: JSON.stringify({
                          label: "wechat-bot",
                          task: "后台执行一个耗时任务",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })
        );
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = (mockServer.address() as { port: number }).port;
    const daemon = await createAcrowlyDaemon(dir);

    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-test",
        model: "gpt-4.1",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
      await daemon.start();

      await daemon.chatStore.appendMessage({ role: "user", text: "开始任务A" });
      daemon.coordinator.notifyUserMessage();

      await subagentStartedPromise;
      const interruptAt = Date.now();

      await daemon.chatStore.appendMessage({ role: "user", text: "等等，改成任务B" });
      daemon.coordinator.notifyUserMessage();

      await waitFor(
        () =>
          daemon.chatStore
            .getAllMessages()
            .some((m) => m.role === "assistant" && m.text.includes("已立即打断协调器等待")),
        3000
      );

      const elapsedMs = Date.now() - interruptAt;
      assert.ok(elapsedMs < 350, `Expected fast coordinator interrupt, got ${elapsedMs}ms`);
      assert.equal(subagentAborted, false, "Subagent must NOT be aborted by user message");
      assert.equal(subagentFinished, false, "Coordinator should reply BEFORE subagent finishes");

      // Background subagent finishes undisturbed and Coordinator reports completion afterward
      await waitFor(
        () =>
          daemon.chatStore
            .getAllMessages()
            .some((m) => m.role === "assistant" && m.text.includes("微信 Bot 已就绪")),
        3000
      );
      assert.equal(subagentFinished, true);
      assert.equal(subagentAborted, false);
      assert.equal(
        daemon.chatStore.getAllMessages().some((m) => m.text.includes("系统后台通知")),
        false,
        "Transient background notice must not pollute persistent chatStore"
      );

      // Verify consecutive user messages without an interleaving assistant turn stay valid
      assert.equal(turn2SeenMessages.length, 1);
      const roles = turn2SeenMessages[0].map((m) => m.role);
      for (let i = 1; i < roles.length; i += 1) {
        if (roles[i] === "user") {
          assert.notEqual(roles[i - 1], "user", "Adjacent user messages must be merged");
        }
      }

      // Also verify consecutive user messages queued back-to-back merge cleanly into one user entry
      await daemon.chatStore.appendMessage({ role: "user", text: "连续消息1" });
      await daemon.chatStore.appendMessage({ role: "user", text: "任务B：连续消息2" });
      daemon.coordinator.notifyUserMessage();
      await waitFor(() => turn2SeenMessages.length === 2, 3000);
      const mergedTurn = turn2SeenMessages[1];
      const mergedRoles = mergedTurn.map((m) => m.role);
      for (let i = 1; i < mergedRoles.length; i += 1) {
        if (mergedRoles[i] === "user") {
          assert.notEqual(mergedRoles[i - 1], "user");
        }
      }
      assert.match(String(mergedTurn[mergedTurn.length - 1].content ?? ""), /连续消息1\n\n任务B：连续消息2/);
    } finally {
      await daemon.stop();
      mockServer.closeAllConnections();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});
