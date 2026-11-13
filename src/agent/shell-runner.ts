import { spawn, type ChildProcess } from "node:child_process";
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
}

const liveJobs = new Set<LiveJob>();

export function stopTrackedShells(): void {
  for (const job of liveJobs) {
    clearTimeout(job.timer);
    try {
      process.kill(-job.pid, "SIGTERM");
    } catch {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  liveJobs.clear();
}

export interface ShellRunResult {
  output: string;
  timedOut: boolean;
  background: boolean;
}

function shellBin(): string {
  return process.platform === "win32" ? "powershell.exe" : "/bin/sh";
}

function actorEnv(actor: ActorIdentity | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(actor
      ? {
          ACROWLY_ACTOR_TOKEN: actor.token,
          ACROWLY_ACTOR_ORIGIN: actor.kind,
          ACROWLY_ACTOR_LABEL: actor.label,
        }
      : {}),
  };
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
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
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
  const child = spawn(options.command, {
    shell: shellBin(),
    cwd: options.cwd,
    env: actorEnv(options.actor),
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  if (child.pid && options.actor) registerShellPid(child.pid, options.actor);

  let settled = false;
  const job: LiveJob = { pid: child.pid ?? -1, timer: undefined as unknown as NodeJS.Timeout };
  const finish = (text: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(job.timer);
    liveJobs.delete(job);
    if (child.pid) unregisterShellPid(child.pid);
    if (options.actor) releaseActor(options.actor);
    if (options.onSettled) {
      void options.onSettled(text).catch(() => {});
    }
  };

  job.timer = setTimeout(() => {
    killGroup(child);
    finish(formatUserVisibleReply(`后台 ${label} 到时限结束，没有完成，也没有外部回执。`));
  }, options.timeoutMs);
  if (child.pid) liveJobs.add(job);

  child.on("error", (err) => {
    finish(formatUserVisibleReply(`后台 ${label} 启动失败，卡在：${err.message}`));
  });
  child.on("exit", (code, signal) => {
    if (settled) return;
    if (signal) {
      finish(formatUserVisibleReply(`后台 ${label} 到时限结束，没有完成，也没有外部回执。`));
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
    const child = spawn(options.command, {
      shell: shellBin(),
      cwd: options.cwd,
      env: actorEnv(options.actor),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid && options.actor) registerShellPid(child.pid, options.actor);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (child.pid) unregisterShellPid(child.pid);
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
