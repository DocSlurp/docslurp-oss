import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

/**
 * Per-org worker slot semaphore (docs/scaling-1000-workers.md).
 *
 * One slot = one in-flight page task or document-stage activity. An org may
 * hold at most `organizations.worker_slots` (its plan ceiling) live leases;
 * the fleet as a whole at most WORKER_GLOBAL_SLOT_CAP. Leases expire unless
 * renewed, so a crashed worker's slots free themselves after `ttlMs`.
 *
 * The org cap is exact without a per-org lock: each org owns `worker_slots`
 * token rows (worker_slot_tokens, migration 0031), and a claim stamps one free
 * token taken with FOR UPDATE SKIP LOCKED inside one SQL function call, so
 * concurrent claimers never wait on each other (0025's per-org advisory lock
 * had 278 waiters at 576 slots in one org). The global cap is a soft limit:
 * concurrent claims from different orgs can overshoot it for one instant.
 * The hard fleet limit is the number of worker machines × slots per machine.
 */

export type WorkerSlotKind = "page" | "stage";

export interface WorkerSlotOptions {
  /** Lease lifetime without renewal. */
  ttlMs: number;
  /** Fleet-wide ceiling; 0 disables the check. */
  globalCap: number;
  /** Slots for runs whose org row is missing (legacy rows, local dev). */
  defaultOrgSlots: number;
}

export type WorkerSlotAcquireResult =
  | { acquired: true; leaseId: string; orgKey: string; cap: number }
  | { acquired: false; orgKey: string; inflight: number; cap: number; reason: "org-cap" | "global-cap" };

export function resolveWorkerSlotOptions(env: NodeJS.ProcessEnv = process.env): WorkerSlotOptions & { enabled: boolean } {
  const int = (value: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(value?.trim() ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const enabled = !["0", "false", "off", "no"].includes((env.WORKER_SLOT_ENFORCEMENT ?? "true").trim().toLowerCase());
  return {
    enabled,
    ttlMs: Math.max(15_000, int(env.WORKER_SLOT_LEASE_TTL_MS, 180_000)),
    globalCap: int(env.WORKER_GLOBAL_SLOT_CAP, 0),
    defaultOrgSlots: Math.max(1, int(env.WORKER_DEFAULT_ORG_SLOTS, 50)),
  };
}

export class WorkerSlotStore {
  constructor(
    private readonly sql: Sql<Record<string, unknown>>,
    private readonly options: WorkerSlotOptions,
  ) {}

  get ttlMs(): number {
    return this.options.ttlMs;
  }

  async acquire(args: { runId: string; kind: WorkerSlotKind; workerId: string }): Promise<WorkerSlotAcquireResult> {
    const leaseId = randomUUID();
    // acquire_worker_slot (migration 0031) claims a free token in one round trip.
    const [row] = await this.sql<{ acquired: boolean; org_key: string; inflight: number | null; cap: number; reason: string | null }[]>`
      select * from acquire_worker_slot(${args.runId}, ${args.kind}, ${args.workerId}, ${leaseId},
        ${Math.round(this.options.ttlMs)}::int, ${this.options.globalCap}::int, ${this.options.defaultOrgSlots}::int)`;
    if (!row) throw new Error(`worker slot: no result for run ${args.runId}`);
    return row.acquired
      ? { acquired: true, leaseId, orgKey: row.org_key, cap: Number(row.cap) }
      : {
          acquired: false,
          reason: row.reason === "global-cap" ? "global-cap" : "org-cap",
          orgKey: row.org_key,
          inflight: Number(row.inflight ?? 0),
          cap: Number(row.cap),
        };
  }

  /** Extends a live lease. Returns false once it has expired (an expired token may already belong to another claim). */
  async renew(leaseId: string): Promise<boolean> {
    const [row] = await this.sql<{ renewed: boolean }[]>`
      select renew_worker_slot(${leaseId}, ${Math.round(this.options.ttlMs)}::int) as renewed`;
    return Boolean(row?.renewed);
  }

  async release(leaseId: string): Promise<void> {
    await this.sql`select release_worker_slot(${leaseId})`;
  }

  async inflight(orgKey: string): Promise<number> {
    const [row] = await this.sql<{ inflight: number }[]>`
      select count(*)::int as inflight from worker_slot_tokens
      where org_key = ${orgKey} and lease_id is not null and expires_at >= now()`;
    return Number(row?.inflight ?? 0);
  }
}

/**
 * Single-holder lease for fleet-wide maintenance. Returns true when `holder`
 * holds (or just took over) the lease named `name`.
 */
export async function tryMaintenanceLease(
  sql: Sql<Record<string, unknown>>,
  args: { name: string; holder: string; ttlMs: number },
): Promise<boolean> {
  const rows = await sql`insert into worker_maintenance_leases (name, holder, expires_at, updated_at)
    values (${args.name}, ${args.holder}, now() + (${args.ttlMs} * interval '1 millisecond'), now())
    on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at, updated_at = now()
    where worker_maintenance_leases.holder = excluded.holder or worker_maintenance_leases.expires_at < now()
    returning holder`;
  return rows.length > 0;
}
