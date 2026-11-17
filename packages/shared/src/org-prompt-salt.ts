import { hkdfSync, randomBytes } from "node:crypto";

/**
 * Server secret subkeys (HKDF of `EVIDENCE_TAG_KEY`, else `BETTER_AUTH_SECRET`), used for chat evidence tags, and the
 * message layout of private-endpoint chat calls.
 *
 * Model prompts carry no per-organization salt: provider prefix caches are shared across organizations so fixed
 * prefixes stay cache hits (cost and latency). Organization isolation covers data DocSlurp stores and serves, not
 * provider-side prompt caches.
 */

/** Minimum length of an explicit `EVIDENCE_TAG_KEY`; production refuses a shorter one (server config, worker startup, here). */
export const SERVER_SECRET_KEY_MIN_LENGTH = 32;

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

/**
 * The message layout of a private-endpoint chat call.
 *
 * - Default: the instructions are the system message.
 * - A model registered with `systemMessage: false` (its chat template rejects or misreads the system role) gets no
 *   system message: the instructions open the user turn.
 */
export function privateChatLayout(
  model: { systemMessage?: boolean } | null | undefined,
  args: { system?: string; prompt: string },
): { system?: string; prompt: string } {
  if (model?.systemMessage === false) {
    return { prompt: args.system ? `${args.system}\n\n${args.prompt}` : args.prompt };
  }
  return { system: args.system || undefined, prompt: args.prompt };
}
