import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** ASN.1 SPKI DER prefix for 32-byte raw Ed25519 public key */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ParsedEd25519PublicKey {
  rawPublicKeyBase64: string;
  openssh: string;
  fingerprint: string;
  comment?: string;
}

function encodeSshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

export function buildOpenSshWireBlob(rawKey: Buffer): Buffer {
  if (rawKey.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 public key, got ${rawKey.length} bytes.`);
  }
  return Buffer.concat([
    encodeSshString(Buffer.from("ssh-ed25519", "ascii")),
    encodeSshString(rawKey),
  ]);
}

function parseOpenSshWireBlob(blob: Buffer): Buffer {
  if (blob.length < 19) {
    throw new Error("Invalid OpenSSH Ed25519 public key blob.");
  }
  const typeLen = blob.readUInt32BE(0);
  let offset = 4;
  if (offset + typeLen + 4 > blob.length) {
    throw new Error("Truncated OpenSSH key type.");
  }
  const keyType = blob.subarray(offset, offset + typeLen).toString("ascii");
  offset += typeLen;
  if (keyType !== "ssh-ed25519") {
    throw new Error(`Unsupported SSH key type "${keyType}"; only ssh-ed25519 is supported.`);
  }
  const keyLen = blob.readUInt32BE(offset);
  offset += 4;
  if (keyLen !== 32 || offset + keyLen > blob.length) {
    throw new Error("Invalid Ed25519 raw key length in OpenSSH blob.");
  }
  return blob.subarray(offset, offset + 32);
}

function decodeBase64Flexible(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padLen), "base64");
}

export function parseEd25519PublicKey(input: string): ParsedEd25519PublicKey {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Public key cannot be empty.");
  }

  let rawKey: Buffer;
  let comment: string | undefined;

  if (trimmed.startsWith("ssh-ed25519 ")) {
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      throw new Error("Malformed ssh-ed25519 public key.");
    }
    const blob = decodeBase64Flexible(parts[1]);
    rawKey = parseOpenSshWireBlob(blob);
    if (parts.length > 2) {
      comment = parts.slice(2).join(" ");
    }
  } else if (trimmed.includes("BEGIN PUBLIC KEY")) {
    const keyObj = crypto.createPublicKey(trimmed);
    if (keyObj.asymmetricKeyType !== "ed25519") {
      throw new Error("PEM key is not an Ed25519 public key.");
    }
    const der = keyObj.export({ format: "der", type: "spki" }) as Buffer;
    rawKey = der.subarray(der.length - 32);
  } else {
    const decoded = decodeBase64Flexible(trimmed);
    if (decoded.length === 32) {
      rawKey = decoded;
    } else if (
      decoded.length === 44 &&
      decoded.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
      rawKey = decoded.subarray(ED25519_SPKI_PREFIX.length);
    } else {
      // Try parsing as bare OpenSSH wire blob
      rawKey = parseOpenSshWireBlob(decoded);
    }
  }

  // Validate key with Node crypto
  const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
  crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });

  const wireBlob = buildOpenSshWireBlob(rawKey);
  const fingerprint =
    "SHA256:" +
    crypto.createHash("sha256").update(wireBlob).digest("base64").replace(/=+$/, "");

  return {
    rawPublicKeyBase64: rawKey.toString("base64"),
    openssh: `ssh-ed25519 ${wireBlob.toString("base64")}`,
    fingerprint,
    ...(comment ? { comment } : {}),
  };
}

export function verifyEd25519Signature(
  rawPublicKeyBase64: string,
  message: string | Buffer,
  signatureBase64: string
): boolean {
  try {
    const rawKey = decodeBase64Flexible(rawPublicKeyBase64);
    if (rawKey.length !== 32) return false;
    const sigBuf = decodeBase64Flexible(signatureBase64);
    if (sigBuf.length !== 64) return false;

    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
    const keyObj = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    const msgBuf = typeof message === "string" ? Buffer.from(message, "utf8") : message;
    return crypto.verify(null, msgBuf, keyObj, sigBuf);
  } catch {
    return false;
  }
}

export function generateEd25519KeyPair(comment = "acrowly-client"): {
  privateKeyPem: string;
  publicKeyOpenSsh: string;
  rawPublicKeyBase64: string;
  fingerprint: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawKey = spki.subarray(spki.length - 32);
  const parsed = parseEd25519PublicKey(rawKey.toString("base64"));
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  return {
    privateKeyPem,
    publicKeyOpenSsh: `${parsed.openssh} ${comment}`,
    rawPublicKeyBase64: parsed.rawPublicKeyBase64,
    fingerprint: parsed.fingerprint,
  };
}

export function signWithEd25519PrivateKey(privateKeyPem: string, message: string | Buffer): string {
  const msgBuf = typeof message === "string" ? Buffer.from(message, "utf8") : message;
  const sig = crypto.sign(null, msgBuf, privateKeyPem);
  return sig.toString("base64");
}

export function resolveClientKeyDir(): string {
  if (process.env.ACROWLY_CLIENT_KEY_DIR) {
    return path.resolve(process.env.ACROWLY_CLIENT_KEY_DIR);
  }
  return path.join(os.homedir(), ".acrowly");
}

export async function ensureClientEd25519KeyPair(
  keyDir = resolveClientKeyDir(),
  comment = `${os.userInfo().username || "user"}@${os.hostname()}`
): Promise<{
  created: boolean;
  privateKeyPath: string;
  publicKeyPath: string;
  privateKeyPem: string;
  publicKeyOpenSsh: string;
  rawPublicKeyBase64: string;
  fingerprint: string;
}> {
  const privateKeyPath = path.join(keyDir, "id_ed25519");
  const publicKeyPath = path.join(keyDir, "id_ed25519.pub");

  try {
    const [privPem, pubLine] = await Promise.all([
      fs.readFile(privateKeyPath, "utf8"),
      fs.readFile(publicKeyPath, "utf8"),
    ]);
    const parsed = parseEd25519PublicKey(pubLine);
    return {
      created: false,
      privateKeyPath,
      publicKeyPath,
      privateKeyPem: privPem,
      publicKeyOpenSsh: pubLine.trim(),
      rawPublicKeyBase64: parsed.rawPublicKeyBase64,
      fingerprint: parsed.fingerprint,
    };
  } catch {
    await fs.mkdir(keyDir, { recursive: true });
    const pair = generateEd25519KeyPair(comment);
    await fs.writeFile(privateKeyPath, pair.privateKeyPem, { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(publicKeyPath, `${pair.publicKeyOpenSsh}\n`, { encoding: "utf8", mode: 0o644 });
    return {
      created: true,
      privateKeyPath,
      publicKeyPath,
      ...pair,
    };
  }
}
