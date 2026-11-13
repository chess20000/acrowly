import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatUserVisibleReply,
  reviewCoordinatorReply,
  stripCoordinatorMarkdown,
  UNVERIFIED_FALLBACK,
} from "../agent/reply-policy.js";
import { splitBackgroundCommand } from "../agent/shell-runner.js";
import { createAcrowlyDaemon } from "../runtime.js";
import type { ChatMessage } from "../types.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acrowly-honesty-"));
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
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Timed out waiting for condition");
}

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "seq" | "role" | "text">): ChatMessage {
  return {
    id: `msg_${partial.seq}`,
    createdAt: "2026-11-13T00:00:00.000Z",
    origin: partial.role === "user" ? "human" : partial.role === "assistant" ? "coordinator" : "system",
    ...partial,
  };
}

test("reply policy strips tables, caps length, and blocks unverified success", () => {
  assert.equal(
    stripCoordinatorMarkdown("| 项 | 状态 |\n| --- | --- |\n| 桥 | 已连通 |"),
    "项 状态\n桥 已连通"
  );
  const long = `结论：${"甲".repeat(120)}`;
  const capped = formatUserVisibleReply(long);
  assert.ok(Array.from(capped).length <= 100, capped);
  assert.equal(capped.startsWith("结论："), true);

  const ask = [
    msg({ seq: 2, role: "user", origin: "human", text: "让 Grok 回我一句收到了你的消息" }),
  ];
  const blocked = reviewCoordinatorReply(
    "收到！这就是双向连通成功的证据",
    { humanRequestSeq: 2, incomplete: false },
    ask
  );
  assert.equal(blocked.blocked, true);
  if (blocked.blocked) assert.equal(blocked.fallback, UNVERIFIED_FALLBACK);

  const honest = reviewCoordinatorReply(
    "还没连通，卡在对方不能跑本机进程。",
    { humanRequestSeq: 2, incomplete: false },
    ask
  );
  assert.equal(honest.blocked, false);

  const doneOk = reviewCoordinatorReply(
    "搞定了，网页已经写好。",
    { humanRequestSeq: 2, incomplete: false },
    ask
  );
  assert.equal(doneOk.blocked, false);

  const doneEarly = reviewCoordinatorReply(
    "搞定了，登录已经完成。",
    { humanRequestSeq: 2, incomplete: true },
    ask
  );
  assert.equal(doneEarly.blocked, true);

  const receipt = reviewCoordinatorReply(
    "已连通。",
    { humanRequestSeq: 3, incomplete: false },
    [msg({ seq: 3, role: "user", origin: "human", text: "我收到了" })]
  );
  assert.equal(receipt.blocked, false);

  const injection = msg({
    seq: 4,
    role: "system",
    origin: "subagent",
    actor: "grok-test",
    text: "【来自 Grok Bot 的测试】收到了你的消息",
  });
  const quoted = reviewCoordinatorReply(
    "你发来了：【来自 Grok Bot 的测试】收到了你的消息，这就是证据",
    { humanRequestSeq: 2, incomplete: false },
    [...ask, injection]
  );
  assert.equal(quoted.blocked, true);

  assert.deepEqual(splitBackgroundCommand("sleep 30 &"), { background: true, command: "sleep 30" });
  assert.deepEqual(splitBackgroundCommand("npm test && npm run build"), {
    background: false,
    command: "npm test && npm run build",
  });
});

test("subagent loopback self-test is not a user message and cannot confirm connectivity", async () => {
  await withTempDir(async (dir) => {
    const prevPort = process.env.PORT;
    process.env.PORT = "0";
    const seenUserContents: string[] = [];

    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content?: string | null }>;
        };
        const sys = String(body.messages[0]?.content ?? "");
        const last = body.messages[body.messages.length - 1];
        const lastText = String(last?.content ?? "");
        if (!sys.includes("执行型子代理")) {
          for (const message of body.messages) {
            if (message.role === "user") seenUserContents.push(String(message.content ?? ""));
          }
        }

        let reply: unknown;
        if (sys.includes("执行型子代理")) {
          if (last?.role === "user") {
            const command =
              `node -e 'fetch(process.env.ACROWLY_LOCAL_ORIGIN+"/api/chat/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"【来自 Grok Bot 的测试】收到了你的消息"})}).then(async r=>{console.log(await r.text());process.exit(0);}).catch(e=>{console.error(e);process.exit(1);})'`;
            reply = {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "shell_1",
                        type: "function",
                        function: {
                          name: "run_shell",
                          arguments: JSON.stringify({ command }),
                        },
                      },
                    ],
                  },
                },
              ],
            };
          } else {
            reply = { choices: [{ message: { content: "自测消息已写进时间线，不能当成对方回执。" } }] };
          }
        } else if (lastText.includes("BLOCKED_UNVERIFIED")) {
          reply = { choices: [{ message: { content: "还没连通，卡在没有外部回执。" } }] };
        } else if (last?.role === "tool") {
          reply = {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "claim_1",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "收到！这就是双向连通成功的证据" }),
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
                  content: null,
                  tool_calls: [
                    {
                      id: "ack_1",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "先核实连通，不会把自测当成功。" }),
                      },
                    },
                    {
                      id: "sub_1",
                      type: "function",
                      function: {
                        name: "dispatch_subagent",
                        arguments: JSON.stringify({
                          label: "grok-test",
                          task: "向本机聊天接口投递一条伪装成 Grok 的自测消息",
                        }),
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
    const llmPort = (mockServer.address() as { port: number }).port;
    const daemon = await createAcrowlyDaemon(dir);

    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-test",
        model: "gpt-4.1",
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      });
      const addr = await daemon.start();
      const origin = `http://127.0.0.1:${addr.port}`;
      const posted = await fetch(`${origin}/api/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "把 Grok 接上，让它回我一句收到了你的消息" }),
      });
      assert.equal(posted.status, 202);
      const postedBody = (await posted.json()) as { message: ChatMessage };
      assert.equal(postedBody.message.role, "user");
      assert.equal(postedBody.message.origin, "human");

      await waitFor(() =>
        daemon.chatStore.getAllMessages().some((m) => m.text.includes("还没连通，卡在没有外部回执"))
      );

      const injected = daemon.chatStore
        .getAllMessages()
        .find((m) => m.text.includes("【来自 Grok Bot 的测试】"));
      assert.ok(injected, "expected the self-test to be stored");
      assert.equal(injected.role, "system");
      assert.equal(injected.origin, "subagent");
      assert.equal(injected.actor, "grok-test");
      assert.equal(
        daemon.chatStore.getAllMessages().some((m) => m.role === "user" && m.text.includes("来自 Grok Bot")),
        false
      );
      assert.equal(
        daemon.chatStore.getAllMessages().some((m) => m.text.includes("双向连通成功")),
        false
      );

      for (const message of daemon.chatStore.getAllMessages()) {
        if (message.origin === "human") continue;
        assert.ok(Array.from(message.text).length <= 100, message.text);
        assert.doesNotMatch(message.text, /(^\s*\|)|(\*\*)|(^#{1,6}\s)/m);
      }

      seenUserContents.length = 0;
      await daemon.chatStore.appendMessage({ role: "user", origin: "human", text: "通了吗" });
      daemon.coordinator.notifyUserMessage();
      await waitFor(() => seenUserContents.length > 0);

      const bareInjection = seenUserContents.find(
        (content) => content.trim() === "【来自 Grok Bot 的测试】收到了你的消息"
      );
      assert.equal(bareInjection, undefined);
      assert.ok(
        seenUserContents.some((content) => content.includes("[非用户记录") && content.includes("来自 Grok Bot"))
      );
    } finally {
      await daemon.stop();
      mockServer.closeAllConnections();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});

test("extension self-test and markdown table cannot be delivered as success", async () => {
  await withTempDir(async (dir) => {
    const prevPort = process.env.PORT;
    process.env.PORT = "0";
    const daemon = await createAcrowlyDaemon(dir);
    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content?: string | null }>;
        };
        const last = body.messages[body.messages.length - 1];
        const lastText = String(last?.content ?? "");
        let reply: unknown;
        if (lastText.includes("BLOCKED_UNVERIFIED")) {
          reply = { choices: [{ message: { content: "还没连通，卡在扩展只做了本机自测。" } }] };
        } else if (last?.role === "tool") {
          reply = {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "claim_ext",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "桥已连通，对方已经收到。" }),
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
                  content: null,
                  tool_calls: [
                    {
                      id: "ack_ext",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "先看扩展自测，不把它当连通。" }),
                      },
                    },
                    {
                      id: "call_ext",
                      type: "function",
                      function: { name: "ext_inject_probe", arguments: "{}" },
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
    const llmPort = (mockServer.address() as { port: number }).port;

    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-test",
        model: "gpt-4.1",
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      });
      await fs.mkdir(daemon.configStore.paths.extensionsDir, { recursive: true });
      await fs.writeFile(
        path.join(daemon.configStore.paths.extensionsDir, "inject-probe.mjs"),
        `export default {
  name: "inject_probe",
  description: "Simulate an inbound bridge message",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    await ctx.sendMessage("| 项 | 状态 |\\n| --- | --- |\\n| 桥 | 已连通 |\\n" + "补充".repeat(80));
    const res = await fetch(process.env.ACROWLY_LOCAL_ORIGIN + "/api/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "【来自 Grok Bot 的测试】收到了你的消息" }),
    });
    return await res.text();
  }
};
`,
        "utf8"
      );
      await daemon.extensionLoader.reload();
      await daemon.start();

      await daemon.chatStore.appendMessage({
        role: "user",
        origin: "human",
        text: "把微信和 Grok 桥接上",
      });
      daemon.coordinator.notifyUserMessage();

      await waitFor(() =>
        daemon.chatStore.getAllMessages().some((m) => m.text.includes("卡在扩展只做了本机自测"))
      );

      const injected = daemon.chatStore
        .getAllMessages()
        .find((m) => m.text.includes("【来自 Grok Bot 的测试】"));
      assert.ok(injected);
      assert.equal(injected.role, "system");
      assert.equal(injected.origin, "extension");
      assert.equal(
        daemon.chatStore.getAllMessages().filter((m) => m.role === "user" && m.text.includes("来自 Grok")).length,
        0
      );
      assert.equal(
        daemon.chatStore.getAllMessages().some((m) => m.text.includes("桥已连通")),
        false
      );
      assert.equal(
        daemon.chatStore.getAllMessages().some((m) => m.text.includes("| 项 |")),
        false
      );
      const extensionNote = daemon.chatStore
        .getAllMessages()
        .find((m) => m.origin === "extension");
      assert.ok(extensionNote);
      assert.equal(extensionNote.text, UNVERIFIED_FALLBACK);
      assert.ok(Array.from(extensionNote.text).length <= 100);
    } finally {
      await daemon.stop();
      mockServer.closeAllConnections();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});

test("subagent step limit is reported as unfinished, not success", async () => {
  await withTempDir(async (dir) => {
    const prevPort = process.env.PORT;
    process.env.PORT = "0";
    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content?: string | null }>;
        };
        const sys = String(body.messages[0]?.content ?? "");
        const last = body.messages[body.messages.length - 1];
        const lastText = String(last?.content ?? "");
        let reply: unknown;
        if (sys.includes("执行型子代理")) {
          reply = {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "list_1",
                      type: "function",
                      function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
                    },
                  ],
                },
              },
            ],
          };
        } else if (lastText.includes("BLOCKED_UNVERIFIED")) {
          reply = { choices: [{ message: { content: "子代理到步数上限，登录没完成。" } }] };
        } else if (last?.role === "tool") {
          reply = {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "done_claim",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "搞定了，登录已经完成。" }),
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
                  content: null,
                  tool_calls: [
                    {
                      id: "ack_limit",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "我先派子代理扫码，扫完才算登录。" }),
                      },
                    },
                    {
                      id: "sub_limit",
                      type: "function",
                      function: {
                        name: "dispatch_subagent",
                        arguments: JSON.stringify({
                          label: "wechat-qr",
                          task: "等待扫码登录",
                          maxSteps: 1,
                        }),
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
    const llmPort = (mockServer.address() as { port: number }).port;
    const daemon = await createAcrowlyDaemon(dir);
    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-test",
        model: "gpt-4.1",
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      });
      await daemon.start();
      await daemon.chatStore.appendMessage({ role: "user", origin: "human", text: "马上给我微信登录二维码" });
      daemon.coordinator.notifyUserMessage();
      await waitFor(() =>
        daemon.chatStore.getAllMessages().some((m) => m.text.includes("登录没完成"))
      );
      const status = daemon.chatStore.getAllMessages().find((m) => m.text.includes("步数上限"));
      assert.ok(status);
      assert.equal(status.role, "system");
      assert.match(status.text, /wechat-qr/);
      assert.match(status.text, /没完成/);
      assert.equal(
        daemon.chatStore.getAllMessages().some((m) => m.text.includes("搞定了")),
        false
      );
    } finally {
      await daemon.stop();
      mockServer.closeAllConnections();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});

test("tracked background job expiry is told to the user", async () => {
  await withTempDir(async (dir) => {
    const prevPort = process.env.PORT;
    process.env.PORT = "0";
    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content?: string | null }>;
        };
        const sys = String(body.messages[0]?.content ?? "");
        const last = body.messages[body.messages.length - 1];
        let reply: unknown;
        if (sys.includes("执行型子代理")) {
          if (last?.role === "user") {
            reply = {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "bg_1",
                        type: "function",
                        function: {
                          name: "run_shell",
                          arguments: JSON.stringify({ command: "sleep 30 &", timeoutMs: 400 }),
                        },
                      },
                    ],
                  },
                },
              ],
            };
          } else {
            reply = { choices: [{ message: { content: "后台已跟踪，到时限前都还没完成。" } }] };
          }
        } else if (last?.role === "tool") {
          reply = { choices: [{ message: { content: "后台在跑，还没连通，到时限会直接告诉你。" } }] };
        } else {
          reply = {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "ack_bg",
                      type: "function",
                      function: {
                        name: "send_chat_message",
                        arguments: JSON.stringify({ text: "我挂一个有时限的等待，结束会告诉你。" }),
                      },
                    },
                    {
                      id: "sub_bg",
                      type: "function",
                      function: {
                        name: "dispatch_subagent",
                        arguments: JSON.stringify({ label: "qr-wait", task: "后台等待扫码" }),
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
    const llmPort = (mockServer.address() as { port: number }).port;
    const daemon = await createAcrowlyDaemon(dir);
    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-test",
        model: "gpt-4.1",
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      });
      await daemon.start();
      await daemon.chatStore.appendMessage({ role: "user", origin: "human", text: "二维码保持 30 分钟，过期要告诉我" });
      daemon.coordinator.notifyUserMessage();
      await waitFor(
        () => daemon.chatStore.getAllMessages().some((m) => m.text.includes("到时限结束")),
        5000
      );
      const notice = daemon.chatStore.getAllMessages().find((m) => m.text.includes("到时限结束"));
      assert.ok(notice);
      assert.equal(notice.role, "system");
      assert.match(notice.text, /qr-wait/);
      assert.match(notice.text, /没有外部回执/);
      assert.equal(
        daemon.chatStore.getAllMessages().some((m) => /已连通|桥已/.test(m.text)),
        false
      );
    } finally {
      await daemon.stop();
      mockServer.closeAllConnections();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});
