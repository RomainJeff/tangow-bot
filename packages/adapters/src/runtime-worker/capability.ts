import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sameWorker, type WorkerIdentity, WorkerIdentitySchema } from "@rakazo/adapter-kit";
import { z } from "zod";
import { WORKER_LIMITS } from "./limits.js";

/**
 * A guest's proof of which attempt it serves: `rkw1.<claims>.<HMAC-SHA256>`, base64url. The key
 * lives in one controller process's memory, so a controller restart revokes every capability,
 * as it already ends every attempt. Verification is pure, so a hello is checked before any read.
 */
const PREFIX = "rkw1.";
const MAX_TOKEN_LENGTH = 512;

const ClaimsSchema = z.strictObject({
  runId: WorkerIdentitySchema.shape.runId,
  attemptId: WorkerIdentitySchema.shape.attemptId,
  fence: WorkerIdentitySchema.shape.fence,
  expiresAt: z.number().int().positive(),
});

declare const capabilityKey: unique symbol;
export type CapabilityKey = Uint8Array & { readonly [capabilityKey]: true };

export function createCapabilityKey(): CapabilityKey {
  return randomBytes(32) as Uint8Array as CapabilityKey;
}

export type CapabilityRefusal = "malformed" | "signature" | "expired" | "identity";

function sign(key: CapabilityKey, claims: string): Buffer {
  return createHmac("sha256", key).update(claims).digest();
}

export function mintCapability(key: CapabilityKey, worker: WorkerIdentity, now: number): string {
  const claims = Buffer.from(
    JSON.stringify({ ...worker, expiresAt: now + WORKER_LIMITS.capabilityTtlMs }),
  ).toString("base64url");
  return `${PREFIX}${claims}.${sign(key, claims).toString("base64url")}`;
}

function readClaims(token: string): { claims: string; mac: string } | null {
  if (token.length > MAX_TOKEN_LENGTH || !token.startsWith(PREFIX)) return null;
  const [claims, mac, extra] = token.slice(PREFIX.length).split(".");
  if (!claims || !mac || extra !== undefined) return null;
  return { claims, mac };
}

function decodeClaims(claims: string) {
  try {
    const parsed = ClaimsSchema.safeParse(
      JSON.parse(Buffer.from(claims, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The MAC is checked before the claims are parsed, and compared in constant time. */
export function verifyCapability(
  key: CapabilityKey,
  token: string,
  expected: WorkerIdentity,
  now: number,
): { ok: true } | { ok: false; reason: CapabilityRefusal } {
  const parts = readClaims(token);
  if (!parts) return { ok: false, reason: "malformed" };
  const expectedMac = sign(key, parts.claims);
  const mac = Buffer.from(parts.mac, "base64url");
  if (mac.length !== expectedMac.length || !timingSafeEqual(mac, expectedMac)) {
    return { ok: false, reason: "signature" };
  }
  const claims = decodeClaims(parts.claims);
  if (!claims) return { ok: false, reason: "malformed" };
  if (now >= claims.expiresAt) return { ok: false, reason: "expired" };
  return sameWorker(claims, expected) ? { ok: true } : { ok: false, reason: "identity" };
}

/** The identity a capability claims, unverified: how a guest learns whom it speaks for. */
export function capabilityWorker(token: string): WorkerIdentity | null {
  const parts = readClaims(token);
  const claims = parts && decodeClaims(parts.claims);
  return claims ? { runId: claims.runId, attemptId: claims.attemptId, fence: claims.fence } : null;
}
