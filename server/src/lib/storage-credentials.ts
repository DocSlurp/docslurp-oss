/**
 * Production validation for object-storage credentials.
 *
 * Access key IDs are identifiers, not secrets, and are short on real providers
 * (AWS IAM: 20 chars, B2: 25, R2: 32 hex, Tigris: `tid_...`), so the generic
 * 24-character secret floor must not apply to them. The goal is to reject
 * dev/placeholder values such as MinIO's default `minioadmin`.
 */

const PLACEHOLDER_ACCESS_KEYS = new Set([
  "minioadmin",
  "minio",
  "admin",
  "root",
  "test",
  "testtest",
  "docslurp",
  "password",
  "changeme",
  "access-key",
  "accesskey",
  "your-access-key",
]);

/** Shortest access key ID any supported provider issues is AWS's 20; keep headroom. */
export const MIN_ACCESS_KEY_ID_LENGTH = 16;

/** Returns a problem description, or null when the access key ID is acceptable. */
export function storageAccessKeyIdProblem(value: string | undefined): string | null {
  const key = value?.trim();
  if (!key) return "is required";
  if (PLACEHOLDER_ACCESS_KEYS.has(key.toLowerCase())) return "is a known placeholder value";
  if (/example|placeholder|changeme|change-me/i.test(key)) return "looks like a placeholder or documentation example";
  if (key.length < MIN_ACCESS_KEY_ID_LENGTH) return `must be at least ${MIN_ACCESS_KEY_ID_LENGTH} characters`;
  if (/\s/.test(key)) return "must not contain whitespace";
  if (new Set(key).size < 6) return "has too little variety to be a real key";
  return null;
}
