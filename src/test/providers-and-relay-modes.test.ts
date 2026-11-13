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

test("Relay supports X-Acrowly-Device header routing and binary file uploads + video rejection over tunnel", async () => {
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

      // Video upload over tunnel rejected with 415
      const vidRes = await fetch(`${relayBase}/api/files`, {
        method: "POST",
        headers: {
          "X-Acrowly-Device": "iphone-node",
          Authorization: `Bearer ${sessionToken}`,
          "X-Filename": "movie.mp4",
          "Content-Type": "video/mp4",
        },
        body: Buffer.from("fake-video"),
      });
      assert.equal(vidRes.status, 415);
    } finally {
      await daemon.stop();
      await relay.stop();
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});
