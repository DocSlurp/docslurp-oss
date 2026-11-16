import { orgPromptSaltLine, resetServerSecretKeysForTests, SERVER_SECRET_KEY_MIN_LENGTH, serverSecretKey } from "@docslurp/shared/org-prompt-salt";

// The server key behind chat evidence tags, and the per-org prompt salt. Both derive from one server secret through
// @docslurp/shared/org-prompt-salt (same key handling, own HKDF labels), so server and worker salt identically.

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

/**
 * First line of a hosted chat system prompt: the org's prompt salt (`orgPromptSaltLine`). Every tenant shares one
 * provider account, so a cached system prefix that starts with tenant text (project name, chat instructions) would let
 * one org detect another's identical text through cache hits. No scope: a random line, so nothing is shared.
 */
export function chatSystemSaltLine(scope: string | null | undefined): string {
  return orgPromptSaltLine(scope);
}
