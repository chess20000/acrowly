import fs from "node:fs/promises";
import path from "node:path";

async function copyDirRecursive(src: string, dest: string): Promise<number> {
  let count = 0;
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return 0;
  }

  await fs.mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
      count += 1;
    }
  }
  return count;
}

export class SnapshotManager {
  constructor(
    private readonly snapshotsDir: string,
    private readonly webuiDir: string,
    private readonly extensionsDir: string
  ) {}

  async createSnapshot(reason: string): Promise<{ id: string; path: string; filesCopied: number }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeReason = reason.replace(/[^\w-]+/g, "_").slice(0, 40) || "manual";
    const id = `${stamp}_${safeReason}`;
    const targetDir = path.join(this.snapshotsDir, id);

    await fs.mkdir(targetDir, { recursive: true });
    let filesCopied = 0;
    filesCopied += await copyDirRecursive(this.webuiDir, path.join(targetDir, "webui"));
    filesCopied += await copyDirRecursive(this.extensionsDir, path.join(targetDir, "extensions"));

    await this.pruneOldSnapshots(15);
    return { id, path: targetDir, filesCopied };
  }

  async listSnapshots(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.snapshotsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  async restoreSnapshot(snapshotId?: string): Promise<{ restoredId: string; filesCopied: number }> {
    const available = await this.listSnapshots();
    const targetId = snapshotId || available[0];
    if (!targetId) {
      throw new Error("No snapshots available to restore.");
    }
    const snapDir = path.join(this.snapshotsDir, targetId);
    let filesCopied = 0;

    await fs.rm(this.webuiDir, { recursive: true, force: true });
    await fs.mkdir(this.webuiDir, { recursive: true });
    filesCopied += await copyDirRecursive(path.join(snapDir, "webui"), this.webuiDir);

    await fs.rm(this.extensionsDir, { recursive: true, force: true });
    await fs.mkdir(this.extensionsDir, { recursive: true });
    filesCopied += await copyDirRecursive(path.join(snapDir, "extensions"), this.extensionsDir);

    return { restoredId: targetId, filesCopied };
  }

  private async pruneOldSnapshots(keep: number): Promise<void> {
    const list = await this.listSnapshots();
    for (const old of list.slice(keep)) {
      await fs.rm(path.join(this.snapshotsDir, old), { recursive: true, force: true });
    }
  }
}
