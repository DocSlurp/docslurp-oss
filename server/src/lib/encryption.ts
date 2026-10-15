import { createHash } from "node:crypto";

const disallowedDefaults = new Set([
  "dev-secrets-key-change-me-in-production",
  "insecure-dev-key-replace-in-prod"
]);

export function getRequiredEncryptionKey(envName: string): Buffer {
  const raw = process.env[envName]?.trim();
  if (!raw || disallowedDefaults.has(raw)) {
    throw new Error(`${envName} must be configured with a non-default value`);
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  return createHash("sha256").update(raw, "utf8").digest();
}
