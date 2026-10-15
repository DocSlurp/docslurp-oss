import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from "node:crypto";

import { getRequiredEncryptionKey } from "./encryption.js";

/**
 * Opaque, sealed capabilities for the file proxy (`GET /v1/files/:token`).
 *
 * Clients never see storage URLs, bucket names or object keys. A token is
 * AES-256-GCM encrypted (confidential and tamper-evident) and names:
 * - the artifact URI it unlocks,
 * - the user it was issued to,
 * - the credential it was issued under: one Better Auth session or one API key,
 * - an expiry.
 * The proxy accepts it only from that same user, over that same live
 * credential, before expiry, and re-checks document access on every request.
 * A leaked token is useless without the session cookie or key it is bound to.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Tokens longer than this are rejected before any crypto work. */
const MAX_TOKEN_CHARS = 4096;
const AAD = Buffer.from(`docslurp:file-token:v${VERSION}`);

export const FILE_TOKEN_TTL_SECONDS = 3600;
/**
 * Expiry rounds up to this window, so every URL for the same file, user and
 * credential minted within it is identical (no re-download or flicker on
 * polls) and lives between TTL and TTL + window.
 */
export const FILE_TOKEN_WINDOW_SECONDS = 900;

/** `s:<sessionId>` for a cookie session, `k:<apiKeyId>` for an API key. */
export type FileTokenBinding = `s:${string}` | `k:${string}`;

export interface FileTokenClaims {
  /** Artifact URI (s3://bucket/key). */
  uri: string;
  /** User the token was issued to. */
  sub: string;
  /** Credential the token was issued under. */
  bind: FileTokenBinding;
  /** Expiry, unix seconds. */
  exp: number;
  /** Display filename for Content-Disposition and the cosmetic URL suffix. */
  name: string;
}

let cachedKey: Buffer | null = null;
let cachedIvKey: Buffer | null = null;

/**
 * A dedicated key, domain-separated (HKDF) from every other use of its root
 * secret. FILE_TOKEN_SECRET rotates file tokens alone (rotation invalidates
 * every outstanding file URL, nothing else). Otherwise derive from
 * SECRETS_ENCRYPTION_KEY, then BETTER_AUTH_SECRET, which production already
 * requires to be strong (lib/better-auth.ts).
 */
function tokenKey(): Buffer {
  if (cachedKey) return cachedKey;
  let root: Buffer;
  if (process.env.FILE_TOKEN_SECRET?.trim()) root = getRequiredEncryptionKey("FILE_TOKEN_SECRET");
  else if (process.env.SECRETS_ENCRYPTION_KEY?.trim()) root = getRequiredEncryptionKey("SECRETS_ENCRYPTION_KEY");
  else if (process.env.BETTER_AUTH_SECRET?.trim()) root = Buffer.from(process.env.BETTER_AUTH_SECRET.trim(), "utf8");
  else throw new Error("File proxy tokens need FILE_TOKEN_SECRET, SECRETS_ENCRYPTION_KEY or BETTER_AUTH_SECRET");
  cachedKey = Buffer.from(hkdfSync("sha256", root, "docslurp-file-proxy", `file-token-v${VERSION}`, 32));
  cachedIvKey = Buffer.from(hkdfSync("sha256", root, "docslurp-file-proxy", `file-token-iv-v${VERSION}`, 32));
  return cachedKey;
}

function ivKey(): Buffer {
  tokenKey();
  return cachedIvKey!;
}

/** Test seam: forget the derived key after changing env. */
export function resetFileTokenKeyForTests(): void {
  cachedKey = null;
  cachedIvKey = null;
}

/**
 * Deterministic sealing (synthetic IV): the nonce is an HMAC of the whole
 * plaintext under its own key, so equal claims give the same token (a stable
 * URL the viewer and browser can reuse) and a nonce never repeats for
 * different plaintext. The only thing revealed is that two tokens are equal.
 */
export function sealFileToken(claims: FileTokenClaims): string {
  const body = Buffer.from(JSON.stringify({ v: VERSION, uri: claims.uri, sub: claims.sub, bind: claims.bind, exp: claims.exp, name: claims.name }), "utf8");
  const iv = createHmac("sha256", ivKey()).update(body).digest().subarray(0, IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

/** The claims of a genuine, unexpired token; null for anything else. Never throws. */
export function openFileToken(token: string, nowMs = Date.now()): FileTokenClaims | null {
  if (!token || token.length > MAX_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(), raw.subarray(0, IV_BYTES));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    const claims = JSON.parse(plain.toString("utf8")) as Partial<FileTokenClaims> & { v?: number };
    if (
      claims.v !== VERSION
      || typeof claims.uri !== "string"
      || typeof claims.sub !== "string" || !claims.sub
      || typeof claims.bind !== "string" || !/^[sk]:.+/.test(claims.bind)
      || typeof claims.exp !== "number"
      || typeof claims.name !== "string"
    ) {
      return null;
    }
    if (claims.exp * 1000 <= nowMs) return null;
    return { uri: claims.uri, sub: claims.sub, bind: claims.bind as FileTokenBinding, exp: claims.exp, name: claims.name };
  } catch {
    return null;
  }
}
