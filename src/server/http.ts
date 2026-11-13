import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { CoordinatorEngine } from "../agent/coordinator.js";
import type { ConfigStore } from "../config/store.js";
import {
  AttachmentStore,
  parseMultipartFormData,
} from "../storage/attachment-store.js";
import type { ChatStore } from "../storage/chat-store.js";
import type { StoredFileMeta } from "../types.js";
import {
  AuthChallengeStore,
  AuthRateLimiter,
  SESSION_COOKIE_NAME,
  checkRequestAuth,
  isLoopbackAddress,
} from "./auth.js";

const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

interface UploadedFileResponse {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  url: string;
  markdown: string;
}

function toUploadedFileResponse(
  saved: StoredFileMeta & { url: string; markdown: string }
): UploadedFileResponse {
  return {
    id: saved.id,
    kind: saved.kind,
    name: saved.name,
    mime: saved.mime,
    size: saved.size,
    url: saved.url,
    markdown: saved.markdown,
  };
}

function parseByteRange(
  rangeHeader: string,
  totalLength: number
): { start: number; end: number } | "invalid" | undefined {
  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bytes=")) return undefined;
  const spec = trimmed.slice("bytes=".length).trim();
  if (!spec || spec.includes(",")) return undefined;

  const dashIdx = spec.indexOf("-");
  if (dashIdx === -1) return "invalid";
  const startStr = spec.slice(0, dashIdx).trim();
  const endStr = spec.slice(dashIdx + 1).trim();

  if (totalLength <= 0) return "invalid";

  let start: number;
  let end: number;
  if (!startStr) {
    const suffix = Number(endStr);
    if (!Number.isInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, totalLength - suffix);
    end = totalLength - 1;
  } else {
    start = Number(startStr);
    if (!Number.isInteger(start) || start < 0) return "invalid";
    if (!endStr) {
      end = totalLength - 1;
    } else {
      end = Number(endStr);
      if (!Number.isInteger(end) || end < 0) return "invalid";
      end = Math.min(end, totalLength - 1);
    }
  }

  if (start > end || start >= totalLength) return "invalid";
  return { start, end };
}

export interface HttpResponseSink {
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: Buffer | string) => void;
  end: (chunk?: Buffer | string) => void;
  onClose: (cb: () => void) => void;
}

export interface NormalizedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  isRemote: boolean;
  clientIp: string;
}

const NO_WEBUI_PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Acrowly</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 14vh auto; padding: 0 20px; color: #18181b; line-height: 1.65; }
    code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 0.92em; }
  </style>
</head>
<body>
  <h3>Acrowly 无头核心运行中</h3>
  <p>纯聊天后端已就绪，本地 WebUI 尚未生成。</p>
  <p>请在终端里直接跟协调器说一声（例如：“帮我写一个本地 WebUI”），它会派子代理把前端写进 <code>webui/index.html</code>，写完刷新此页即可开聊。</p>
</body>
</html>`;

export class AcrowlyHttpServer {
  private server: http.Server | undefined;
  private challenges = new AuthChallengeStore();
  private rateLimiter = new AuthRateLimiter();

  constructor(
    private readonly deps: {
      configStore: ConfigStore;
      chatStore: ChatStore;
      attachmentStore: AttachmentStore;
      coordinator: CoordinatorEngine;
      getRelayConnected?: () => boolean;
    }
  ) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      const addr = this.server.address();
      if (addr && typeof addr !== "string") {
        return { host: addr.address, port: addr.port };
      }
    }

    const { host, port } = this.deps.configStore.getConfig().server;
    this.server = http.createServer((req, res) => {
      void this.handleNodeHttp(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    const addr = this.server.address();
    const actualPort = addr && typeof addr !== "string" ? addr.port : port;
    return { host, port: actualPort };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = undefined;
    const closePromise = new Promise<void>((resolve) => srv.close(() => resolve()));
    srv.closeAllConnections?.();
    await closePromise;
  }

  async dispatchTunneledRequest(req: NormalizedRequest, sink: HttpResponseSink): Promise<void> {
    await this.handleRequest(req, sink);
  }

  private async handleNodeHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let total = 0;
    const rawUrl = req.url ?? "";
    const reqContentType = String(req.headers["content-type"] ?? "").toLowerCase();
    const isUpload =
      rawUrl.startsWith("/api/files") ||
      (rawUrl.startsWith("/api/chat/messages") && reqContentType.includes("multipart/form-data"));
    const maxBytes = isUpload ? MAX_UPLOAD_BYTES : MAX_JSON_BYTES;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= maxBytes) {
        chunks.push(chunk);
      }
    });

    req.on("end", async () => {
      if (total > maxBytes) {
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }

      const remoteAddr = req.socket.remoteAddress;
      const hasProxyHeaders = Boolean(
        req.headers["x-forwarded-for"] || req.headers["x-real-ip"]
      );
      const isRemote = !isLoopbackAddress(remoteAddr) || hasProxyHeaders;

      const sink: HttpResponseSink = {
        writeHead: (status, headers) => {
          if (!res.headersSent) {
            res.writeHead(status, headers);
          }
        },
        write: (chunk) => {
          if (!res.writableEnded) {
            res.write(chunk);
          }
        },
        end: (chunk) => {
          if (!res.writableEnded) {
            res.end(chunk);
          }
        },
        onClose: (cb) => {
          res.once("close", cb);
        },
      };

      const xff = req.headers["x-forwarded-for"];
      const forwardedIp = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      const clientIp = forwardedIp || remoteAddr || "unknown";

      await this.handleRequest(
        {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body: Buffer.concat(chunks),
          isRemote,
          clientIp,
        },
        sink
      );
    });
  }

  private async handleRequest(req: NormalizedRequest, sink: HttpResponseSink): Promise<void> {
    const parsedUrl = new URL(req.url, "http://localhost");
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // Handle CORS preflight cleanly for custom frontends / iOS dev tools
    if (method === "OPTIONS") {
      sink.writeHead(204, this.corsHeaders(req.headers));
      sink.end();
      return;
    }

    if (pathname === "/api/health") {
      this.sendJson(sink, 200, { ok: true }, req.headers);
      return;
    }

    if (pathname === "/api/auth/status" && method === "GET") {
      const config = this.deps.configStore.getConfig();
      const auth = checkRequestAuth(req.headers, req.isRemote, this.deps.configStore);
      this.sendJson(
        sink,
        200,
        {
          authenticated: auth.authenticated,
          authConfigured: config.auth.authorizedKeys.length > 0,
          authorizedKeyCount: config.auth.authorizedKeys.length,
          deviceId: config.relay.deviceId,
          relayConnected: this.deps.getRelayConnected ? this.deps.getRelayConnected() : false,
        },
        req.headers
      );
      return;
    }

    if (pathname === "/api/auth/challenge" && method === "POST") {
      const limitCheck = this.rateLimiter.checkAllowed(req.clientIp);
      if (!limitCheck.allowed) {
        sink.writeHead(429, {
          ...this.corsHeaders(req.headers),
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(limitCheck.retryAfterSec ?? 60),
        });
        sink.end(JSON.stringify({ error: "Too many authentication attempts. Try again later." }));
        return;
      }

      let payload: { fingerprint?: string; publicKey?: string };
      try {
        payload = JSON.parse(req.body.toString("utf8") || "{}") as {
          fingerprint?: string;
          publicKey?: string;
        };
      } catch {
        this.sendJson(sink, 400, { error: "Invalid JSON body" }, req.headers);
        return;
      }

      if (!payload.fingerprint && !payload.publicKey) {
        this.sendJson(sink, 400, { error: "fingerprint or publicKey is required" }, req.headers);
        return;
      }

      const key = this.deps.configStore.findAuthorizedKey(payload);
      if (!key) {
        this.rateLimiter.recordFailure(req.clientIp);
        this.sendJson(sink, 401, { error: "Unknown or unauthorized Ed25519 public key" }, req.headers);
        return;
      }

      const config = this.deps.configStore.getConfig();
      const challenge = this.challenges.createChallenge(key, config.relay.deviceId);
      this.sendJson(sink, 200, challenge, req.headers);
      return;
    }

    if (pathname === "/api/auth/verify" && method === "POST") {
      const limitCheck = this.rateLimiter.checkAllowed(req.clientIp);
      if (!limitCheck.allowed) {
        sink.writeHead(429, {
          ...this.corsHeaders(req.headers),
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(limitCheck.retryAfterSec ?? 60),
        });
        sink.end(JSON.stringify({ error: "Too many authentication attempts. Try again later." }));
        return;
      }

      let payload: { challengeId?: string; signature?: string };
      try {
        payload = JSON.parse(req.body.toString("utf8") || "{}") as {
          challengeId?: string;
          signature?: string;
        };
      } catch {
        this.sendJson(sink, 400, { error: "Invalid JSON body" }, req.headers);
        return;
      }

      if (!payload.challengeId || !payload.signature) {
        this.sendJson(sink, 400, { error: "challengeId and signature are required" }, req.headers);
        return;
      }

      const verified = this.challenges.consumeAndVerify(
        payload.challengeId,
        payload.signature,
        this.deps.configStore
      );
      if (!verified.ok) {
        this.rateLimiter.recordFailure(req.clientIp);
        this.sendJson(sink, 401, { error: verified.reason }, req.headers);
        return;
      }

      this.rateLimiter.recordSuccess(req.clientIp);
      await this.deps.configStore.touchAuthorizedKeyLastUsed(verified.keyId);

      const protoHeader = req.headers["x-forwarded-proto"];
      const isHttps =
        (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) === "https";
      const cookieFlags = [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(verified.sessionToken)}`,
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        `Max-Age=${30 * 24 * 3600}`,
        ...(isHttps ? ["Secure"] : []),
      ].join("; ");

      sink.writeHead(200, {
        ...this.corsHeaders(req.headers),
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": cookieFlags,
      });
      sink.end(
        JSON.stringify({
          ok: true,
          token: verified.sessionToken,
          keyId: verified.keyId,
          label: verified.label,
          fingerprint: verified.fingerprint,
        })
      );
      return;
    }

    // All /api/chat/* and /api/files/* routes enforce auth
    if (pathname.startsWith("/api/")) {
      const auth = checkRequestAuth(req.headers, req.isRemote, this.deps.configStore);
      if (!auth.authenticated) {
        const status = auth.reason === "remote_requires_authorized_key_setup" ? 403 : 401;
        this.sendJson(sink, status, { error: auth.reason ?? "Unauthorized" }, req.headers);
        return;
      }

      if (pathname === "/api/chat/messages" && method === "GET") {
        const afterSeqParam = parsedUrl.searchParams.get("after_seq");
        const beforeSeqParam = parsedUrl.searchParams.get("before_seq");
        const limitParam = parsedUrl.searchParams.get("limit");

        const result = this.deps.chatStore.getMessages({
          afterSeq: afterSeqParam !== null ? Number(afterSeqParam) : undefined,
          beforeSeq: beforeSeqParam !== null ? Number(beforeSeqParam) : undefined,
          limit: limitParam !== null ? Number(limitParam) : undefined,
        });

        this.sendJson(
          sink,
          200,
          {
            messages: result.messages.map((m) => ({
              seq: m.seq,
              id: m.id,
              role: m.role,
              text: m.text,
              createdAt: m.createdAt,
            })),
            latestSeq: result.latestSeq,
          },
          req.headers
        );
        return;
      }

      if (pathname === "/api/chat/messages" && method === "POST") {
        const ctRaw = req.headers["content-type"];
        const contentType = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) ?? "";

        let rawText = "";
        let clientMsgId: string | undefined;
        const savedAttachments: UploadedFileResponse[] = [];

        if (contentType.toLowerCase().includes("multipart/form-data")) {
          const parsed = parseMultipartFormData(req.body, contentType);
          if (!parsed) {
            this.sendJson(sink, 400, { error: "Invalid multipart/form-data body" }, req.headers);
            return;
          }
          rawText = (parsed.fields.text ?? "").trim();
          const rawClientMsgId = (parsed.fields.clientMsgId ?? "").trim();
          if (rawClientMsgId) clientMsgId = rawClientMsgId;

          if (!rawText && parsed.files.length === 0) {
            this.sendJson(
              sink,
              400,
              { error: "Message text or uploaded files must not be empty" },
              req.headers
            );
            return;
          }

          for (const file of parsed.files) {
            const saved = await this.deps.attachmentStore.saveUpload({
              filename: file.filename,
              declaredMime: file.mime,
              data: file.data,
            });
            savedAttachments.push(toUploadedFileResponse(saved));
          }
        } else {
          let body: { text?: string; clientMsgId?: string };
          try {
            body = JSON.parse(req.body.toString("utf8") || "{}") as {
              text?: string;
              clientMsgId?: string;
            };
          } catch {
            this.sendJson(sink, 400, { error: "Invalid JSON body" }, req.headers);
            return;
          }

          rawText = typeof body.text === "string" ? body.text.trim() : "";
          clientMsgId = typeof body.clientMsgId === "string" ? body.clientMsgId : undefined;
          if (!rawText) {
            this.sendJson(sink, 400, { error: "Message text must not be empty" }, req.headers);
            return;
          }
        }

        const textParts: string[] = [];
        if (rawText) textParts.push(rawText);
        if (savedAttachments.length > 0) {
          textParts.push(savedAttachments.map((a) => a.markdown).join("\n"));
        }
        const combinedText = textParts.join("\n");

        const { message, duplicate } = await this.deps.chatStore.appendMessage({
          role: "user",
          text: combinedText,
          clientMsgId,
        });

        if (!duplicate) {
          this.deps.coordinator.notifyUserMessage();
        }

        this.sendJson(
          sink,
          duplicate ? 200 : 202,
          {
            message: {
              seq: message.seq,
              id: message.id,
              role: message.role,
              text: message.text,
              createdAt: message.createdAt,
            },
            duplicate,
            ...(savedAttachments.length > 0 ? { attachments: savedAttachments } : {}),
          },
          req.headers
        );
        return;
      }

      if (pathname === "/api/chat/stream" && method === "GET") {
        const lastEventIdRaw = req.headers["last-event-id"];
        const lastEventId = Array.isArray(lastEventIdRaw) ? lastEventIdRaw[0] : lastEventIdRaw;
        const afterSeqParam = parsedUrl.searchParams.get("after_seq");
        const startSeq =
          afterSeqParam !== null
            ? Number(afterSeqParam) || 0
            : lastEventId
              ? Number(lastEventId) || 0
              : 0;

        sink.writeHead(200, {
          ...this.corsHeaders(req.headers),
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        // Flush headers immediately so fetch() resolves before any message/ping arrives.
        sink.write(": connected\n\n");

        let lastSentSeq = startSeq;
        const sendSseMessage = (msg: {
          seq: number;
          id: string;
          role: "user" | "assistant";
          text: string;
          createdAt: string;
        }) => {
          if (msg.seq <= lastSentSeq) return;
          lastSentSeq = msg.seq;
          const payload = JSON.stringify({
            seq: msg.seq,
            id: msg.id,
            role: msg.role,
            text: msg.text,
            createdAt: msg.createdAt,
          });
          sink.write(`id: ${msg.seq}\nevent: message\ndata: ${payload}\n\n`);
        };

        // Replay missed messages first
        const missed = this.deps.chatStore.getMessages({ afterSeq: startSeq, limit: 200 });
        for (const msg of missed.messages) {
          sendSseMessage(msg);
        }

        const unsubscribe = this.deps.chatStore.subscribe((msg) => {
          sendSseMessage(msg);
        });

        const pingTimer = setInterval(() => {
          sink.write(": ping\n\n");
        }, 20_000);

        sink.onClose(() => {
          clearInterval(pingTimer);
          unsubscribe();
        });
        return;
      }

      if (pathname === "/api/files" && method === "POST") {
        const ctRaw = req.headers["content-type"];
        const contentType = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) ?? "";

        if (contentType.toLowerCase().includes("multipart/form-data")) {
          const parsed = parseMultipartFormData(req.body, contentType);
          if (!parsed || parsed.files.length === 0) {
            this.sendJson(sink, 400, { error: "Missing multipart file field" }, req.headers);
            return;
          }

          const uploaded: UploadedFileResponse[] = [];
          for (const file of parsed.files) {
            const saved = await this.deps.attachmentStore.saveUpload({
              filename: file.filename,
              declaredMime: file.mime,
              data: file.data,
            });
            uploaded.push(toUploadedFileResponse(saved));
          }

          this.sendJson(
            sink,
            201,
            uploaded.length === 1 ? uploaded[0] : { ...uploaded[0], files: uploaded },
            req.headers
          );
          return;
        }

        let filename = "upload.bin";
        const xNameRaw = req.headers["x-filename"];
        const xName = Array.isArray(xNameRaw) ? xNameRaw[0] : xNameRaw;
        if (xName) {
          try {
            filename = decodeURIComponent(xName);
          } catch {
            filename = xName;
          }
        }

        const saved = await this.deps.attachmentStore.saveUpload({
          filename,
          declaredMime: contentType,
          data: req.body,
        });
        this.sendJson(sink, 201, toUploadedFileResponse(saved), req.headers);
        return;
      }

      if (pathname.startsWith("/api/files/") && method === "GET") {
        const rest = pathname.slice("/api/files/".length);
        const [fileId] = rest.split("/");
        if (!fileId) {
          this.sendJson(sink, 404, { error: "File not found" }, req.headers);
          return;
        }

        const loaded = await this.deps.attachmentStore.readFileBuffer(fileId);
        if (!loaded) {
          this.sendJson(sink, 404, { error: "File not found" }, req.headers);
          return;
        }

        const forceDownload = parsedUrl.searchParams.get("download") === "1";
        const isInlineMedia =
          loaded.meta.kind === "image" ||
          loaded.meta.mime.startsWith("video/") ||
          loaded.meta.mime.startsWith("audio/");
        const disposition = forceDownload || !isInlineMedia ? "attachment" : "inline";
        const encoded = encodeURIComponent(loaded.meta.name);
        const totalLength = loaded.data.length;

        const baseHeaders: Record<string, string> = {
          ...this.corsHeaders(req.headers),
          "Content-Type": loaded.meta.mime,
          "Accept-Ranges": "bytes",
          "Content-Disposition": `${disposition}; filename*=UTF-8''${encoded}`,
          "Cache-Control": "private, max-age=86400",
        };

        const rangeRaw = req.headers.range;
        const rangeHeader = Array.isArray(rangeRaw) ? rangeRaw[0] : rangeRaw;
        if (rangeHeader) {
          const parsedRange = parseByteRange(rangeHeader, totalLength);
          if (parsedRange === "invalid") {
            sink.writeHead(416, {
              ...baseHeaders,
              "Content-Range": `bytes */${totalLength}`,
              "Content-Length": "0",
            });
            sink.end();
            return;
          }
          if (parsedRange) {
            const slice = loaded.data.subarray(parsedRange.start, parsedRange.end + 1);
            sink.writeHead(206, {
              ...baseHeaders,
              "Content-Range": `bytes ${parsedRange.start}-${parsedRange.end}/${totalLength}`,
              "Content-Length": String(slice.length),
            });
            sink.end(slice);
            return;
          }
        }

        sink.writeHead(200, {
          ...baseHeaders,
          "Content-Length": String(totalLength),
        });
        sink.end(loaded.data);
        return;
      }

      this.sendJson(sink, 404, { error: "API route not found" }, req.headers);
      return;
    }

    // Serve hot-mounted custom WebUI from ./webui/
    if (method === "GET" || method === "HEAD") {
      await this.serveWebui(pathname, method === "HEAD", sink);
      return;
    }

    this.sendJson(sink, 405, { error: "Method not allowed" }, req.headers);
  }

  private async serveWebui(
    pathname: string,
    headOnly: boolean,
    sink: HttpResponseSink
  ): Promise<void> {
    const webuiRoot = path.resolve(this.deps.configStore.paths.webuiDir);
    const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const resolved = path.resolve(webuiRoot, relPath);

    // Prevent path traversal
    if (resolved !== webuiRoot && !resolved.startsWith(`${webuiRoot}${path.sep}`)) {
      sink.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      sink.end("Forbidden");
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      const filePath = stat.isDirectory() ? path.join(resolved, "index.html") : resolved;
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      sink.writeHead(200, {
        "Content-Type": STATIC_MIME_TYPES[ext] ?? "application/octet-stream",
        "Content-Length": String(data.length),
        "Cache-Control": "no-cache",
      });
      sink.end(headOnly ? undefined : data);
      return;
    } catch {
      if (pathname === "/" || pathname === "/index.html") {
        const html = Buffer.from(NO_WEBUI_PLACEHOLDER_HTML, "utf8");
        sink.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(html.length),
          "Cache-Control": "no-cache",
        });
        sink.end(headOnly ? undefined : html);
        return;
      }
      sink.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      sink.end("Not Found");
    }
  }

  private corsHeaders(reqHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
    const originRaw = reqHeaders.origin;
    const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
    if (!origin) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Filename,Last-Event-ID,X-Acrowly-Device",
    };
  }

  private sendJson(
    sink: HttpResponseSink,
    status: number,
    data: unknown,
    reqHeaders: Record<string, string | string[] | undefined>
  ): void {
    const body = Buffer.from(JSON.stringify(data), "utf8");
    sink.writeHead(status, {
      ...this.corsHeaders(reqHeaders),
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.length),
    });
    sink.end(body);
  }
}
