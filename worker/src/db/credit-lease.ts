import type { Sql } from "postgres";

import { isBillingExemptOrg, resolveCreditLeaseConfig, type CreditLeaseConfig } from "@docslurp/shared";

import { chatReserveConfig } from "./chat-reserve.js";

import { enforceRunSpend, pauseRunForSpend, spendCheckConfig, type SpendCheckResult } from "./spend-check.js";

/**
 * Org-level credit leases (WORKER_CREDIT_LEASES; migration 0052). Replaces the
 * fixed-cadence mid-run balance check when on.
 *
 * Holder granularity: one lease per run, shared by every worker process that
 * checkpoints the run's pages. Consumption is an atomic increment on the lease
 * row inside the checkpoint transaction that already locks the run row and
 * enqueues the run's credit debit, so:
 *  - concurrent consumers (page tasks on many workers, embed batches, shards)
 *    cannot double-spend the same lease amount: each adds its own cost;
 *  - available and outstanding fall in the same commit, so the org invariant
 *    (live leases <= available, enforced at grant) holds while runs spend;
 *  - the run row is the only extra contention point, and it is already locked
 *    by every checkpoint of the run.
 * A lease per worker process would fragment a small balance across idle
 * processes (an org with 50 cents and 20 workers would strand most of it) and
 * multiply rows and grants; a lease per run keeps the lease count equal to the
 * number of active runs.
 *
 * "Local" spending: each process keeps the lease's last known remaining per
 * run. Hot paths (embed batches) compare it with the run's unflushed billable
 * usage and checkpoint early when the lease would run out, so a renewal (or a
 * pause) happens at exhaustion rather than at the next throttled write.
 * Renewal runs in the background once `renewAt` of the lease is used; the
 * caller waits only when the lease is already exhausted. A refused renewal
 * pauses the run exactly like the cadence check (spend-check.ts).
 */

type Client = Sql<Record<string, unknown>>;

/** grant_credit_lease() as this worker calls it (migration 0053 signature). */
const GRANT_CREDIT_LEASE_SIGNATURE =
  "grant_credit_lease(text,text,text,text,numeric,numeric,numeric,numeric,numeric,integer,boolean,numeric,numeric)";

let cachedConfig: CreditLeaseConfig | null = null;

export function creditLeaseConfig(): CreditLeaseConfig {
  cachedConfig ??= resolveCreditLeaseConfig();
  return cachedConfig;
}

/** Test hook. */
export function setCreditLeaseConfig(config: CreditLeaseConfig | null): void {
  cachedConfig = config;
}

/** Leases replace the cadence check when both spend checks and leases are on. */
export function creditLeasesActive(): boolean {
  return spendCheckConfig().enabled && creditLeaseConfig().enabled;
}

export interface LeaseRun {
  id: string;
  orgId: string | null;
  workspaceId?: string | null;
  userId: string;
}

export interface LeaseObservation {
  live: boolean;
  remaining: number;
  leaseSize: number;
}

export interface LeaseGrant {
  remaining: number;
  leaseSize: number;
  added: number;
  available: number;
  outstanding: number;
  blockReason: string | null;
}

/**
 * Consume `credits` from the run's lease. Call inside the checkpoint
 * transaction that enqueues the same credits as a debit. Extends a live
 * lease's TTL (the heartbeat) but never revives an expired or revoked one.
 * Returns null when the run has no lease row yet.
 */
export async function consumeRunCreditLease(
  client: Client,
  run: Pick<LeaseRun, "id" | "orgId">,
  credits: number,
): Promise<LeaseObservation | null> {
  if (!run.orgId) return null;
  const amount = Number.isFinite(credits) ? Math.max(0, credits) : 0;
  const ttlSeconds = creditLeaseConfig().ttlSeconds;
  const [row] = await client<{ live: boolean; remaining: string | number; lease_size: string | number }[]>`
    update credit_leases
    set consumed = consumed + ${amount}::numeric,
        expires_at = case
          when status = 'active' and expires_at > now()
            then greatest(expires_at, now() + ${ttlSeconds} * interval '1 second')
          else expires_at
        end,
        updated_at = now()
    where holder_kind = 'run' and holder_id = ${run.id} and org_id = ${run.orgId}
    returning (status = 'active' and expires_at > now()) as live,
      granted - consumed as remaining,
      lease_size
  `;
  if (!row) return null;
  return { live: row.live, remaining: Number(row.remaining), leaseSize: Number(row.lease_size) };
}

/** grant_credit_lease() for a run, sized by `config`. */
export async function grantRunCreditLease(
  client: Client,
  run: Pick<LeaseRun, "id" | "orgId" | "workspaceId">,
  config: CreditLeaseConfig = creditLeaseConfig(),
): Promise<LeaseGrant> {
  if (!run.orgId) throw new Error("grantRunCreditLease: run has no org");
  const [row] = await client<{
    lease_remaining: string | number;
    lease_credits: string | number;
    added_credits: string | number;
    available_credits: string | number;
    outstanding_credits: string | number;
    block_reason: string | null;
  }[]>`
    select * from grant_credit_lease(
      ${run.orgId}::text, ${run.workspaceId ?? null}::text, 'run', ${run.id}::text,
      ${config.minCredits}::numeric, ${config.maxCredits}::numeric, ${config.initialCredits}::numeric,
      ${config.fraction}::numeric, ${config.horizonSeconds}::numeric, ${config.ttlSeconds}::int,
      ${isBillingExemptOrg(run.orgId)}::boolean,
      ${chatReserveConfig().fundedReserveCredits}::numeric, ${chatReserveConfig().starterReserveCredits}::numeric
    )
  `;
  return {
    remaining: Number(row?.lease_remaining ?? 0),
    leaseSize: Number(row?.lease_credits ?? 0),
    added: Number(row?.added_credits ?? 0),
    available: Number(row?.available_credits ?? 0),
    outstanding: Number(row?.outstanding_credits ?? 0),
    // grant_credit_lease() always returns one row or raises.
    blockReason: row ? row.block_reason : "credit_exhausted",
  };
}

interface LocalLease {
  remaining: number;
  leaseSize: number;
  /** The last renewal was refused: the run is (being) paused, stop forcing checkpoints. */
  blocked: boolean;
  seenAt: number;
  renewing: Promise<LeaseGrant | null> | null;
}

const LOCAL_TTL_MS = 15 * 60_000;

/**
 * Per-process view of the leases of the runs this worker checkpoints. One
 * instance per Store, shared by its page-task store.
 */
export class RunCreditLeases {
  private readonly runs = new Map<string, LocalLease>();
  /** Balance queries (grants) issued, for logs and tests. */
  grants = 0;
  private schema: { ready: boolean; checkedAt: number } | null = null;

  constructor(private readonly sql: Client) {}

  /**
   * Leases are on and migrations 0052 and 0053 are applied. A worker deployed
   * with the flag before the migrations keeps the cadence path instead of
   * failing its checkpoints (re-checked every 5 minutes until they exist).
   * Also decides whether the worker advertises billing.credit-leases
   * (worker-capabilities.ts).
   */
  async active(): Promise<boolean> {
    if (!creditLeasesActive()) return false;
    const now = Date.now();
    if (this.schema && (this.schema.ready || now - this.schema.checkedAt < 5 * 60_000)) return this.schema.ready;
    try {
      // 0052 (table) and 0053 (grant_credit_lease with the chat reserve
      // arguments this worker passes); either missing keeps the cadence check.
      const [row] = await this.sql<{ ready: boolean }[]>`
        select to_regclass('credit_leases') is not null
          and to_regprocedure(${GRANT_CREDIT_LEASE_SIGNATURE}) is not null as ready
      `;
      this.schema = { ready: row?.ready === true, checkedAt: now };
      if (!this.schema.ready) console.warn("[credit-lease] WORKER_CREDIT_LEASES is on but migrations 0052/0053 are missing; using the cadence check");
    } catch {
      this.schema = { ready: false, checkedAt: now };
    }
    return this.schema.ready;
  }

  /** Last known remaining credits of the run's lease, if this process has seen it. */
  localRemaining(runId: string): number | undefined {
    const local = this.runs.get(runId);
    return local && !local.blocked ? local.remaining : undefined;
  }

  /**
   * True when `unflushedCredits` of usage not yet checkpointed would use up
   * what this process last saw of the lease: the caller should checkpoint now.
   */
  wouldExhaust(runId: string, unflushedCredits: number): boolean {
    const local = this.runs.get(runId);
    if (!local || local.blocked) return false;
    return local.remaining - Math.max(0, unflushedCredits) <= 0;
  }

  /**
   * After a committed checkpoint consumed the lease: renew in the background
   * once `renewAt` is used; renew now (and pause when refused) once it is
   * exhausted or missing. Never throws.
   */
  async afterConsume(
    run: LeaseRun,
    observation: LeaseObservation | null,
    trigger: "stage-boundary" | "page-interval" | "checkpoint-interval",
  ): Promise<SpendCheckResult> {
    if (!run.orgId) return { blocked: false, paused: false };
    const config = creditLeaseConfig();
    const exhausted = !observation || !observation.live || observation.remaining <= 0;
    if (observation) this.remember(run.id, observation.live ? observation.remaining : 0, observation.leaseSize);
    if (exhausted) return await this.renewOrPause(run, trigger);
    // Used >= renewAt of the lease (with a tolerance for float rounding).
    const used = observation.leaseSize - observation.remaining;
    if (used >= config.renewAt * observation.leaseSize - 1e-9) {
      void this.renewOrPause(run, trigger).catch(() => undefined);
    }
    return { blocked: false, paused: false };
  }

  /** Renew the run's lease (deduplicated per run in this process) and pause the run if refused. */
  async renewOrPause(
    run: LeaseRun,
    trigger: "stage-boundary" | "page-interval" | "checkpoint-interval",
  ): Promise<SpendCheckResult> {
    const grant = await this.renew(run);
    // A failed grant falls back to the cadence rule (pause once available < 0),
    // so a broken lease path never leaves an exhausted run ungated.
    if (!grant) return await enforceRunSpend(this.sql, run, trigger);
    if (grant.remaining > 0) return { blocked: false, paused: false, available: grant.available };
    const reason = grant.blockReason ?? "credit_exhausted";
    if (reason === "run_inactive") return { blocked: true, paused: false, reason };
    return await pauseRunForSpend(this.sql, run, reason, trigger, grant.available - grant.outstanding);
  }

  private renew(run: LeaseRun): Promise<LeaseGrant | null> {
    const local = this.runs.get(run.id) ?? this.remember(run.id, 0, 0);
    local.renewing ??= (async () => {
      try {
        this.grants += 1;
        const grant = await grantRunCreditLease(this.sql, run);
        const current = this.remember(run.id, grant.remaining, grant.leaseSize);
        current.blocked = grant.remaining <= 0;
        if (grant.remaining <= 0 || grant.leaseSize < creditLeaseConfig().minCredits) {
          console.log(
            `[credit-lease] run=${run.id} org=${run.orgId} remaining=${grant.remaining.toFixed(4)} ` +
            `available=${grant.available.toFixed(4)} outstanding=${grant.outstanding.toFixed(4)} reason=${grant.blockReason ?? "none"}`,
          );
        }
        return grant;
      } catch (error) {
        // Fail open like the cadence check: the next checkpoint tries again.
        console.error(`[credit-lease] run=${run.id} grant failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        const after = this.runs.get(run.id);
        if (after) after.renewing = null;
      }
    })();
    return local.renewing;
  }

  private remember(runId: string, remaining: number, leaseSize: number): LocalLease {
    const now = Date.now();
    let local = this.runs.get(runId);
    if (!local) {
      if (this.runs.size >= 1_000) {
        for (const [id, entry] of this.runs) if (now - entry.seenAt > LOCAL_TTL_MS && !entry.renewing) this.runs.delete(id);
      }
      local = { remaining, leaseSize, blocked: false, seenAt: now, renewing: null };
      this.runs.set(runId, local);
      return local;
    }
    local.remaining = remaining;
    local.leaseSize = leaseSize;
    local.seenAt = now;
    if (remaining > 0) local.blocked = false;
    return local;
  }
}
