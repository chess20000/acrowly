import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, getDefaultModelForProvider, resolveRuntimePaths } from "../config/store.js";
import { SnapshotManager } from "../extensions/snapshot.js";
import { createAcrowlyDaemon } from "../runtime.js";
import {
  generateEd25519KeyPair,
  parseEd25519PublicKey,
  signWithEd25519PrivateKey,
} from "../server/ed25519.js";
import { AttachmentStore } from "../storage/attachment-store.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acrowly-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("AttachmentStore accepts arbitrary file types (images, TypeScript source, PDFs, videos, MPEG-TS)", async () => {
  await withTempDir(async (dir) => {
    const store = new AttachmentStore(path.join(dir, "files"));
    await store.init();

    // Valid PNG image
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const savedImg = await store.saveUpload({
      filename: "shot.png",
      declaredMime: "image/png",
      data: pngHeader,
    });
    assert.equal(savedImg.kind, "image");
    assert.match(savedImg.markdown, /^!\[shot\.png\]\(\/api\/files\/file_/);

    // Valid HEIC image (ftypheic must NOT be mistaken for MP4 video)
    const heicBuf = Buffer.from("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00", "latin1");
    const savedHeic = await store.saveUpload({
      filename: "photo.heic",
      declaredMime: "image/heic",
      data: heicBuf,
    });
    assert.equal(savedHeic.kind, "image");

    // TypeScript source file (.ts text) vs binary MPEG-TS stream (.ts binary)
    const savedTs = await store.saveUpload({
      filename: "helper.ts",
      declaredMime: "application/octet-stream",
      data: Buffer.from("export const x = 1;\n", "utf8"),
    });
    assert.equal(savedTs.kind, "file");
    assert.equal(savedTs.mime, "text/plain; charset=utf-8");

    const tsBinary = Buffer.alloc(400, 0);
    tsBinary[0] = 0x47;
    tsBinary[188] = 0x47;
    tsBinary[376] = 0x47;
    const savedMpegTs = await store.saveUpload({
      filename: "stream.ts",
      declaredMime: "application/octet-stream",
      data: tsBinary,
    });
    assert.equal(savedMpegTs.kind, "file");
    assert.equal(savedMpegTs.mime, "video/mp2t");

    // Video MIME & container extensions now accepted cleanly
    const savedMp4 = await store.saveUpload({
      filename: "clip.mp4",
      declaredMime: "video/mp4",
      data: Buffer.from("fake-mp4-data"),
    });
    assert.equal(savedMp4.kind, "file");
    assert.equal(savedMp4.mime, "video/mp4");
    assert.match(savedMp4.markdown, /^\[clip\.mp4\]\(\/api\/files\//);

    const savedMov = await store.saveUpload({
      filename: "clip.mov",
      declaredMime: "application/octet-stream",
      data: Buffer.from("fake-mov-data"),
    });
    assert.equal(savedMov.kind, "file");
    assert.equal(savedMov.mime, "video/quicktime");

    // Unknown extension binary fallback also saves cleanly without error
    const binSaved = await store.saveUpload({
      filename: "archive.bin",
      declaredMime: "application/octet-stream",
      data: Buffer.from([0x00, 0x01, 0x02, 0x03]),
    });
    assert.equal(binSaved.kind, "file");
    assert.equal(binSaved.mime, "application/octet-stream");
  });
});

test("Pure Chat HTTP API, SSE sync, file upload/download, auth, secret redaction, and hot WebUI serving", async () => {
  await withTempDir(async (dir) => {
    const prevPort = process.env.PORT;
    const prevData = process.env.ACROWLY_DATA_DIR;
    const prevWebui = process.env.ACROWLY_WEBUI_DIR;
    delete process.env.ACROWLY_DATA_DIR;
    delete process.env.ACROWLY_WEBUI_DIR;
    process.env.PORT = "0";

    const daemon = await createAcrowlyDaemon(dir);
    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-initial-dummy-key-123456",
        model: "gpt-4.1",
        baseUrl: "http://127.0.0.1:9/v1",
      });
      const addr = await daemon.start();
      const base = `http://${addr.host}:${addr.port}`;

      // 1. Placeholder WebUI served initially
      const placeholderRes = await fetch(`${base}/`);
      assert.equal(placeholderRes.status, 200);
      const placeholderHtml = await placeholderRes.text();
      assert.match(placeholderHtml, /Acrowly/);

      // 2. Write custom WebUI on disk -> served immediately without restart
      const webuiHtml = "<!doctype html><html><body><div id='chat'>Ready</div></body></html>";
      await fs.writeFile(path.join(dir, "webui", "index.html"), webuiHtml, "utf8");
      const liveUiRes = await fetch(`${base}/`);
      assert.equal(liveUiRes.status, 200);
      assert.equal(await liveUiRes.text(), webuiHtml);

      // 3. Upload arbitrary files via /api/files (images, videos, Range 206/416) and multipart /api/chat/messages
      const boundary = "----acrowlyBoundary123";
      const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      const multipartBody = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pic.png"\r\nContent-Type: image/png\r\n\r\n`
        ),
        imgBytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const uploadRes = await fetch(`${base}/api/files`, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: multipartBody,
      });
      assert.equal(uploadRes.status, 201);
      const uploaded = (await uploadRes.json()) as { id: string; url: string; markdown: string; kind: string };
      assert.equal(uploaded.kind, "image");
      assert.match(uploaded.markdown, /^!\[pic\.png\]\(\/api\/files\//);

      const getImgRes = await fetch(`${base}${uploaded.url}`);
      assert.equal(getImgRes.status, 200);
      assert.deepEqual(Buffer.from(await getImgRes.arrayBuffer()), imgBytes);

      const videoUploadRes = await fetch(`${base}/api/files`, {
        method: "POST",
        headers: {
          "Content-Type": "video/mp4",
          "X-Filename": "demo.mp4",
        },
        body: Buffer.from("0123456789"),
      });
      assert.equal(videoUploadRes.status, 201);
      const videoUploaded = (await videoUploadRes.json()) as { url: string; mime: string; kind: string };
      assert.equal(videoUploaded.kind, "file");
      assert.equal(videoUploaded.mime, "video/mp4");

      const range206Res = await fetch(`${base}${videoUploaded.url}`, {
        headers: { Range: "bytes=2-5" },
      });
      assert.equal(range206Res.status, 206);
      assert.equal(range206Res.headers.get("content-range"), "bytes 2-5/10");
      assert.match(range206Res.headers.get("content-disposition") ?? "", /^inline;/);
      assert.equal(await range206Res.text(), "2345");

      const range416Res = await fetch(`${base}${videoUploaded.url}`, {
        headers: { Range: "bytes=99-120" },
      });
      assert.equal(range416Res.status, 416);
      assert.equal(range416Res.headers.get("content-range"), "bytes */10");

      // Direct multipart /api/chat/messages with multiple files (video + RFC 5987 UTF-8 filename) and no text
      const chatBoundary = "----acrowlyChatMpBoundary";
      const chatMultipartBody = Buffer.concat([
        Buffer.from(
          `--${chatBoundary}\r\nContent-Disposition: form-data; name="files"; filename="clip.webm"\r\nContent-Type: video/webm\r\n\r\n` +
            `webm-payload` +
            `\r\n--${chatBoundary}\r\nContent-Disposition: form-data; name="files"; filename*=UTF-8''%E8%B5%84%E6%96%99.txt\r\nContent-Type: text/plain\r\n\r\n` +
            `hello file` +
            `\r\n--${chatBoundary}--\r\n`
        ),
      ]);
      const mpPostRes = await fetch(`${base}/api/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${chatBoundary}` },
        body: chatMultipartBody,
      });
      assert.equal(mpPostRes.status, 202);
      const mpPostJson = (await mpPostRes.json()) as {
        message: { text: string };
        attachments: Array<{ name: string; url: string; mime: string }>;
      };
      assert.equal(mpPostJson.attachments.length, 2);
      assert.equal(mpPostJson.attachments[0].name, "clip.webm");
      assert.equal(mpPostJson.attachments[1].name, "资料.txt");
      assert.match(mpPostJson.message.text, /\[clip\.webm\]\(\/api\/files\//);
      assert.match(mpPostJson.message.text, /\[资料\.txt\]\(\/api\/files\//);

      // Empty multipart /api/chat/messages rejected with 400
      const emptyMpBody = Buffer.from(
        `--${chatBoundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n   \r\n--${chatBoundary}--\r\n`
      );
      const emptyMpRes = await fetch(`${base}/api/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${chatBoundary}` },
        body: emptyMpBody,
      });
      assert.equal(emptyMpRes.status, 400);

      // 4. Idempotent message send + SSE stream verification
      // Stop coordinator loop from calling external OpenAI by only testing ChatStore/HTTP via direct append + POST check
      const clientMsgId = crypto.randomUUID();
      const post1 = await fetch(`${base}/api/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `看下这张图 ${uploaded.markdown}`, clientMsgId }),
      });
      assert.equal(post1.status, 202);
      const data1 = (await post1.json()) as { message: { seq: number; text: string }; duplicate: boolean };
      assert.equal(data1.duplicate, false);

      const postDup = await fetch(`${base}/api/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "should dedup", clientMsgId }),
      });
      assert.equal(postDup.status, 200);
      const dataDup = (await postDup.json()) as { message: { seq: number }; duplicate: boolean };
      assert.equal(dataDup.duplicate, true);
      assert.equal(dataDup.message.seq, data1.message.seq);

      // 5. Pure Ed25519 SSH-style authentication (no passwords / static tokens)
      const clientKey = generateEd25519KeyPair("iphone-dev");
      const unrecognized = generateEd25519KeyPair("stranger");

      // Parse both OpenSSH format & raw 32-byte Base64 format identically
      const parsedRaw = parseEd25519PublicKey(clientKey.rawPublicKeyBase64);
      assert.equal(parsedRaw.fingerprint, clientKey.fingerprint);

      await daemon.configStore.addAuthorizedPublicKey(clientKey.publicKeyOpenSsh, "iphone");
      const unauthRes = await fetch(`${base}/api/chat/messages`);
      assert.equal(unauthRes.status, 401);

      // Unknown key rejected on challenge
      const badChallenge = await fetch(`${base}/api/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: unrecognized.fingerprint }),
      });
      assert.equal(badChallenge.status, 401);

      // Valid key gets challenge -> wrong signature fails & consumes challenge
      const ch1Res = await fetch(`${base}/api/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: clientKey.rawPublicKeyBase64 }),
      });
      assert.equal(ch1Res.status, 200);
      const ch1 = (await ch1Res.json()) as { challengeId: string; message: string };

      const badSig = signWithEd25519PrivateKey(unrecognized.privateKeyPem, ch1.message);
      const badVerify = await fetch(`${base}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: ch1.challengeId, signature: badSig }),
      });
      assert.equal(badVerify.status, 401);

      // Replaying consumed challenge fails even with real private key
      const realSigForConsumed = signWithEd25519PrivateKey(clientKey.privateKeyPem, ch1.message);
      const replayVerify = await fetch(`${base}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: ch1.challengeId, signature: realSigForConsumed }),
      });
      assert.equal(replayVerify.status, 401);

      // Fresh challenge + valid signature succeeds and grants Bearer & Cookie access
      const ch2Res = await fetch(`${base}/api/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: clientKey.fingerprint }),
      });
      assert.equal(ch2Res.status, 200);
      const ch2 = (await ch2Res.json()) as { challengeId: string; message: string };
      const goodSig = signWithEd25519PrivateKey(clientKey.privateKeyPem, ch2.message);
      const verifyRes = await fetch(`${base}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: ch2.challengeId, signature: goodSig }),
      });
      assert.equal(verifyRes.status, 200);
      const verifyData = (await verifyRes.json()) as {
        ok: boolean;
        token: string;
        label: string;
        fingerprint: string;
      };
      assert.equal(verifyData.ok, true);
      assert.equal(verifyData.label, "iphone");
      assert.equal(verifyData.fingerprint, clientKey.fingerprint);
      assert.ok(verifyRes.headers.get("set-cookie")?.includes("acrowly_session="));

      const authRes = await fetch(`${base}/api/chat/messages`, {
        headers: { Authorization: `Bearer ${verifyData.token}` },
      });
      assert.equal(authRes.status, 200);

      // Live SSE stream with empty missed backlog must stay subscribed on GET requests
      // and flush headers immediately without waiting for the 20s heartbeat ping.
      const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 3000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const latestSeq = daemon.chatStore.getAllMessages().at(-1)?.seq ?? 0;
      const sseController = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const sseRes = await withTimeout(
          fetch(`${base}/api/chat/stream?after_seq=${latestSeq}`, {
            headers: { Authorization: `Bearer ${verifyData.token}` },
            signal: sseController.signal,
          }),
          "SSE initial headers",
        );
        assert.equal(sseRes.status, 200);
        reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";

        const readUntil = async (needle: string): Promise<void> => {
          while (!sseBuffer.includes(needle)) {
            const chunk = await withTimeout(reader!.read(), `SSE chunk ${JSON.stringify(needle)}`);
            if (chunk.done) {
              throw new Error(`SSE stream closed prematurely before ${JSON.stringify(needle)}`);
            }
            sseBuffer += decoder.decode(chunk.value, { stream: true });
          }
        };

        await readUntil(": connected");
        await daemon.chatStore.appendMessage({ role: "assistant", text: "live sse reply" });
        await readUntil("live sse reply");
      } finally {
        sseController.abort();
        await reader?.cancel().catch(() => {});
      }

      // Revoking key blocks subsequent challenges
      const removed = await daemon.configStore.removeAuthorizedPublicKey(clientKey.fingerprint);
      assert.equal(removed, true);
      const revokedChallenge = await fetch(`${base}/api/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: clientKey.fingerprint }),
      });
      assert.equal(revokedChallenge.status, 401);

      // Rate limiter locks out after excessive failed attempts
      let lockedStatus = 0;
      for (let i = 0; i < 15; i += 1) {
        const res = await fetch(`${base}/api/auth/challenge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fingerprint: unrecognized.fingerprint }),
        });
        lockedStatus = res.status;
        if (lockedStatus === 429) {
          assert.ok(res.headers.get("retry-after"));
          break;
        }
      }
      assert.equal(lockedStatus, 429);

      // Secret redaction check (for model API keys shared in chat)
      const secretKey = "sk-very-secret-test-key-9999";
      await daemon.chatStore.appendMessage({ role: "user", text: `请添加模型 key: ${secretKey}` });
      const redactedCount = await daemon.chatStore.redactSecretInHistory(secretKey);
      assert.equal(redactedCount, 1);
      const allText = daemon.chatStore.getAllMessages().map((m) => m.text).join("\n");
      assert.equal(allText.includes(secretKey), false);
      assert.equal(allText.includes("sk-v****9999"), true);
    } finally {
      await daemon.stop();
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
      if (prevData === undefined) delete process.env.ACROWLY_DATA_DIR;
      else process.env.ACROWLY_DATA_DIR = prevData;
      if (prevWebui === undefined) delete process.env.ACROWLY_WEBUI_DIR;
      else process.env.ACROWLY_WEBUI_DIR = prevWebui;
    }
  });
});

test("SnapshotManager backs up and restores webui and extensions cleanly", async () => {
  await withTempDir(async (dir) => {
    const paths = resolveRuntimePaths(dir);
    const configStore = new ConfigStore(paths);
    await configStore.init();

    const snaps = new SnapshotManager(paths.snapshotsDir, paths.webuiDir, paths.extensionsDir);
    await fs.writeFile(path.join(paths.webuiDir, "index.html"), "<h1>v1</h1>", "utf8");
    await fs.writeFile(path.join(paths.extensionsDir, "hello.mjs"), "export default {}", "utf8");

    const snap = await snaps.createSnapshot("before-edit");
    assert.equal(snap.filesCopied, 2);

    await fs.writeFile(path.join(paths.webuiDir, "index.html"), "<h1>broken</h1>", "utf8");
    await fs.rm(path.join(paths.extensionsDir, "hello.mjs"));

    await snaps.restoreSnapshot(snap.id);
    assert.equal(await fs.readFile(path.join(paths.webuiDir, "index.html"), "utf8"), "<h1>v1</h1>");
    assert.equal(await fs.readFile(path.join(paths.extensionsDir, "hello.mjs"), "utf8"), "export default {}");
  });
});

test("getDefaultModelForProvider returns deepseek-flash for deepseek", () => {
  assert.equal(getDefaultModelForProvider("deepseek"), "deepseek-flash");
});

test("Coordinator hydrates uploaded images and non-image attachment localPath metadata from multipart /api/chat/messages", async () => {
  await withTempDir(async (dir) => {
    const capturedMessages: Array<Array<{ role: string; content: unknown }>> = [];
    const mockLlm = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content: unknown }>;
        };
        capturedMessages.push(body.messages);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "已收到图片和视频附件路径" } }] }));
      });
    });

    await new Promise<void>((resolve) => mockLlm.listen(0, "127.0.0.1", resolve));
    const llmPort = (mockLlm.address() as { port: number }).port;

    const prevPort = process.env.PORT;
    process.env.PORT = "0";
    const daemon = await createAcrowlyDaemon(dir);

    try {
      await daemon.configStore.setBootstrapModel({
        provider: "openai",
        apiKey: "sk-dummy-coord",
        model: "gpt-4.1",
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      });
      const addr = await daemon.start();
      const base = `http://${addr.host}:${addr.port}`;

      const boundary = "----coordHydrationBoundary";
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n看下这些文件\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`
        ),
        pngBytes,
        Buffer.from(
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="sample.mp4"\r\nContent-Type: video/mp4\r\n\r\n` +
            `mp4-bytes` +
            `\r\n--${boundary}--\r\n`
        ),
      ]);

      const postRes = await fetch(`${base}/api/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      });
      assert.equal(postRes.status, 202);

      const deadline = Date.now() + 5000;
      while (capturedMessages.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(capturedMessages.length, 1);

      const userMsg = capturedMessages[0].find((m) => m.role === "user");
      assert.ok(userMsg && Array.isArray(userMsg.content));
      const parts = userMsg.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      const textPart = parts.find((p) => p.type === "text")?.text ?? "";
      const imagePart = parts.find((p) => p.type === "image_url")?.image_url?.url ?? "";

      assert.match(textPart, /\[附件元信息\]/);
      assert.match(textPart, /photo\.png \| kind=image \| mime=image\/png \| size=12 bytes \| localPath=/);
      assert.match(textPart, /sample\.mp4 \| kind=file \| mime=video\/mp4 \| size=9 bytes \| localPath=/);
      assert.match(imagePart, /^data:image\/png;base64,/);
    } finally {
      await daemon.stop();
      await new Promise<void>((resolve) => mockLlm.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});
