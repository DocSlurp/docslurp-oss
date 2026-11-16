import { createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Per-organization salt for hosted and shared-endpoint model prompts that carry tenant content. This is the one salt
 * helper for server and worker (the server's `chatSystemSaltLine` is `orgPromptSaltLine`).
 *
 * Every organization shares DocSlurp's provider accounts, and providers (and shared vLLM endpoints) cache repeated
 * prompt prefixes automatically. A prompt whose prefix is tenant content (a document, a page image, chunks, a query,
 * project instructions) would let one organization detect, by latency or a cache discount, that another recently sent
 * the same content. Starting every such prompt with a value keyed by the organization (HMAC under a server secret, so
 * it cannot be computed from an org id) keeps provider cache reuse inside one organization. Requests that cannot carry
 * a leading line send the same value as the endpoint's cache-isolation field (vLLM `cache_salt`).
 *
 * Without an organization the salt is random, so nothing is shared.
 */

/** Minimum length of an explicit `EVIDENCE_TAG_KEY`; production refuses a shorter one (server config, worker startup, here). */
export const SERVER_SECRET_KEY_MIN_LENGTH = 32;

const ORG_PROMPT_SALT_LABEL = "docslurp-org-prompt-salt-v1";

const derivedKeys = new Map<string, Buffer>();
let warnedShortKey = false;

/**
 * A 32-byte key for `label`, derived (HKDF) from `EVIDENCE_TAG_KEY`, else from `BETTER_AUTH_SECRET`, else random per
 * process (safe: values then match only within one process). An explicit `EVIDENCE_TAG_KEY` shorter than
 * {@link SERVER_SECRET_KEY_MIN_LENGTH} is refused in production (a short key makes the HMAC guessable) and ignored,
 * with a warning, elsewhere.
 */
export function serverSecretKey(label: string): Buffer {
  const cached = derivedKeys.get(label);
  if (cached) return cached;
  const explicit = process.env.EVIDENCE_TAG_KEY?.trim();
  if (explicit && explicit.length < SERVER_SECRET_KEY_MIN_LENGTH) {
    // Fail closed: production startup refuses it too (server config.ts, worker startup); this guards other callers.
    if (process.env.NODE_ENV === "production") throw new Error(`EVIDENCE_TAG_KEY must be at least ${SERVER_SECRET_KEY_MIN_LENGTH} characters`);
    if (!warnedShortKey) {
      warnedShortKey = true;
      console.warn(`[server-secret] EVIDENCE_TAG_KEY shorter than ${SERVER_SECRET_KEY_MIN_LENGTH} characters is ignored`);
    }
  }
  const secret = (explicit && explicit.length >= SERVER_SECRET_KEY_MIN_LENGTH ? explicit : undefined) || process.env.BETTER_AUTH_SECRET?.trim();
  const key = secret ? Buffer.from(hkdfSync("sha256", secret, "", label, 32)) : randomBytes(32);
  derivedKeys.set(label, key);
  return key;
}

/** Startup check: throws in production when `EVIDENCE_TAG_KEY` is set but too short, before any job runs. */
export function assertServerSecretKeyConfig(env: NodeJS.ProcessEnv = process.env): void {
  const explicit = env.EVIDENCE_TAG_KEY?.trim();
  if (env.NODE_ENV === "production" && explicit && explicit.length < SERVER_SECRET_KEY_MIN_LENGTH) {
    throw new Error(`EVIDENCE_TAG_KEY must be at least ${SERVER_SECRET_KEY_MIN_LENGTH} characters`);
  }
}

/** Test seam: forget every derived key after changing the environment. */
export function resetServerSecretKeysForTests(): void {
  derivedKeys.clear();
  warnedShortKey = false;
}

/** Test seam (alias of {@link resetServerSecretKeysForTests}). */
export const resetOrgPromptSaltKeyForTests = resetServerSecretKeysForTests;

/** The org's 16-hex salt (stable per org and key), or a fresh random one when there is no organization. */
export function orgPromptSalt(orgId: string | null | undefined): string {
  const org = typeof orgId === "string" ? orgId.trim() : "";
  return org
    ? createHmac("sha256", serverSecretKey(ORG_PROMPT_SALT_LABEL)).update("org-prompt").update("\0").update(org).digest("hex").slice(0, 16)
    : randomBytes(8).toString("hex");
}

/** The org's salt line: the first line of a prompt that carries tenant content. */
export function orgPromptSaltLine(orgId: string | null | undefined): string {
  return `Workspace ${orgPromptSalt(orgId)}.`;
}

/** `system` with the org salt line first. */
export function withOrgPromptSalt(orgId: string | null | undefined, system: string | undefined): string {
  return [orgPromptSaltLine(orgId), system].filter(Boolean).join("\n\n");
}

/**
 * The message layout of a private-endpoint chat call for one organization.
 *
 * - Default: the salt line opens the system message, before any instructions.
 * - A model registered with `systemMessage: false` (its chat template rejects or misreads the system role) gets no
 *   system message: the instructions open the user turn, and the salt goes as `cache_salt` (pass
 *   `orgPromptSalt(orgId)` as `cacheSalt` to `authorizePrivateModelCall`), which keys vLLM's prefix cache per
 *   organization without adding a token. Such an endpoint must accept `cache_salt` (vLLM does).
 */
export function privateChatLayout(
  model: { systemMessage?: boolean } | null | undefined,
  args: { orgId: string | null | undefined; system?: string; prompt: string },
): { system?: string; prompt: string } {
  if (model?.systemMessage === false) {
    return { prompt: args.system ? `${args.system}\n\n${args.prompt}` : args.prompt };
  }
  return { system: withOrgPromptSalt(args.orgId, args.system), prompt: args.prompt };
}
