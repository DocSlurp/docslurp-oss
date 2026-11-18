import { createHash, randomBytes } from "node:crypto";

/**
 * The key cost-estimate signatures (`signature` / `confirmEstimate` on project changes and reindexes) are MACed with.
 *
 * Every process that signs or verifies an estimate (the API, the standalone server, the chat executor, whose chat
 * proposals plan project changes) must resolve the same key, or a signature made on one is refused as `estimate_stale`
 * on another. Order: `DOCSLURP_ESTIMATE_SIGNING_SECRET` (dedicated, at least 32 characters), then the self-hosting
 * fallbacks `SECRETS_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `FILE_TOKEN_SECRET`. Production refuses to start without one;
 * development and tests use a per-process random key (signatures then hold for that process only) and warn once.
 * The value is never logged; only the variable name is.
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

/** Which variable supplies the key, without reading the key itself; throws on a dedicated secret that is too short. */
export function estimateSigningKeySource(env: Env = process.env): EstimateSigningKeySource {
  const dedicated = env[ESTIMATE_SIGNING_SECRET_ENV]?.trim();
  if (dedicated !== undefined && dedicated !== "") {
    if (dedicated.length < ESTIMATE_SIGNING_SECRET_MIN_LENGTH) {
      throw new EstimateSigningKeyError(`${ESTIMATE_SIGNING_SECRET_ENV} must be at least ${ESTIMATE_SIGNING_SECRET_MIN_LENGTH} characters`);
    }
    return ESTIMATE_SIGNING_SECRET_ENV;
  }
  for (const name of FALLBACK_SOURCES) if (env[name]?.trim()) return name;
  return "random";
}

/**
 * Startup check for every process that signs or verifies estimates. Throws (the process must not start) when the
 * dedicated secret is too short, or in production when no stable key resolves. Returns the source for a startup log.
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

let cached: { key: Buffer; source: EstimateSigningKeySource } | null = null;
let warnedRandom = false;

/** The derived signing key (cached per process). Production never gets a random key: it throws instead. */
export function estimateSigningKey(env: Env = process.env): Buffer {
  if (cached) return cached.key;
  const source = assertEstimateSigningKeyConfigured(env);
  if (source === "random") {
    if (!warnedRandom) {
      warnedRandom = true;
      console.warn(`[estimate-signing] no ${ESTIMATE_SIGNING_SECRET_ENV} (or ${FALLBACK_SOURCES.join(", ")}) set: using a per-process random key; estimate signatures hold for this process only`);
    }
    cached = { key: randomBytes(32), source };
    return cached.key;
  }
  const secret = env[source]!.trim();
  // The dedicated secret gets its own label; the fallbacks keep the #500 derivation so outstanding signatures survive.
  const label = source === ESTIMATE_SIGNING_SECRET_ENV ? "docslurp:estimate-signature:v1" : "docslurp:reindex-estimate-signature";
  cached = { key: createHash("sha256").update(`${label}:${secret}`).digest(), source };
  return cached.key;
}

/** Test hook: forget the cached key (as a fresh process would). */
export function resetEstimateSigningKeyForTests(): void {
  cached = null;
  warnedRandom = false;
}
