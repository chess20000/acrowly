import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StoredFileMeta } from "../types.js";
import { writeFileAtomic } from "../config/store.js";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".flv",
  ".m4v",
  ".wmv",
  ".3gp",
  ".3g2",
  ".mpeg",
  ".mpg",
  ".ts",
  ".mts",
  ".m2ts",
  ".ogv",
  ".vob",
]);

const IMAGE_EXTENSIONS_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
};

const FILE_EXTENSIONS_TO_MIME: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
};

// Note: `.ts` can be TypeScript source code when text, so inspect content/MIME before blocking `.ts` as MPEG-TS!
const VIDEO_FTYP_BRANDS = new Set([
  "isom",
  "iso2",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "hvc1",
  "qt  ",
  "m4v ",
  "M4V ",
  "3gp4",
  "3gp5",
  "3gp6",
  "3g2a",
  "f4v ",
]);

export class VideoRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "VideoRejectedError";
  }
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename || "file").replace(/[\r\n\0/\\]+/g, "_");
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5() ]+/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "file";
}

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

export function assertNotVideo(filename: string, mime: string, data: Buffer): void {
  const lowerMime = mime.toLowerCase().trim();
  if (lowerMime.startsWith("video/")) {
    throw new VideoRejectedError("Video MIME types are not supported.");
  }

  const ext = path.extname(filename).toLowerCase();
  if (ext === ".ts") {
    // Allow TypeScript files (`text/*` or UTF-8 text without MPEG-TS 0x47 sync bytes every 188 bytes)
    const isMpegTsSync =
      data.length >= 377 && data[0] === 0x47 && data[188] === 0x47 && data[376] === 0x47;
    if (isMpegTsSync || !looksLikeText(data)) {
      throw new VideoRejectedError("MPEG-TS video streams are not supported.");
    }
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    throw new VideoRejectedError(`Video file extension (${ext}) is not supported.`);
  }

  // Magic-byte inspection
  if (data.length >= 12) {
    // ISO Base Media File Format (`ftyp`)
    if (data.subarray(4, 8).toString("ascii") === "ftyp") {
      const brand = data.subarray(8, 12).toString("ascii");
      if (VIDEO_FTYP_BRANDS.has(brand) || brand.toLowerCase().startsWith("3gp")) {
        throw new VideoRejectedError(`Video container (${brand.trim()}) is not supported.`);
      }
    }

    // RIFF .... AVI
    if (
      data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "AVI "
    ) {
      throw new VideoRejectedError("AVI video files are not supported.");
    }

    // FLV\x01
    if (data.subarray(0, 3).toString("ascii") === "FLV" && data[3] === 0x01) {
      throw new VideoRejectedError("FLV video files are not supported.");
    }

    // EBML header (Matroska / WebM)
    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
      const head = data.subarray(0, Math.min(data.length, 64)).toString("latin1").toLowerCase();
      if (head.includes("webm") || head.includes("matroska")) {
        throw new VideoRejectedError("WebM/MKV video files are not supported.");
      }
    }
  }
}

export function inferMimeAndKind(
  filename: string,
  declaredMime?: string
): { mime: string; kind: "image" | "file" } {
  const ext = path.extname(filename).toLowerCase();
  const cleanDeclared = declaredMime?.split(";")[0]?.trim().toLowerCase();

  if (cleanDeclared && cleanDeclared.startsWith("image/")) {
    return { mime: cleanDeclared, kind: "image" };
  }

  if (IMAGE_EXTENSIONS_TO_MIME[ext]) {
    return { mime: IMAGE_EXTENSIONS_TO_MIME[ext], kind: "image" };
  }

  if (cleanDeclared && cleanDeclared !== "application/octet-stream") {
    return { mime: cleanDeclared, kind: "file" };
  }

  if (FILE_EXTENSIONS_TO_MIME[ext]) {
    return { mime: FILE_EXTENSIONS_TO_MIME[ext], kind: "file" };
  }

  return { mime: "application/octet-stream", kind: "file" };
}

export function buildFileMarkdown(meta: Pick<StoredFileMeta, "id" | "kind" | "name">): {
  url: string;
  markdown: string;
} {
  const encodedName = encodeURIComponent(meta.name);
  const url = `/api/files/${meta.id}/${encodedName}`;
  const markdown = meta.kind === "image" ? `![${meta.name}](${url})` : `[${meta.name}](${url})`;
  return { url, markdown };
}

export class AttachmentStore {
  private readonly indexPath: string;
  private index = new Map<string, StoredFileMeta>();

  constructor(private readonly filesDir: string) {
    this.indexPath = path.join(filesDir, "index.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.filesDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const items = JSON.parse(raw) as StoredFileMeta[];
      this.index.clear();
      for (const item of items) {
        this.index.set(item.id, item);
      }
    } catch {
      await this.saveIndex();
    }
  }

  async saveUpload(input: {
    filename: string;
    declaredMime?: string;
    data: Buffer;
  }): Promise<StoredFileMeta & { url: string; markdown: string }> {
    const safeName = sanitizeFilename(input.filename);
    assertNotVideo(safeName, input.declaredMime ?? "", input.data);

    const { mime, kind } = inferMimeAndKind(safeName, input.declaredMime);
    const id = `file_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const ext = path.extname(safeName);
    const storedName = `${id}${ext}`;
    const storedPath = path.join(this.filesDir, storedName);

    await fs.writeFile(storedPath, input.data);

    const meta: StoredFileMeta = {
      id,
      kind,
      name: safeName,
      mime,
      size: input.data.length,
      storedPath,
      createdAt: new Date().toISOString(),
    };

    this.index.set(id, meta);
    await this.saveIndex();

    return {
      ...meta,
      ...buildFileMarkdown(meta),
    };
  }

  async importLocalFile(
    localPath: string,
    displayName?: string
  ): Promise<StoredFileMeta & { url: string; markdown: string }> {
    const absPath = path.resolve(localPath);
    const data = await fs.readFile(absPath);
    const filename = displayName ? sanitizeFilename(displayName) : path.basename(absPath);
    return this.saveUpload({ filename, data });
  }

  getMeta(id: string): StoredFileMeta | undefined {
    return this.index.get(id);
  }

  async readFileBuffer(id: string): Promise<{ meta: StoredFileMeta; data: Buffer } | undefined> {
    const meta = this.index.get(id);
    if (!meta) return undefined;
    try {
      const data = await fs.readFile(meta.storedPath);
      return { meta, data };
    } catch {
      return undefined;
    }
  }

  private async saveIndex(): Promise<void> {
    const items = Array.from(this.index.values());
    await writeFileAtomic(this.indexPath, JSON.stringify(items, null, 2));
  }
}

export function parseMultipartSingleFile(
  body: Buffer,
  contentType: string
): { filename: string; mime: string; data: Buffer } | undefined {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) return undefined;
  const boundary = match[1] ?? match[2];
  const boundaryBuf = Buffer.from(`--${boundary}`);

  let start = body.indexOf(boundaryBuf);
  while (start !== -1) {
    const partStart = start + boundaryBuf.length;
    if (body.subarray(partStart, partStart + 2).toString("latin1") === "--") {
      break;
    }
    const nextBoundary = body.indexOf(boundaryBuf, partStart);
    if (nextBoundary === -1) break;

    let part = body.subarray(partStart, nextBoundary);
    if (part.subarray(0, 2).toString("latin1") === "\r\n") {
      part = part.subarray(2);
    } else if (part[0] === 0x0a) {
      part = part.subarray(1);
    }

    const headerEndCrlf = part.indexOf(Buffer.from("\r\n\r\n"));
    const headerEndLf = part.indexOf(Buffer.from("\n\n"));
    const headerEnd = headerEndCrlf !== -1 ? headerEndCrlf : headerEndLf;
    const sepLen = headerEndCrlf !== -1 ? 4 : 2;
    if (headerEnd === -1) {
      start = nextBoundary;
      continue;
    }

    const headersText = part.subarray(0, headerEnd).toString("utf8");
    let data = part.subarray(headerEnd + sepLen);
    if (data.subarray(data.length - 2).toString("latin1") === "\r\n") {
      data = data.subarray(0, data.length - 2);
    } else if (data[data.length - 1] === 0x0a) {
      data = data.subarray(0, data.length - 1);
    }

    const filenameMatch = headersText.match(/filename="([^"]*)"/i);
    if (filenameMatch) {
      const mimeMatch = headersText.match(/content-type:\s*([^\r\n;]+)/i);
      return {
        filename: filenameMatch[1] || "upload.bin",
        mime: mimeMatch ? mimeMatch[1].trim() : "application/octet-stream",
        data,
      };
    }

    start = nextBoundary;
  }

  return undefined;
}
