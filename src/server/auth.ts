import crypto from "node:crypto";
import type { ConfigStore } from "../config/store.js";
import type { AuthorizedPublicKey } from "../types.js";
import { verifyEd25519Signature } from "./ed25519.js";

export const SESSION_COOKIE_NAME = "acrowly_session";

export function isLoopbackAddress(address?: string): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function signSessionToken(secret: string, ttlSeconds = 30 * 24 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = `${exp}.${nonce}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const payload = `${expStr}.${nonce}`;
  const expectedSig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(val);
  }
  return result;
}

export function checkRequestAuth(
  headers: Record<string, string | string[] | undefined>,
  isRemote: boolean,
  configStore: ConfigStore
): { authenticated: boolean; reason?: string } {
  const config = configStore.getConfig();
  const hasAuthorizedKeys = config.auth.authorizedKeys.length > 0;

  const authHeaderRaw = headers.authorization;
  const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (verifySessionToken(bearer, config.auth.cookieSecret)) {
      return { authenticated: true };
    }
  }

  const cookieHeaderRaw = headers.cookie;
  const cookieHeader = Array.isArray(cookieHeaderRaw) ? cookieHeaderRaw[0] : cookieHeaderRaw;
  const cookies = parseCookies(cookieHeader);
  const sessionToken = cookies[SESSION_COOKIE_NAME];
  if (sessionToken && verifySessionToken(sessionToken, config.auth.cookieSecret)) {
    return { authenticated: true };
  }

  // Local loopback access works before any public key is added so user can pair first key
  if (!hasAuthorizedKeys && !isRemote) {
    return { authenticated: true };
  }

  return {
    authenticated: false,
    reason: hasAuthorizedKeys
      ? "ed25519_key_auth_required"
      : "remote_requires_authorized_key_setup",
  };
}

interface PendingChallenge {
  challengeId: string;
  keyId: string;
  fingerprint: string;
  rawPublicKeyBase64: string;
  label: string;
  nonce: string;
  message: string;
  expiresAtMs: number;
}

export class AuthChallengeStore {
  private challenges = new Map<string, PendingChallenge>();
  private readonly ttlMs = 60_000;
  private readonly maxPending = 1000;

  createChallenge(
    key: AuthorizedPublicKey,
    deviceId: string
  ): { challengeId: string; nonce: string; message: string; expiresAt: string } {
    this.pruneExpired();
    if (this.challenges.size >= this.maxPending) {
      const oldest = this.challenges.keys().next().value;
      if (oldest) this.challenges.delete(oldest);
    }

    const challengeId = `chg_${crypto.randomBytes(12).toString("hex")}`;
    const nonce = crypto.randomBytes(32).toString("base64url");
    const message = `acrowly-auth-v1:${deviceId}:${challengeId}:${nonce}`;
    const expiresAtMs = Date.now() + this.ttlMs;

    this.challenges.set(challengeId, {
      challengeId,
      keyId: key.id,
      fingerprint: key.fingerprint,
      rawPublicKeyBase64: key.rawPublicKeyBase64,
      label: key.label,
      nonce,
      message,
      expiresAtMs,
    });

    return {
      challengeId,
      nonce,
      message,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consumeAndVerify(
    challengeId: string,
    signatureBase64: string,
    configStore: ConfigStore
  ):
    | { ok: true; sessionToken: string; keyId: string; label: string; fingerprint: string }
    | { ok: false; reason: string } {
    this.pruneExpired();
    const pending = this.challenges.get(challengeId);
    if (!pending) {
      return { ok: false, reason: "Challenge expired or not found." };
    }

    this.challenges.delete(challengeId);

    const activeKey = configStore
      .getConfig()
      .auth.authorizedKeys.find((k) => k.id === pending.keyId);
    if (!activeKey) {
      return { ok: false, reason: "Public key is no longer authorized." };
    }

    const valid = verifyEd25519Signature(
      activeKey.rawPublicKeyBase64,
      pending.message,
      signatureBase64
    );
    if (!valid) {
      return { ok: false, reason: "Invalid Ed25519 signature." };
    }

    const sessionToken = signSessionToken(configStore.getConfig().auth.cookieSecret);
    return {
      ok: true,
      sessionToken,
      keyId: activeKey.id,
      label: activeKey.label,
      fingerprint: activeKey.fingerprint,
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, item] of this.challenges.entries()) {
      if (item.expiresAtMs <= now) {
        this.challenges.delete(id);
      }
    }
  }
}

export class AuthRateLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxAttempts = 12,
    private readonly windowMs = 5 * 60_000
  ) {}

  checkAllowed(clientKey: string): { allowed: boolean; retryAfterSec?: number } {
    const now = Date.now();
    const record = this.failures.get(clientKey);
    if (!record) return { allowed: true };
    if (now >= record.resetAt) {
      this.failures.delete(clientKey);
      return { allowed: true };
    }
    if (record.count >= this.maxAttempts) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
      };
    }
    return { allowed: true };
  }

  recordFailure(clientKey: string): void {
    const now = Date.now();
    const existing = this.failures.get(clientKey);
    if (!existing || now >= existing.resetAt) {
      this.failures.set(clientKey, { count: 1, resetAt: now + this.windowMs });
    } else {
      existing.count += 1;
    }
  }

  recordSuccess(clientKey: string): void {
    this.failures.delete(clientKey);
  }
}
