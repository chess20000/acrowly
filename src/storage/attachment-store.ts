import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StoredFileMeta } from "../types.js";
import { writeFileAtomic } from "../config/store.js";

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
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ogv": "video/ogg",
  ".vob": "video/dvd",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
};

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

export function inferMimeAndKind(
  filename: string,
  declaredMime?: string,
  data?: Buffer
): { mime: string; kind: "image" | "file" } {
  const ext = path.extname(filename).toLowerCase();
  const cleanDeclared = declaredMime?.split(";")[0]?.trim().toLowerCase();

  if (cleanDeclared && cleanDeclared.startsWith("image/")) {
    return { mime: cleanDeclared, kind: "image" };
  }

  if (IMAGE_EXTENSIONS_TO_MIME[ext]) {
    return { mime: IMAGE_EXTENSIONS_TO_MIME[ext], kind: "image" };
  }

  if (ext === ".ts" && (!cleanDeclared || cleanDeclared === "application/octet-stream")) {
    // Distinguish TypeScript source text from binary MPEG-TS video streams
    if (!data || looksLikeText(data)) {
      return { mime: "text/plain; charset=utf-8", kind: "file" };
    }
    return { mime: "video/mp2t", kind: "file" };
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
    const { mime, kind } = inferMimeAndKind(safeName, input.declaredMime, input.data);
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

export interface ParsedMultipartFile {
  fieldName: string;
  filename: string;
  mime: string;
  data: Buffer;
}

export interface ParsedMultipartFormData {
  fields: Record<string, string>;
  files: ParsedMultipartFile[];
}

function parseDispositionFilename(dispositionLine: string): { hasFilename: boolean; filename: string } {
  const starMatch = dispositionLine.match(/filename\*\s*=\s*(?:utf-8''|UTF-8'')([^;\r\n]+)/i);
  if (starMatch) {
    const raw = starMatch[1].trim().replace(/^"(.*)"$/, "$1");
    try {
      return { hasFilename: true, filename: decodeURIComponent(raw) };
    } catch {
      return { hasFilename: true, filename: raw };
    }
  }
  const plainMatch = dispositionLine.match(/;\s*filename="([^"]*)"/i);
  if (plainMatch) {
    return { hasFilename: true, filename: plainMatch[1] };
  }
  return { hasFilename: false, filename: "" };
}

export function parseMultipartFormData(
  body: Buffer,
  contentType: string
): ParsedMultipartFormData | undefined {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) return undefined;
  const boundary = match[1] ?? match[2];
  const boundaryBuf = Buffer.from(`--${boundary}`);

  const fields: Record<string, string> = {};
  const files: ParsedMultipartFile[] = [];

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
    let headerEnd = -1;
    let sepLen = 0;
    if (headerEndCrlf !== -1 && (headerEndLf === -1 || headerEndCrlf < headerEndLf)) {
      headerEnd = headerEndCrlf;
      sepLen = 4;
    } else if (headerEndLf !== -1) {
      headerEnd = headerEndLf;
      sepLen = 2;
    }
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

    const nameMatch = headersText.match(/content-disposition:[^\r\n]*;\s*name="([^"]*)"/i);
    const fieldName = nameMatch?.[1] ?? "";
    const { hasFilename, filename } = parseDispositionFilename(headersText);

    if (hasFilename) {
      if (filename === "" && data.length === 0) {
        start = nextBoundary;
        continue;
      }
      const mimeMatch = headersText.match(/content-type:\s*([^\r\n;]+)/i);
      files.push({
        fieldName: fieldName || "file",
        filename: filename || "upload.bin",
        mime: mimeMatch ? mimeMatch[1].trim() : "application/octet-stream",
        data,
      });
    } else if (fieldName) {
      fields[fieldName] = data.toString("utf8");
    }

    start = nextBoundary;
  }

  return { fields, files };
}
