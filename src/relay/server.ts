import crypto from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { TunnelFrame } from "./protocol.js";

interface DeviceSession {
  deviceId: string;
  secretHash: string;
  ws: WebSocket;
  streams: Map<string, http.ServerResponse>;
}

const RELAY_LANDING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Acrowly Relay</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 14vh auto; padding: 0 20px; color: #18181b; line-height: 1.65; }
    code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h3>Acrowly 无状态中继站</h3>
  <p>此服务仅用于给无公网 IP 的本地 Acrowly 主机提供聊天与文件通道透传，不保存密钥、消息或文件。</p>
  <p>访问你的设备请使用 <code>/d/&lt;deviceId&gt;/</code> 或子域名 <code>&lt;deviceId&gt;.acrowly.com</code>。</p>
</body>
</html>`;

export class AcrowlyRelayServer {
  private httpServer: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private devices = new Map<string, DeviceSession>();
  private claimedSecrets = new Map<string, string>();
  private readonly baseDomain: string;

  constructor(
    private readonly options: {
      host?: string;
      port?: number;
      baseDomain?: string;
    } = {}
  ) {
    this.baseDomain = (options.baseDomain || process.env.ACROWLY_RELAY_DOMAIN || "acrowly.com").toLowerCase();
  }

  async start(): Promise<{ host: string; port: number }> {
    const host = this.options.host ?? process.env.HOST ?? "0.0.0.0";
    const port = this.options.port ?? (Number(process.env.PORT ?? 8788) || 8788);

    this.httpServer = http.createServer((req, res) => {
      this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/tunnel") {
        socket.destroy();
        return;
      }

      const deviceId = (url.searchParams.get("deviceId") ?? "").trim().toLowerCase();
      const secret = (url.searchParams.get("secret") ?? "").trim();
      if (!deviceId || !secret) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
      const claimed = this.claimedSecrets.get(deviceId);
      if (claimed && claimed !== secretHash) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.claimedSecrets.set(deviceId, secretHash);

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.registerDeviceTunnel(deviceId, secretHash, ws);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, host, () => {
        this.httpServer!.off("error", reject);
        resolve();
      });
    });

    const addr = this.httpServer.address();
    const actualPort = addr && typeof addr !== "string" ? addr.port : port;
    return { host, port: actualPort };
  }

  async stop(): Promise<void> {
    for (const dev of this.devices.values()) {
      for (const res of dev.streams.values()) {
        if (!res.writableEnded) res.end();
      }
      dev.ws.close();
    }
    this.devices.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = undefined;
    }
    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = undefined;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  private registerDeviceTunnel(deviceId: string, secretHash: string, ws: WebSocket): void {
    const existing = this.devices.get(deviceId);
    if (existing) {
      for (const res of existing.streams.values()) {
        if (!res.writableEnded) res.end();
      }
      existing.ws.close();
    }

    const session: DeviceSession = {
      deviceId,
      secretHash,
      ws,
      streams: new Map(),
    };
    this.devices.set(deviceId, session);

    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as TunnelFrame;
        this.handleTunnelFrame(session, frame);
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      if (this.devices.get(deviceId) !== session) return;
      this.devices.delete(deviceId);
      for (const res of session.streams.values()) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Device tunnel disconnected" }));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
      session.streams.clear();
    });
  }

  private handleTunnelFrame(session: DeviceSession, frame: TunnelFrame): void {
    if (frame.type === "ping") {
      this.sendFrame(session.ws, { type: "pong" });
      return;
    }
    if (frame.type === "pong") return;

    if (frame.type === "res_start") {
      const res = session.streams.get(frame.streamId);
      if (!res || res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(frame.status, frame.headers);
      }
      return;
    }

    if (frame.type === "res_body") {
      const res = session.streams.get(frame.streamId);
      if (!res || res.writableEnded) return;
      const chunk = Buffer.from(frame.chunkBase64, "base64");
      res.write(chunk);
      return;
    }

    if (frame.type === "res_end") {
      const res = session.streams.get(frame.streamId);
      if (!res) return;
      if (!res.writableEnded) {
        res.end();
      }
      session.streams.delete(frame.streamId);
    }
  }

  private resolveTarget(req: http.IncomingMessage): {
    deviceId?: string;
    forwardPath: string;
    redirectTo?: string;
  } {
    const rawUrl = req.url ?? "/";

    // 1. Path prefix: /d/<deviceId>/...
    const pathMatch = rawUrl.match(/^\/d\/([a-z0-9-_]+)(\/.*|\?.*)?$/i);
    if (pathMatch) {
      const deviceId = pathMatch[1].toLowerCase();
      const rest = pathMatch[2] ?? "";
      if (!rest || rest.startsWith("?")) {
        return {
          deviceId,
          forwardPath: "/",
          redirectTo: `/d/${deviceId}/${rest}`,
        };
      }
      return {
        deviceId,
        forwardPath: rest,
      };
    }

    // 2. Explicit header: X-Acrowly-Device
    const headerRaw = req.headers["x-acrowly-device"];
    const headerDevice = (Array.isArray(headerRaw) ? headerRaw[0] : headerRaw)?.trim().toLowerCase();
    if (headerDevice) {
      return { deviceId: headerDevice, forwardPath: rawUrl };
    }

    // 3. Subdomain: <deviceId>.acrowly.com
    const hostHeader = (req.headers.host ?? "").split(":")[0].toLowerCase();
    const suffix = `.${this.baseDomain}`;
    if (hostHeader.endsWith(suffix) && hostHeader.length > suffix.length) {
      const sub = hostHeader.slice(0, -suffix.length);
      if (sub && sub !== "www" && sub !== "api") {
        return { deviceId: sub, forwardPath: rawUrl };
      }
    }

    return { forwardPath: rawUrl };
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url ?? "/";
    if (rawUrl === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, connectedDevices: this.devices.size }));
      return;
    }

    const target = this.resolveTarget(req);
    if (target.redirectTo) {
      res.writeHead(302, { Location: target.redirectTo });
      res.end();
      return;
    }

    if (!target.deviceId) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(RELAY_LANDING_HTML);
      return;
    }

    const session = this.devices.get(target.deviceId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: `Device "${target.deviceId}" is offline or tunnel is not connected.`,
        })
      );
      return;
    }

    const streamId = crypto.randomUUID();
    session.streams.set(streamId, res);

    this.sendFrame(session.ws, {
      type: "req_start",
      streamId,
      method: req.method ?? "GET",
      path: target.forwardPath,
      headers: {
        ...req.headers,
        "x-forwarded-for":
          (req.headers["x-forwarded-for"] as string | undefined) ||
          req.socket.remoteAddress ||
          "relay",
        "x-forwarded-proto":
          (req.headers["x-forwarded-proto"] as string | undefined) || "https",
      },
    });

    req.on("data", (chunk: Buffer) => {
      if (chunk.length > 0) {
        this.sendFrame(session.ws, {
          type: "req_body",
          streamId,
          chunkBase64: chunk.toString("base64"),
        });
      }
    });

    req.on("end", () => {
      this.sendFrame(session.ws, { type: "req_end", streamId });
    });

    res.on("close", () => {
      if (session.streams.has(streamId)) {
        session.streams.delete(streamId);
        this.sendFrame(session.ws, { type: "req_abort", streamId });
      }
    });
  }

  private sendFrame(ws: WebSocket, frame: TunnelFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }
}
