import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { CapabilityClaims } from "@docslurp/shared";

import { getRequiredEncryptionKey } from "./encryption.js";

/**
 * Sealed search capabilities (`X-DocSlurp-Capability`).
 *
 * A server (or a dashboard session) mints one so a browser can call DocSlurp
 * directly with a bounded page-materialization policy. The token is
 * AES-256-GCM encrypted (confidential and tamper-evident), so claims cannot be
 * read or widened by the holder. Opening is one HKDF-cached key plus one GCM
 * decrypt; liveness of the issuing key is checked by the policy resolver.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Longest token the opener accepts; minting rejects anything larger. */
export const CAPABILITY_MAX_TOKEN_CHARS = 4096;
const AAD = Buffer.from(`docslurp:search-capability:v${VERSION}`);

export const CAPABILITY_HEADER = "X-DocSlurp-Capability";
export const CAPABILITY_MAX_TTL_SECONDS = 3600;

let cachedKey: Buffer | null = null;

/** Same root-secret chain as file tokens, domain-separated by HKDF info. */
function capabilityKey(): Buffer {
  if (cachedKey) return cachedKey;
  let root: Buffer;
  if (process.env.FILE_TOKEN_SECRET?.trim()) root = getRequiredEncryptionKey("FILE_TOKEN_SECRET");
  else if (process.env.SECRETS_ENCRYPTION_KEY?.trim()) root = getRequiredEncryptionKey("SECRETS_ENCRYPTION_KEY");
  else if (process.env.BETTER_AUTH_SECRET?.trim()) root = Buffer.from(process.env.BETTER_AUTH_SECRET.trim(), "utf8");
  else throw new Error("Search capabilities need FILE_TOKEN_SECRET, SECRETS_ENCRYPTION_KEY or BETTER_AUTH_SECRET");
  cachedKey = Buffer.from(hkdfSync("sha256", root, "docslurp-search-capability", "search-capability", 32));
  return cachedKey;
}

/** Test seam: forget the derived key after changing env. */
export function resetCapabilityKeyForTests(): void {
  cachedKey = null;
}

export function sealCapabilityToken(claims: CapabilityClaims): string {
  const body = Buffer.from(JSON.stringify({ ...claims, v: VERSION }), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", capabilityKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The claims of a genuine token. Expiry is NOT judged here so callers can tell
 * `capability_expired` from `capability_invalid`; `openCapabilityToken` below
 * returns null for expired tokens, `peekCapabilityToken` returns them.
 */
export function peekCapabilityToken(token: string): CapabilityClaims | null {
  if (!token || token.length > CAPABILITY_MAX_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", capabilityKey(), raw.subarray(0, IV_BYTES));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    const c = JSON.parse(plain.toString("utf8")) as Partial<CapabilityClaims>;
    if (
      c.v !== VERSION
      || typeof c.orgId !== "string" || !c.orgId
      || !isStringArray(c.workspaceIds)
      || typeof c.policy !== "object" || c.policy === null || Array.isArray(c.policy)
      || typeof c.issuedByKeyId !== "string" || !c.issuedByKeyId
      || (c.boundClientKeyId !== undefined && typeof c.boundClientKeyId !== "string")
      || (c.allowedOrigins !== undefined && !isStringArray(c.allowedOrigins))
      || typeof c.exp !== "number" || !Number.isFinite(c.exp)
      || typeof c.jti !== "string"
    ) {
      return null;
    }
    return {
      v: 1,
      orgId: c.orgId,
      workspaceIds: c.workspaceIds,
      policy: c.policy,
      issuedByKeyId: c.issuedByKeyId,
      ...(c.boundClientKeyId !== undefined ? { boundClientKeyId: c.boundClientKeyId } : {}),
      ...(c.allowedOrigins !== undefined ? { allowedOrigins: c.allowedOrigins } : {}),
      exp: c.exp,
      jti: c.jti,
    };
  } catch {
    return null;
  }
}

/** The claims of a genuine, unexpired token; null for anything else. Never throws. */
export function openCapabilityToken(token: string, nowMs = Date.now()): CapabilityClaims | null {
  const claims = peekCapabilityToken(token);
  return claims && claims.exp * 1000 > nowMs ? claims : null;
}
