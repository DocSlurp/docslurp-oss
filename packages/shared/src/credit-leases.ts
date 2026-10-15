/**
 * Org-level credit leases (docs/pricing-and-credits.md, "Credit leases";
 * migration 0052). The app (first lease at run admission and resume) and the
 * worker (consume, renew, pause) read the same configuration, so both sides
 * agree on whether leases are on and how they are sized.
 *
 * Off in production unless WORKER_CREDIT_LEASES=on; on everywhere else unless
 * WORKER_CREDIT_LEASES=off. With leases off the worker keeps the
 * WORKER_SPEND_CHECK_PAGES / _CREDITS cadence check unchanged.
 */

export interface CreditLeaseConfig {
  enabled: boolean;
  /** Smallest useful lease, about one batch or one Deep page (credits). */
  minCredits: number;
  /** Largest lease a single run holds (credits). */
  maxCredits: number;
  /** First lease, before the run has a burn rate (credits). */
  initialCredits: number;
  /** At most this fraction of the org's free credits per grant. */
  fraction: number;
  /** Size leases to cover this many seconds of the run's burn rate. */
  horizonSeconds: number;
  /** Lease TTL; checkpoints extend it, a crashed worker's lease lapses after it. */
  ttlSeconds: number;
  /** Renew (in the background) once this fraction of the lease is used. */
  renewAt: number;
}

type Env = Record<string, string | undefined>;

function readNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function resolveCreditLeaseConfig(env: Env = process.env): CreditLeaseConfig {
  const flag = (env.WORKER_CREDIT_LEASES ?? "").trim().toLowerCase();
  const enabled = flag === ""
    ? env.NODE_ENV !== "production"
    : ["on", "true", "1", "yes"].includes(flag);
  const minCredits = readNumber(env, "WORKER_CREDIT_LEASE_MIN_CREDITS", 0.5, 0.01, 1_000);
  const maxCredits = readNumber(env, "WORKER_CREDIT_LEASE_MAX_CREDITS", 500, minCredits, 1_000_000);
  return {
    enabled,
    minCredits,
    maxCredits,
    initialCredits: readNumber(env, "WORKER_CREDIT_LEASE_INITIAL_CREDITS", 10, minCredits, maxCredits),
    fraction: readNumber(env, "WORKER_CREDIT_LEASE_FRACTION", 0.25, 0.01, 1),
    horizonSeconds: readNumber(env, "WORKER_CREDIT_LEASE_HORIZON_SECONDS", 30, 1, 3_600),
    ttlSeconds: Math.round(readNumber(env, "WORKER_CREDIT_LEASE_TTL_SECONDS", 300, 5, 86_400)),
    renewAt: readNumber(env, "WORKER_CREDIT_LEASE_RENEW_AT", 0.8, 0.1, 1),
  };
}

/**
 * The lease target grant_credit_lease() computes (kept in step with the SQL,
 * for the simulation and for docs):
 *   clamp(min(fraction * free, burn * horizon), min, max), never above free,
 * where free = available - other live leases, and burn is credits per second
 * since the last grant (null: no history yet, use initialCredits).
 */
export function creditLeaseTarget(args: {
  free: number;
  burnPerSecond: number | null;
  config: Pick<CreditLeaseConfig, "minCredits" | "maxCredits" | "initialCredits" | "fraction" | "horizonSeconds">;
}): number {
  const { config } = args;
  const free = Math.max(args.free, 0);
  const wanted = args.burnPerSecond === null ? config.initialCredits : args.burnPerSecond * config.horizonSeconds;
  const target = Math.min(Math.max(Math.min(config.fraction * free, wanted), config.minCredits), config.maxCredits);
  return Math.min(target, free);
}
