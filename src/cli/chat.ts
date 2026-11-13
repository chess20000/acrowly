import crypto from "node:crypto";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import {
  ensureClientEd25519KeyPair,
  signWithEd25519PrivateKey,
} from "../server/ed25519.js";
import type { ChatMessage } from "../types.js";

export interface TerminalChatOptions {
  baseUrl: string;
  token?: string;
  onExit?: () => Promise<void>;
}

async function authenticateWithEd25519(baseUrl: string): Promise<string> {
  const keyPair = await ensureClientEd25519KeyPair();

  const chRes = await fetch(`${baseUrl}/api/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint: keyPair.fingerprint }),
  });

  if (chRes.status === 401) {
    throw new Error(
      `当前终端公钥尚未添加到目标服务端授权列表 (${keyPair.fingerprint})。\n` +
        `请先将下面这行公钥发给目标主机的协调器（或运行 acl add-key）：\n${keyPair.publicKeyOpenSsh}`
    );
  }
  if (!chRes.ok) {
    throw new Error(`获取鉴权挑战失败 (HTTP ${chRes.status}): ${await chRes.text()}`);
  }

  const chData = (await chRes.json()) as {
    challengeId: string;
    message: string;
  };

  const signature = signWithEd25519PrivateKey(keyPair.privateKeyPem, chData.message);
  const verRes = await fetch(`${baseUrl}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: chData.challengeId,
      signature,
    }),
  });

  if (!verRes.ok) {
    throw new Error(`Ed25519 签名验证失败 (HTTP ${verRes.status}): ${await verRes.text()}`);
  }

  const verData = (await verRes.json()) as { token: string };
  return verData.token;
}

export async function startPlainTerminalChat(options: TerminalChatOptions): Promise<void> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let authToken = options.token;
  const statusRes = await fetch(`${baseUrl}/api/auth/status`, { headers });
  const statusData = (await statusRes.json()) as {
    authenticated: boolean;
    authConfigured: boolean;
  };

  if (!statusData.authenticated && !authToken) {
    if (!statusData.authConfigured) {
      throw new Error(
        "目标服务端尚未添加任何 Ed25519 授权公钥，远端访问已锁死。请先在本机终端运行 acl 完成授权。"
      );
    }
    authToken = await authenticateWithEd25519(baseUrl);
    headers.Authorization = `Bearer ${authToken}`;
  }

  // Load recent messages for context on attach
  const histRes = await fetch(`${baseUrl}/api/chat/messages?limit=15`, { headers });
  if (!histRes.ok) {
    throw new Error(`无法拉取历史对话 (HTTP ${histRes.status})`);
  }
  const histData = (await histRes.json()) as { messages: ChatMessage[]; latestSeq: number };
  let lastSeenSeq = 0;

  output.write(`\n已连接 Acrowly 纯终端对话 (${baseUrl})。直接输入回车发送，输入 exit 退出。\n`);
  output.write("------------------------------------------------------------\n");

  for (const msg of histData.messages) {
    lastSeenSeq = Math.max(lastSeenSeq, msg.seq);
    printMessage(msg);
  }

  const rl = readline.createInterface({
    input,
    output,
    prompt: "> ",
  });

  const locallySentIds = new Set<string>();
  const abortController = new AbortController();
  let closed = false;
  let exiting = false;

  const safePrompt = (preserveCursor = false) => {
    if (!closed && !exiting) {
      rl.prompt(preserveCursor);
    }
  };

  const printWhilePrompted = (msg: ChatMessage) => {
    if (closed || exiting || msg.seq <= lastSeenSeq) return;
    lastSeenSeq = msg.seq;
    if (msg.role === "user" && msg.id && locallySentIds.has(msg.id)) {
      locallySentIds.delete(msg.id);
      return;
    }
    if (output.isTTY) {
      readline.clearLine(output, 0);
      readline.cursorTo(output, 0);
    }
    printMessage(msg);
    safePrompt(true);
  };

  // Start SSE subscription loop with automatic reconnect
  void subscribeSseLoop(
    baseUrl,
    headers,
    () => lastSeenSeq,
    printWhilePrompted,
    abortController.signal
  );

  rl.prompt();

  let lineQueue = Promise.resolve();

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      lineQueue = lineQueue.then(async () => {
        if (closed || exiting) return;
        const text = line.trim();
        if (!text) {
          safePrompt();
          return;
        }
        if (text === "exit" || text === "/exit" || text === "quit" || text === "/quit") {
          exiting = true;
          rl.close();
          return;
        }

        const clientMsgId = crypto.randomUUID();
        try {
          const res = await fetch(`${baseUrl}/api/chat/messages`, {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text, clientMsgId }),
          });
          if (!res.ok) {
            const errText = await res.text();
            output.write(`[发送失败 HTTP ${res.status}] ${errText}\n`);
          } else {
            const data = (await res.json()) as { message: ChatMessage };
            locallySentIds.add(data.message.id);
            lastSeenSeq = Math.max(lastSeenSeq, data.message.seq);
          }
        } catch (err) {
          output.write(`[连接异常] ${err instanceof Error ? err.message : String(err)}\n`);
        }

        safePrompt();
      });
    });

    rl.on("close", async () => {
      closed = true;
      await lineQueue;
      abortController.abort();
      output.write("\n已退出终端对话。\n");
      if (options.onExit) {
        await options.onExit();
      }
      resolve();
    });
  });
}

function printMessage(msg: ChatMessage): void {
  const tag = msg.role === "assistant" ? "[协调器]" : "[你]";
  output.write(`\n${tag}\n${msg.text}\n\n`);
}

async function subscribeSseLoop(
  baseUrl: string,
  headers: Record<string, string>,
  getLastSeq: () => number,
  onMessage: (msg: ChatMessage) => void,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await fetch(`${baseUrl}/api/chat/stream?after_seq=${getLastSeq()}`, {
        headers,
        signal,
      });
      if (!res.ok || !res.body) {
        await sleep(700, signal);
        continue;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          processSseBlock(rawEvent, onMessage);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      if (signal.aborted) return;
      await sleep(700, signal);
    }
  }
}

function processSseBlock(block: string, onMessage: (msg: ChatMessage) => void): void {
  const lines = block.split(/\r?\n/);
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (eventName === "message" && dataLines.length > 0) {
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as ChatMessage;
      onMessage(parsed);
    } catch {
      // ignore malformed SSE JSON
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
