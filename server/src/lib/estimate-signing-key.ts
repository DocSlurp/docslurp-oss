import { createHash, createHmac, randomBytes } from "node:crypto";

import { WEAK_SECRET_VALUES } from "./weak-secrets.js";

/**
 * The key cost-estimate signatures (`signature` / `confirmEstimate` on project changes and reindexes) are MACed with.
 *
 * Every process that signs or verifies an estimate (the API, the standalone server, the chat executor, whose chat
 * proposals plan project changes) must resolve the same key, or a signature made on one is refused as `estimate_stale`
 * on another. Order: `DOCSLURP_ESTIMATE_SIGNING_SECRET` (dedicated, at least 32 characters, preferred), then the
 * fallbacks `SECRETS_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `FILE_TOKEN_SECRET` (production already requires the first
 * two, so a deployment whose processes do not share them must set the dedicated secret on every one). Production
 * refuses to start without a stable key; development and tests use a per-process random key and warn once.
 * The value is never logged: only the variable name and a fingerprint (an HMAC under the key, which reveals nothing
 * about it) so operators can check that every process resolved the same key.
 */
export const ESTIMATE_SIGNING_SECRET_ENV = "DOCSLURP_ESTIMATE_SIGNING_SECRET";
export const ESTIMATE_SIGNING_SECRET_MIN_LENGTH = 32;
const FALLBACK_SOURCES = ["SECRETS_ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "FILE_TOKEN_SECRET"] as const;

export type EstimateSigningKeySource = typeof ESTIMATE_SIGNING_SECRET_ENV | (typeof FALLBACK_SOURCES)[number] | "random";
type Env = Record<string, string | undefined>;

export class EstimateSigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EstimateSigningKeyError";
  }
}

/** Which variable supplies the key, without reading the key itself; throws on a dedicated secret that is too short or weak. */
export function estimateSigningKeySource(env: Env = process.env): EstimateSigningKeySource {
  const dedicated = env[ESTIMATE_SIGNING_SECRET_ENV]?.trim();
  if (dedicated !== undefined && dedicated !== "") {
    if (dedicated.length < ESTIMATE_SIGNING_SECRET_MIN_LENGTH) {
      throw new EstimateSigningKeyError(`${ESTIMATE_SIGNING_SECRET_ENV} must be at least ${ESTIMATE_SIGNING_SECRET_MIN_LENGTH} characters`);
    }
    if (env.NODE_ENV === "production" && WEAK_SECRET_VALUES.has(dedicated)) {
      throw new EstimateSigningKeyError(`${ESTIMATE_SIGNING_SECRET_ENV} must be a strong, non-default value in production`);
    }
    return ESTIMATE_SIGNING_SECRET_ENV;
  }
  for (const name of FALLBACK_SOURCES) if (env[name]?.trim()) return name;
  return "random";
}

/**
 * Startup check for every process that signs or verifies estimates. Throws (the process must not start) when the
 * dedicated secret is too short or weak, or in production when no stable key resolves. Returns the source.
 */
export function assertEstimateSigningKeyConfigured(env: Env = process.env): EstimateSigningKeySource {
  const source = estimateSigningKeySource(env);
  if (source === "random" && env.NODE_ENV === "production") {
    throw new EstimateSigningKeyError(
      `${ESTIMATE_SIGNING_SECRET_ENV} is required in production (at least ${ESTIMATE_SIGNING_SECRET_MIN_LENGTH} characters, the same value on every API and chat-executor process); `
      + `no ${FALLBACK_SOURCES.join(", ")} fallback is set either, and estimate signatures never use a per-process key in production`,
    );
  }
  return source;
}

// Only the random development key is cached (it must hold for the process); a stable key is derived on every call
// from the env it is given, so a call with another env never returns a key cached for a different one.
let randomKey: Buffer | null = null;
let warnedRandom = false;

/** The derived signing key for `env`. Production never gets a random key: it throws instead. */
export function estimateSigningKey(env: Env = process.env): Buffer {
  const source = assertEstimateSigningKeyConfigured(env);
  if (source === "random") {
    if (!warnedRandom) {
      warnedRandom = true;
      console.warn(`[estimate-signing] no ${ESTIMATE_SIGNING_SECRET_ENV} (or ${FALLBACK_SOURCES.join(", ")}) set: using a per-process random key; estimate signatures hold for this process only`);
    }
    randomKey ??= randomBytes(32);
    return randomKey;
  }
  const secret = env[source]!.trim();
  // The dedicated secret gets its own label; the fallbacks keep the #500 derivation so outstanding signatures survive.
  const label = source === ESTIMATE_SIGNING_SECRET_ENV ? "docslurp:estimate-signature:v1" : "docslurp:reindex-estimate-signature";
  return createHash("sha256").update(`${label}:${secret}`).digest();
}

/**
 * A non-secret fingerprint of the resolved key: the first 12 hex characters of HMAC(key, "docslurp:estimate-key-fingerprint").
 * Equal on two processes exactly when they sign alike; it reveals nothing usable about the key.
 */
export function estimateSigningKeyFingerprint(env: Env = process.env): string {
  return createHmac("sha256", estimateSigningKey(env)).update("docslurp:estimate-key-fingerprint").digest("hex").slice(0, 12);
}

/** The operator-facing description (never the value). */
export function estimateSigningKeyReport(env: Env = process.env): { source: EstimateSigningKeySource; fingerprint: string } {
  return { source: assertEstimateSigningKeyConfigured(env), fingerprint: estimateSigningKeyFingerprint(env) };
}

/** The startup log line every signing process prints: `[<prefix>] estimate signing key source=<variable> fingerprint=<12 hex>`. */
export function estimateSigningKeyLogLine(prefix: string, env: Env = process.env): string {
  const { source, fingerprint } = estimateSigningKeyReport(env);
  return `[${prefix}] estimate signing key source=${source} fingerprint=${fingerprint}`;
}

/** Test hook: forget the random development key (as a fresh process would). */
export function resetEstimateSigningKeyForTests(): void {
  randomKey = null;
  warnedRandom = false;
}
