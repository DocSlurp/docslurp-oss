import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const disallowedDefaults = new Set([
  "dev-secrets-key-change-me-in-production",
  "insecure-dev-key-replace-in-prod"
]);

const ALGORITHM = "aes-256-gcm";
/** 96-bit IV, the size AES-GCM is specified for (SEC-2026-10-19). */
const IV_BYTES = 12;
/** Envelope version for at-rest ciphertext, so keys can be rotated (SEC-2026-10-05). */
const ENVELOPE_VERSION = "v1";

function decodeBase64Key(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) return null;
  if (decoded.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) return null;
  return decoded;
}

export function getRequiredEncryptionKey(envName: string): Buffer {
  const raw = process.env[envName]?.trim();
  if (!raw || disallowedDefaults.has(raw)) {
    throw new Error(`${envName} must be configured with a non-default value`);
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const base64 = decodeBase64Key(raw);
  if (base64) {
    return base64;
  }

  // A passphrase hashed with a single round of SHA-256 has no work factor, so a
  // database dump would let an attacker recover the key at hash speed
  // (SEC-2026-10-04). Require a full-entropy 32-byte key in production; local
  // development keeps the convenience derivation.
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${envName} must be a 32-byte key: 64 hex characters (openssl rand -hex 32) or 32 base64 bytes`);
  }

  return createHash("sha256").update(raw, "utf8").digest();
}

/**
 * AES-256-GCM seal with a versioned envelope: `v1:<iv>:<tag>:<ciphertext>` (hex).
 * The version prefix lets a future rotation read old and new ciphertext side by
 * side (SEC-2026-10-05).
 */
export function sealSecret(envName: string, plaintext: string): string {
  const key = getRequiredEncryptionKey(envName);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Open a sealed value. Accepts the versioned envelope and legacy rows written as
 * `iv:tag:ciphertext` (with 12- or 16-byte IVs), so existing ciphertext keeps
 * working until it is re-encrypted under the current key.
 */
export function openSecret(envName: string, stored: string): string {
  const parts = stored.split(":");
  const body = parts[0] === ENVELOPE_VERSION ? parts.slice(1) : parts;
  if (body.length !== 3) {
    throw new Error("Invalid encrypted value format");
  }

  const [ivHex, tagHex, ciphertextHex] = body as [string, string, string];
  const key = getRequiredEncryptionKey(envName);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]).toString("utf8");
}
