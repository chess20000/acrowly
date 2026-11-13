import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { MessageOrigin } from "../types.js";

export interface ActorIdentity {
  kind: Extract<MessageOrigin, "subagent" | "extension" | "tool">;
  id: string;
  label: string;
  token: string;
  refs: number;
}

const als = new AsyncLocalStorage<ActorIdentity>();
const liveByToken = new Map<string, ActorIdentity>();
const shellPids = new Map<number, ActorIdentity>();

let fetchPatched = false;

export function createActor(
  kind: ActorIdentity["kind"],
  label: string,
  id = `${kind}_${crypto.randomBytes(4).toString("hex")}`
): ActorIdentity {
  const actor: ActorIdentity = {
    kind,
    id,
    label: label.slice(0, 40) || kind,
    token: crypto.randomBytes(18).toString("hex"),
    refs: 1,
  };
  liveByToken.set(actor.token, actor);
  return actor;
}

export function retainActor(actor: ActorIdentity): void {
  actor.refs += 1;
}

export function releaseActor(actor: ActorIdentity): void {
  actor.refs -= 1;
  if (actor.refs <= 0) {
    liveByToken.delete(actor.token);
  }
}

export function runWithActor<T>(actor: ActorIdentity, fn: () => Promise<T>): Promise<T> {
  return als.run(actor, fn);
}

export function currentActor(): ActorIdentity | undefined {
  return als.getStore();
}

export function actorFromToken(token: string | undefined): ActorIdentity | undefined {
  if (!token) return undefined;
  return liveByToken.get(token.trim());
}

export function registerShellPid(pid: number, actor: ActorIdentity): void {
  if (pid > 0) shellPids.set(pid, actor);
}

export function unregisterShellPid(pid: number | undefined): void {
  if (pid && pid > 0) shellPids.delete(pid);
}

/**
 * Tag in-process fetches that extensions/tools make back into the chat API.
 * Child processes cannot see this patch; they are attributed via the actor
 * token in their environment plus the loopback socket owner.
 */
export function installFetchActorHeader(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const actor = als.getStore();
    if (!actor || !isLocalChatPost(input, init)) {
      return original(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-acrowly-actor", actor.token);
    return original(input, { ...init, headers });
  }) as typeof fetch;
}

function isLocalChatPost(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (method !== "POST") return false;
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.includes("/api/chat/messages");
}

/**
 * A loopback client whose process (or parent) was spawned by a tool/subagent
 * is that actor, even when the client is curl and does not send our header.
 */
export function attributeLoopbackClient(remotePort: number | undefined): ActorIdentity | undefined {
  if (!remotePort || shellPids.size === 0) return undefined;
  if (process.platform === "win32") return attributeWindowsClient(remotePort);
  if (process.platform !== "linux") return undefined;
  const inodes = inodesForLocalPort(remotePort);
  if (inodes.size === 0) return undefined;

  // Prefer processes that inherited ACROWLY_ACTOR_TOKEN (curl/node children).
  // /proc/.../children is not available on every kernel, so don't depend on it.
  for (const pid of listPids()) {
    const fromEnv = tokenFromEnviron(pid);
    if (!fromEnv) continue;
    if (pidOwnsInode(pid, inodes)) return fromEnv;
  }

  const primary = new Set<number>();
  for (const root of shellPids.keys()) {
    for (const pid of collectDescendants(root)) primary.add(pid);
  }
  for (const pid of primary) {
    if (pidOwnsInode(pid, inodes)) return actorFromPid(pid);
  }
  return undefined;
}

function windowsSystemExe(name: string): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.win32.join(root, "System32", name);
}

/**
 * `netstat -ano` owner of the loopback socket whose local port is the peer
 * port the server accepted. Locale-independent: the state column is ignored.
 * Both the client row (local port = peer) and the server row exist; only the
 * peer port matches the client.
 */
export function parseNetstatPid(output: string, localPort: number): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (!/^TCP$/i.test(parts[0] ?? "")) continue;
    const local = parts[1] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (port !== localPort) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}

/** Walk parent pids until one of them is a shell this process spawned. */
export function actorForProcessTree(
  pid: number,
  ppids: ReadonlyMap<number, number>,
  shells: ReadonlyMap<number, ActorIdentity>
): ActorIdentity | undefined {
  let current: number | undefined = pid;
  const seen = new Set<number>();
  for (let hop = 0; hop < 16 && current && current > 0 && !seen.has(current); hop += 1) {
    seen.add(current);
    const actor = shells.get(current);
    if (actor) return actor;
    const parent = ppids.get(current);
    if (parent === undefined || parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function attributeWindowsClient(remotePort: number): ActorIdentity | undefined {
  let owner: number | undefined;
  try {
    const netstat = execFileSync(windowsSystemExe("netstat.exe"), ["-ano"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    owner = parseNetstatPid(netstat, remotePort);
  } catch {
    return undefined;
  }
  if (!owner) return undefined;
  const direct = shellPids.get(owner);
  if (direct && liveByToken.has(direct.token)) return direct;
  let ppids: Map<number, number>;
  try {
    ppids = windowsParentMap();
  } catch {
    return undefined;
  }
  const actor = actorForProcessTree(owner, ppids, shellPids);
  if (!actor || !liveByToken.has(actor.token)) return undefined;
  return actor;
}

function windowsParentMap(): Map<number, number> {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const exe = windowsSystemExe("WindowsPowerShell\\v1.0\\powershell.exe");
  const out = execFileSync(
    exe,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true, timeout: 8000 }
  );
  const map = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match?.[1] || !match[2]) continue;
    map.set(Number(match[1]), Number(match[2]));
  }
  return map;
}

function actorFromPid(pid: number): ActorIdentity | undefined {
  let current: number | undefined = pid;
  for (let hop = 0; hop < 12 && current && current > 1; hop += 1) {
    const registered = shellPids.get(current);
    if (registered && liveByToken.has(registered.token)) return registered;
    const fromEnv = tokenFromEnviron(current);
    if (fromEnv) return fromEnv;
    current = parentPid(current);
  }
  return undefined;
}

function tokenFromEnviron(pid: number): ActorIdentity | undefined {
  try {
    const buf = fs.readFileSync(`/proc/${pid}/environ`);
    const key = "ACROWLY_ACTOR_TOKEN=";
    let start = 0;
    for (let i = 0; i <= buf.length; i += 1) {
      if (i === buf.length || buf[i] === 0) {
        const entry = buf.toString("utf8", start, i);
        if (entry.startsWith(key)) {
          return liveByToken.get(entry.slice(key.length));
        }
        start = i + 1;
      }
    }
  } catch {
    // Process exited or environ is unreadable.
  }
  return undefined;
}

function parentPid(pid: number): number | undefined {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^PPid:\s+(\d+)/m.exec(status);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function collectDescendants(root: number): number[] {
  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    let kids = "";
    try {
      kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    } catch {
      kids = "";
    }
    for (const part of kids.trim().split(/\s+/)) {
      const next = Number(part);
      if (Number.isInteger(next) && next > 0) stack.push(next);
    }
  }
  return out;
}

function listPids(): number[] {
  try {
    return fs
      .readdirSync("/proc")
      .map((name) => Number(name))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function inodesForLocalPort(port: number): Set<string> {
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const localPortHex = parts[1]?.split(":")[1] ?? "";
      if (Number.parseInt(localPortHex, 16) !== port) continue;
      if (parts[3] !== "01") continue;
      if (parts[9] && parts[9] !== "0") inodes.add(parts[9]);
    }
  }
  return inodes;
}

function pidOwnsInode(pid: number, inodes: Set<string>): boolean {
  let fds: string[] = [];
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match?.[1] && inodes.has(match[1])) return true;
    } catch {
      // fd closed between readdir and readlink
    }
  }
  return false;
}
