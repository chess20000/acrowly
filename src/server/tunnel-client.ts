import { WebSocket } from "ws";
import type { ConfigStore } from "../config/store.js";
import type { TunnelFrame } from "../relay/protocol.js";
import type { AcrowlyHttpServer, HttpResponseSink } from "./http.js";

interface PendingTunnelRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  chunks: Buffer[];
  totalBytes: number;
  aborted: boolean;
  closeListeners: Array<() => void>;
}

const MAX_TUNNEL_REQ_BYTES = 50 * 1024 * 1024;

export class TunnelClient {
  private ws: WebSocket | undefined;
  private stopped = false;
  private connected = false;
  private reconnectDelayMs = 1000;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private activeStreams = new Map<string, PendingTunnelRequest>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly httpServer: AcrowlyHttpServer
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.stopped = false;
    this.syncConnection();
  }

  stop(): void {
    this.stopped = true;
    this.disconnect();
  }

  syncConnection(): void {
    if (this.stopped) return;
    const relay = this.configStore.getConfig().relay;
    if (!relay.enabled) {
      this.disconnect();
      return;
    }
    this.disconnect();
    this.connect();
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.connected = false;
    for (const stream of this.activeStreams.values()) {
      stream.aborted = true;
      for (const cb of stream.closeListeners) cb();
    }
    this.activeStreams.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close error
      }
      this.ws = undefined;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const relay = this.configStore.getConfig().relay;
    if (!relay.enabled || !relay.url) return;

    const targetUrl = new URL(relay.url);
    targetUrl.searchParams.set("deviceId", relay.deviceId);
    targetUrl.searchParams.set("secret", relay.tunnelSecret);

    const ws = new WebSocket(targetUrl.toString());
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnectDelayMs = 1000;
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          this.sendFrame(ws, { type: "ping" });
        }
      }, 20_000);
      this.pingTimer.unref();
    });

    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      try {
        const frame = JSON.parse(raw.toString()) as TunnelFrame;
        this.handleFrame(ws, frame);
      } catch {
        // ignore malformed frame
      }
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.cleanupSocket();
      this.scheduleReconnect();
    });

    ws.on("error", () => {
      // close event handles cleanup and backoff reconnect
    });
  }

  private cleanupSocket(): void {
    this.connected = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    for (const stream of this.activeStreams.values()) {
      stream.aborted = true;
      for (const cb of stream.closeListeners) cb();
    }
    this.activeStreams.clear();
    this.ws = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.configStore.getConfig().relay.enabled) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private sendFrame(ws: WebSocket, frame: TunnelFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  private handleFrame(ws: WebSocket, frame: TunnelFrame): void {
    switch (frame.type) {
      case "ping":
        this.sendFrame(ws, { type: "pong" });
        return;

      case "pong":
        return;

      case "req_start": {
        this.activeStreams.set(frame.streamId, {
          method: frame.method,
          path: frame.path,
          headers: frame.headers,
          chunks: [],
          totalBytes: 0,
          aborted: false,
          closeListeners: [],
        });
        return;
      }

      case "req_body": {
        const pending = this.activeStreams.get(frame.streamId);
        if (!pending || pending.aborted) return;
        const buf = Buffer.from(frame.chunkBase64, "base64");
        pending.totalBytes += buf.length;
        if (pending.totalBytes > MAX_TUNNEL_REQ_BYTES) {
          pending.aborted = true;
          this.sendFrame(ws, {
            type: "res_start",
            streamId: frame.streamId,
            status: 413,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
          this.sendFrame(ws, {
            type: "res_body",
            streamId: frame.streamId,
            chunkBase64: Buffer.from('{"error":"Payload too large"}').toString("base64"),
          });
          this.sendFrame(ws, { type: "res_end", streamId: frame.streamId });
          this.activeStreams.delete(frame.streamId);
          return;
        }
        pending.chunks.push(buf);
        return;
      }

      case "req_abort": {
        const pending = this.activeStreams.get(frame.streamId);
        if (!pending) return;
        pending.aborted = true;
        for (const cb of pending.closeListeners) cb();
        this.activeStreams.delete(frame.streamId);
        return;
      }

      case "req_end": {
        const pending = this.activeStreams.get(frame.streamId);
        if (!pending || pending.aborted) return;
        const streamId = frame.streamId;

        const sink: HttpResponseSink = {
          writeHead: (status, headers) => {
            if (pending.aborted) return;
            this.sendFrame(ws, { type: "res_start", streamId, status, headers });
          },
          write: (chunk) => {
            if (pending.aborted) return;
            const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            if (buf.length > 0) {
              this.sendFrame(ws, {
                type: "res_body",
                streamId,
                chunkBase64: buf.toString("base64"),
              });
            }
          },
          end: (chunk) => {
            if (pending.aborted) return;
            if (chunk) {
              const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
              if (buf.length > 0) {
                this.sendFrame(ws, {
                  type: "res_body",
                  streamId,
                  chunkBase64: buf.toString("base64"),
                });
              }
            }
            this.sendFrame(ws, { type: "res_end", streamId });
            this.activeStreams.delete(streamId);
          },
          onClose: (cb) => {
            pending.closeListeners.push(cb);
          },
        };

          const xff = pending.headers["x-forwarded-for"];
          const clientIp =
            (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() || "relay";
          void this.httpServer
          .dispatchTunneledRequest(
            {
              method: pending.method,
              url: pending.path,
              headers: pending.headers,
              body: Buffer.concat(pending.chunks),
              isRemote: true,
              clientIp,
            },
            sink
          )
          .catch((err) => {
            if (pending.aborted) return;
            this.sendFrame(ws, {
              type: "res_start",
              streamId,
              status: 500,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            });
            this.sendFrame(ws, {
              type: "res_body",
              streamId,
              chunkBase64: Buffer.from(
                JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
              ).toString("base64"),
            });
            this.sendFrame(ws, { type: "res_end", streamId });
            this.activeStreams.delete(streamId);
          });
        return;
      }
    }
  }
}
