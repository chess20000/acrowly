import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  currentActor,
  registerShellPid,
  releaseActor,
  retainActor,
  unregisterShellPid,
  type ActorIdentity,
} from "./actor.js";
import { formatUserVisibleReply } from "./reply-policy.js";

const OUTPUT_CAP = 16_000;
const FOREGROUND_TIMEOUT_CAP_MS = 300_000;
const BACKGROUND_TIMEOUT_CAP_MS = 30 * 60_000;
const BACKGROUND_TIMEOUT_DEFAULT_MS = 30 * 60_000;

interface LiveJob {
  pid: number;
  timer: NodeJS.Timeout;
  child: ChildProcess;
}

const liveJobs = new Set<LiveJob>();
const liveChildren = new Set<ChildProcess>();

function taskkillExe(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.join(root, "System32", "taskkill.exe");
}

function closeChildStreams(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  const release = (): void => {
    liveChildren.delete(child);
    closeChildStreams(child);
  };
  child.once("exit", release);
  child.once("error", release);
}

function waitForExit(child: ChildProcess, timeoutMs = 8000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Kill pid and every process it started. taskkill /T is synchronous and waits. */
export function killProcessTreeSync(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync(taskkillExe(), ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 8000,
      });
    } catch {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

export async function stopTrackedShells(): Promise<void> {
  for (const job of liveJobs) clearTimeout(job.timer);
  const pending = [...liveChildren];
  for (const child of pending) {
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTreeSync(child.pid);
    }
  }
  await Promise.all(pending.map((child) => waitForExit(child)));
  for (const child of pending) closeChildStreams(child);
  liveJobs.clear();
}

export interface ShellRunResult {
  output: string;
  timedOut: boolean;
  background: boolean;
}

function powershellExe(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Windows PowerShell strips unescaped `"` from `-Command` before the script runs,
 * which turns `node -e "fetch(...)"` into a syntax error so the loopback post
 * never happens. `-EncodedCommand` is the UTF-16LE script with quoting intact.
 * Non-ASCII native arguments are still lossy in Windows PowerShell 5.1 when
 * there is no console; callers that must round-trip Unicode should keep the
 * command ASCII (for example base64) and let Node decode it.
 */
export function encodePowerShellCommand(command: string): string {
  const script = [
    "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}",
    "$OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    command,
    "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
  ].join("\r\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

function spawnShell(command: string, options: SpawnOptions): ChildProcess {
  if (process.platform === "win32") {
    return spawn(
      powershellExe(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShellCommand(command),
      ],
      { ...options, windowsHide: true }
    );
  }
  return spawn("/bin/sh", ["-c", command], options);
}

const ACTOR_PRELOAD_SOURCE = `
const token = process.env.ACROWLY_ACTOR_TOKEN;
if (token && typeof global.fetch === "function") {
  const orig = global.fetch;
  global.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (method === "POST" && String(url).includes("/api/chat/messages")) {
        const headers = new Headers((init && init.headers) || (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
        if (!headers.has("x-acrowly-actor")) headers.set("x-acrowly-actor", token);
        init = Object.assign({}, init, { headers });
      }
    } catch (err) {
      // Never block the command if tagging fails.
    }
    return orig.apply(this, [input, init]);
  };
}
`;

let actorPreloadPath: string | undefined;

function ensureActorPreload(): string {
  if (actorPreloadPath) return actorPreloadPath;
  actorPreloadPath = path.join(os.tmpdir(), "acrowly-actor-preload.cjs");
  fs.writeFileSync(actorPreloadPath, ACTOR_PRELOAD_SOURCE, "utf8");
  return actorPreloadPath;
}

function actorEnv(actor: ActorIdentity | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!actor) return env;
  env.ACROWLY_ACTOR_TOKEN = actor.token;
  env.ACROWLY_ACTOR_ORIGIN = actor.kind;
  env.ACROWLY_ACTOR_LABEL = actor.label;
  // Windows cannot read another process's environment. Child `node` still
  // inherits this and --require tags loopback chat posts with the actor token.
  // NODE_OPTIONS treats backslash as an escape, so Windows paths must use /.
  const preload = ensureActorPreload().replace(/\\/g, "/");
  const quoted = preload.includes(" ") ? `"${preload}"` : preload;
  const prev = env.NODE_OPTIONS?.trim();
  env.NODE_OPTIONS = [prev, `--require ${quoted}`].filter(Boolean).join(" ");
  return env;
}

/** `cmd &` is a detached waiter. `cmd &&` is not. */
export function splitBackgroundCommand(command: string): { background: boolean; command: string } {
  const trimmed = command.trim();
  if (/(^|[^&])&\s*$/.test(trimmed)) {
    return { background: true, command: trimmed.replace(/&\s*$/, "").trim() };
  }
  return { background: false, command: trimmed };
}

function killGroup(child: ChildProcess): void {
  killProcessTreeSync(child.pid);
}

function formatStreams(stdout: string, stderr: string, exitCode: number, timedOut: boolean): string {
  if (timedOut) {
    return `EXIT timeout\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`.slice(0, OUTPUT_CAP);
  }
  if (exitCode === 0) {
    const combined = [stdout ? `STDOUT:\n${stdout}` : "", stderr ? `STDERR:\n${stderr}` : ""]
      .filter(Boolean)
      .join("\n");
    return (combined || "(Command exited with code 0, no output.)").slice(0, OUTPUT_CAP);
  }
  return `EXIT ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`.slice(0, OUTPUT_CAP);
}

export async function runShellCommand(options: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onBackgroundSettled?: (text: string) => Promise<void>;
  markIncomplete?: () => void;
}): Promise<ShellRunResult> {
  const actor = currentActor();
  const split = splitBackgroundCommand(options.command);
  if (!split.command) {
    return { output: "ERROR: empty command", timedOut: false, background: false };
  }

  if (split.background) {
    const timeoutMs = Math.min(
      Math.max(Number(options.timeoutMs ?? BACKGROUND_TIMEOUT_DEFAULT_MS), 200),
      BACKGROUND_TIMEOUT_CAP_MS
    );
    const output = startBackground({
      command: split.command,
      cwd: options.cwd,
      timeoutMs,
      actor,
      onSettled: options.onBackgroundSettled,
    });
    options.markIncomplete?.();
    return { output, timedOut: false, background: true };
  }

  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs ?? 60_000), 1000),
    FOREGROUND_TIMEOUT_CAP_MS
  );
  const output = await runForeground({
    command: split.command,
    cwd: options.cwd,
    timeoutMs,
    signal: options.signal,
    actor,
  });
  return { output: output.output, timedOut: output.timedOut, background: false };
}

function startBackground(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  actor: ActorIdentity | undefined;
  onSettled?: (text: string) => Promise<void>;
}): string {
  const label = options.actor?.label || "shell";
  if (options.actor) retainActor(options.actor);
  const child = spawnShell(options.command, {
    cwd: options.cwd,
    env: actorEnv(options.actor),
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  if (child.pid && options.actor) registerShellPid(child.pid, options.actor);
  trackChild(child);

  let settled = false;
  let killedByTimeout = false;
  const job: LiveJob = {
    pid: child.pid ?? -1,
    timer: undefined as unknown as NodeJS.Timeout,
    child,
  };
  const timeoutText = formatUserVisibleReply(`后台 ${label} 到时限结束，没有完成，也没有外部回执。`);
  const finish = (text: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(job.timer);
    liveJobs.delete(job);
    if (child.pid) unregisterShellPid(child.pid);
    closeChildStreams(child);
    if (options.actor) releaseActor(options.actor);
    if (options.onSettled) {
      void options.onSettled(text).catch(() => {});
    }
  };

  job.timer = setTimeout(() => {
    killedByTimeout = true;
    killGroup(child);
    finish(timeoutText);
  }, options.timeoutMs);
  if (child.pid) liveJobs.add(job);

  child.on("error", (err) => {
    finish(formatUserVisibleReply(`后台 ${label} 启动失败，卡在：${err.message}`));
  });
  child.on("exit", (code, signal) => {
    if (settled) return;
    if (killedByTimeout || signal) {
      finish(timeoutText);
      return;
    }
    if (code === 0) {
      finish(
        formatUserVisibleReply(`后台 ${label} 的进程结束了。这只是本机进程结束，不是外部连通。`)
      );
      return;
    }
    finish(formatUserVisibleReply(`后台 ${label} 的进程失败了（退出码 ${code ?? 1}），没有完成。`));
  });

  return (
    `TRACKED_BACKGROUND label=${label} timeoutMs=${options.timeoutMs}. ` +
    "进程已被跟踪，到时限或结束时会直接通知用户。这不是完成，也不是外部连通。"
  );
}

function runForeground(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  actor: ActorIdentity | undefined;
}): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const child = spawnShell(options.command, {
      cwd: options.cwd,
      env: actorEnv(options.actor),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid && options.actor) registerShellPid(child.pid, options.actor);
    trackChild(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (child.pid) unregisterShellPid(child.pid);
      closeChildStreams(child);
    };

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ output: formatStreams(stdout, stderr, exitCode, timedOut), timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, options.timeoutMs);

    const onAbort = (): void => {
      killGroup(child);
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Aborted"));
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.signal?.aborted) {
        reject(err);
        return;
      }
      resolve({ output: `EXIT 1\n${err.message}`.slice(0, OUTPUT_CAP), timedOut: false });
    });
    child.on("exit", (code) => {
      finish(code ?? (timedOut ? 124 : 1));
    });
  });
}
