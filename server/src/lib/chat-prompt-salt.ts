import { resetServerSecretKeysForTests, SERVER_SECRET_KEY_MIN_LENGTH, serverSecretKey } from "@docslurp/shared/org-prompt-salt";

// The server key behind chat evidence tags, derived from one server secret through @docslurp/shared/org-prompt-salt.

/** Minimum length of an explicit `EVIDENCE_TAG_KEY` (production startup refuses a shorter one, config.ts). */
export const EVIDENCE_TAG_KEY_MIN_LENGTH = SERVER_SECRET_KEY_MIN_LENGTH;

/**
 * Key for evidence tags: `EVIDENCE_TAG_KEY`, else derived (HKDF, own label) from `BETTER_AUTH_SECRET`, which startup
 * requires in production. Without either (local development and tests) a per-process random key: tags then stay
 * stable within one process only, which is still safe. A short `EVIDENCE_TAG_KEY` throws in production.
 */
export function evidenceTagKeyBytes(): Buffer {
  return serverSecretKey("docslurp-evidence-tag-v1");
}

/** Test seam: forget the cached keys so a test can change the environment. */
export function resetEvidenceTagKeyForTests(): void {
  resetServerSecretKeysForTests();
}

