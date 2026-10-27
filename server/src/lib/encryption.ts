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

/** Key IDs are public metadata; key material remains in the environment. */
function currentKeyId(envName: string): string {
  const id = process.env[`${envName}_ID`] ?? "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid ${envName}_ID`);
  return id;
}

function previousKeys(envName: string): Map<string, Buffer> {
  const raw = process.env[`${envName}_PREVIOUS_KEYS`];
  if (!raw) return new Map();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Invalid ${envName}_PREVIOUS_KEYS JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid ${envName}_PREVIOUS_KEYS`);
  if (Object.keys(parsed).length > 16) throw new Error("At most 16 previous encryption keys are allowed");
  const keys = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof value !== "string") throw new Error(`Invalid previous encryption key`);
    const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : decodeBase64Key(value);
    if (!key) throw new Error(`Previous encryption keys must be 32-byte hex or base64 keys`);
    if (id === currentKeyId(envName)) throw new Error(`Current and previous encryption key IDs must differ`);
    keys.set(id, key);
  }
  return keys;
}

export function validateEncryptionConfiguration(envName: string): void {
  getRequiredEncryptionKey(envName);
  currentKeyId(envName);
  previousKeys(envName);
}

export function needsSecretRotation(envName: string, stored: string): boolean {
  openSecret(envName, stored); // Never certify a tampered current-key envelope.
  return !stored.startsWith(`v2:${currentKeyId(envName)}:`);
}

/** AES-GCM envelope with authenticated version and key ID. */
export function sealSecret(envName: string, plaintext: string): string {
  const key = getRequiredEncryptionKey(envName);
  const id = currentKeyId(envName);
  previousKeys(envName); // Fail closed on a malformed rotation configuration.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(`v2:${id}`));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v2:${id}:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

/** Read v2 key IDs and pre-rotation v1/unversioned envelopes. */
export function openSecret(envName: string, stored: string): string {
  const parts = stored.split(":");
  const versioned = parts[0] === "v2";
  const id = versioned ? parts[1]! : null;
  const body = versioned ? parts.slice(2) : parts[0] === ENVELOPE_VERSION ? parts.slice(1) : parts;
  if (body.length !== 3) throw new Error("Invalid encrypted value format");
  const [ivHex, tagHex, ciphertextHex] = body as [string, string, string];
  if (!/^(?:[0-9a-f]{24}|[0-9a-f]{32})$/i.test(ivHex) ||
      !/^[0-9a-f]{32}$/i.test(tagHex) || !/^(?:[0-9a-f]{2})*$/i.test(ciphertextHex)) {
    throw new Error("Invalid encrypted value format");
  }
  const current = getRequiredEncryptionKey(envName);
  const old = previousKeys(envName);
  const keys = versioned
    ? [id === currentKeyId(envName) ? current : old.get(id!)]
    : [current, ...old.values()];
  for (const key of keys) {
    if (!key) continue;
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
      if (versioned) decipher.setAAD(Buffer.from(`v2:${id}`));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]).toString("utf8");
    } catch { /* Only authenticated plaintext is returned. */ }
  }
  throw new Error("Unable to decrypt encrypted value with configured keys");
}
