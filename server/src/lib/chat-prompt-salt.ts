import { createHmac, hkdfSync, randomBytes } from "node:crypto";

// The server key behind chat evidence tags and the per-org chat prompt salt. Its own module so call sites (chat
// agent, direct answers) share it without importing the whole AI client layer.

let evidenceTagKey: Buffer | null = null;

/**
 * Key for evidence tags: `EVIDENCE_TAG_KEY`, else derived (HKDF, own label) from `BETTER_AUTH_SECRET`, which startup
 * requires in production. Without either (local development and tests) a per-process random key: tags then stay
 * stable within one process only, which is still safe.
 */
/** Minimum length of an explicit `EVIDENCE_TAG_KEY` (production startup refuses a shorter one, config.ts). */
export const EVIDENCE_TAG_KEY_MIN_LENGTH = 32;

export function evidenceTagKeyBytes(): Buffer {
  if (evidenceTagKey) return evidenceTagKey;
  const explicit = process.env.EVIDENCE_TAG_KEY?.trim();
  if (explicit && explicit.length < EVIDENCE_TAG_KEY_MIN_LENGTH) {
    // Fail closed: a short key would make tags guessable. Startup refuses it in production; this guards other callers.
    if (process.env.NODE_ENV === "production") throw new Error(`EVIDENCE_TAG_KEY must be at least ${EVIDENCE_TAG_KEY_MIN_LENGTH} characters`);
    console.warn(`[evidence-tag] EVIDENCE_TAG_KEY shorter than ${EVIDENCE_TAG_KEY_MIN_LENGTH} characters is ignored`);
  }
  const secret = (explicit && explicit.length >= EVIDENCE_TAG_KEY_MIN_LENGTH ? explicit : undefined) || process.env.BETTER_AUTH_SECRET?.trim();
  evidenceTagKey = secret ? Buffer.from(hkdfSync("sha256", secret, "", "docslurp-evidence-tag-v1", 32)) : randomBytes(32);
  return evidenceTagKey;
}

/** Test seam: forget the cached key so a test can change the environment. */
export function resetEvidenceTagKeyForTests(): void {
  evidenceTagKey = null;
}

/**
 * First line of a hosted chat system prompt: an org-keyed salt (HMAC under the evidence-tag key). Every tenant shares
 * one provider account, so a cached system prefix that starts with tenant text (project name, chat instructions)
 * would let one org detect another's identical text through cache hits. Starting each org's prefix with its own salt
 * keeps reuse within the org and makes prefixes differ across orgs. No scope: a random line, so nothing is shared.
 */
export function chatSystemSaltLine(scope: string | null | undefined): string {
  const salt = scope
    ? createHmac("sha256", evidenceTagKeyBytes()).update("chat-prefix").update("\0").update(scope).digest("hex").slice(0, 16)
    : randomBytes(8).toString("hex");
  return `Workspace ${salt}.`;
}
