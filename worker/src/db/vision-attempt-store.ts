import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

import {
  decideVisionAdmission,
  VISION_ORG_WINDOW_HOURS,
  type VisionAdmitRequest,
  type VisionAttemptBackend,
  type VisionBackendAdmission,
  type VisionOverrunRequest,
  type VisionReleaseRequest,
  type VisionSettleRequest,
} from "../lib/vision-attempt-guard.js";

type Client = Sql<Record<string, unknown>>;
type Tx = TransactionSql<Record<string, unknown>>;

/** Org rows are dropped once they are outside the 24 h window (plus an hour of slack). */
const ORG_ROW_RETENTION_HOURS = VISION_ORG_WINDOW_HOURS + 1;

/**
 * Postgres vision attempt ledger (migration 0101) behind `VisionRunGuard`. Admission takes the run's
 * advisory lock, then the org's, in that order, so every worker of a run and every run of an org read
 * the counts and add their request one at a time. Settlement only marks rows settled or failed; a
 * charged request's row is removed by the checkpoint that persists its Rich charge
 * (usage-event-store.ts), and a request handed back before acceptance is removed by `release`.
 */
/** The database's vision ledger does not match the code (missing or stale migration 0101): never retried. */
export class VisionLedgerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionLedgerSchemaError";
  }
}

/**
 * Startup schema check with retries: a schema mismatch (`VisionLedgerSchemaError`) is returned as fatal at once;
 * any other failure (the database not reachable yet, a dropped connection) is retried with backoff, and the last
 * one is thrown as it is, so the worker's classifier treats it as a retryable startup failure.
 */
export async function assertVisionLedgerSchemaWithRetry(
  check: () => Promise<void>,
  options: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<void> {
  const attempts = options.attempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await check();
      return;
    } catch (error) {
      if (error instanceof VisionLedgerSchemaError || attempt >= attempts) throw error;
      const delayMs = Math.min(30_000, baseDelayMs * 2 ** (attempt - 1));
      (options.log ?? console.warn)(
        `[vision-guard] ledger schema check failed (attempt ${attempt}/${attempts}), retrying in ${delayMs} ms: ${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(delayMs);
    }
  }
}

export class PostgresVisionAttemptBackend implements VisionAttemptBackend {
  constructor(private readonly sql: Client) {}

  /**
   * Startup check (temporal/worker.ts): throws unless the database has the current migration 0101.
   * 0101 was replaced in place before reaching main, so a database that applied the earlier version
   * records it as applied but lacks `vision_org_attempts.weight_cents` and still has
   * `vision_run_charged_pages`; migrating cannot fix that, and the guard would misbehave on it.
   */
  async assertSchema(): Promise<void> {
    const [row] = await this.sql<{ org_table: boolean; weight: boolean; stale: boolean; overruns: boolean }[]>`
      select
        to_regclass('vision_org_attempts') is not null as org_table,
        to_regclass('vision_route_overruns') is not null as overruns,
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'vision_org_attempts' and column_name = 'weight_cents'
        ) as weight,
        to_regclass('vision_run_charged_pages') is not null as stale`;
    if (!row?.org_table) {
      throw new VisionLedgerSchemaError("vision attempt ledger missing (migration 0101_vision_attempt_ledger not applied); run pnpm db:migrate");
    }
    if (!row.weight || row.stale || !row.overruns) {
      throw new VisionLedgerSchemaError(
        "vision attempt ledger is from an earlier draft of migration 0101 " +
          `(${[!row.weight ? "vision_org_attempts.weight_cents missing" : null, !row.overruns ? "vision_route_overruns missing" : null, row.stale ? "stale vision_run_charged_pages present" : null].filter(Boolean).join(", ")}); ` +
          "database reset required: 0101 was replaced in place and cannot be upgraded by pnpm db:migrate",
      );
    }
  }

  async admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission> {
    const { runId, target, config, weightCents } = request;
    return await this.sql.begin(async (tx) => {
      await lock(tx, `vision-run:${runId}`);
      // The run row decides the org (falling back to its workspace's): a caller's org never widens or moves the scope.
      const [run] = await tx<{ org_id: string | null }[]>`
        select coalesce(r.org_id, w.org_id) as org_id
        from workspace_runs r left join workspaces w on w.id = r.workspace_id
        where r.id = ${runId}`;
      const orgId = run?.org_id ?? null;
      if (orgId) await lock(tx, `vision-org:${orgId}`);
      const [page] = await tx<{ attempts: number }[]>`
        select attempts from vision_run_attempts
        where run_id = ${runId} and document_id = ${target.documentId} and page_number = ${target.pageNumber}
          and purpose = ${target.purpose}`;
      const [totals] = await tx<{ attempts: number; failures: number }[]>`
        select coalesce(sum(attempts), 0)::int as attempts, coalesce(sum(failures), 0)::int as failures
        from vision_run_attempts where run_id = ${runId}`;
      let org = { cents: 0, settled: 0 };
      if (orgId) {
        await tx`delete from vision_org_attempts
          where org_id = ${orgId} and created_at < now() - make_interval(hours => ${ORG_ROW_RETENTION_HOURS})`;
        const [counts] = await tx<{ cents: number; settled: number }[]>`
          select coalesce(sum(weight_cents), 0)::float8 as cents,
            coalesce(sum(weight_cents) filter (where settled), 0)::float8 as settled
          from vision_org_attempts
          where org_id = ${orgId} and created_at > now() - make_interval(hours => ${VISION_ORG_WINDOW_HOURS})`;
        org = { cents: Number(counts?.cents ?? 0), settled: Number(counts?.settled ?? 0) };
      }
      let routeOverruns = 0;
      if (request.route) {
        const [overruns] = await tx<{ count: number }[]>`
          select count(*)::int as count from vision_route_overruns
          where provider = ${request.route.provider} and model = ${request.route.model}
            and created_at > now() - make_interval(hours => ${VISION_ORG_WINDOW_HOURS})`;
        routeOverruns = overruns?.count ?? 0;
      }
      const stop = decideVisionAdmission({
        scoped: orgId !== null,
        pageAttempts: page?.attempts ?? 0,
        runAttempts: totals?.attempts ?? 0,
        runFailures: totals?.failures ?? 0,
        orgCents: org.cents,
        orgSettledCents: org.settled,
        routeOverruns,
      }, target, config, weightCents);
      if (stop) return { admitted: false as const, stop };
      const ticketId = randomUUID();
      await tx`insert into vision_org_attempts (id, org_id, weight_cents) values (${ticketId}, ${orgId}, ${weightCents})`;
      await tx`
        insert into vision_run_attempts (run_id, document_id, page_number, purpose, attempts)
        values (${runId}, ${target.documentId}, ${target.pageNumber}, ${target.purpose}, 1)
        on conflict (run_id, document_id, page_number, purpose)
        do update set attempts = vision_run_attempts.attempts + 1`;
      return { admitted: true as const, ticketId };
    });
  }

  async release(request: VisionReleaseRequest): Promise<void> {
    const { runId, target } = request;
    await this.sql.begin(async (tx) => {
      // Only a request still counted gives its page admission back (a second release is a no-op).
      const gone = await tx`delete from vision_org_attempts where id = ${request.ticketId} returning 1`;
      if (gone.length === 0) return;
      await tx`
        update vision_run_attempts set attempts = greatest(attempts - 1, 0)
        where run_id = ${runId} and document_id = ${target.documentId} and page_number = ${target.pageNumber}
          and purpose = ${target.purpose}`;
    });
  }

  async settle(request: VisionSettleRequest): Promise<void> {
    const { runId, target } = request;
    await this.sql.begin(async (tx) => {
      if (request.failed.length > 0) {
        await tx`
          update vision_run_attempts set failures = failures + ${request.failed.length}
          where run_id = ${runId} and document_id = ${target.documentId} and page_number = ${target.pageNumber}
            and purpose = ${target.purpose}`;
      }
      // The charged request stays in flight (never sticky) until its charge's checkpoint removes it.
      const uncharged = request.tickets.filter((ticket) => ticket !== request.charged);
      if (uncharged.length > 0) await tx`update vision_org_attempts set settled = true where id = any(${tx.array(uncharged)}::text[])`;
    });
  }

  async recordOverrun(request: VisionOverrunRequest): Promise<void> {
    const { runId, route, billedCents, boundCents } = request;
    const extra = billedCents - boundCents;
    await this.sql.begin(async (tx) => {
      // Same locks and org as admission: the run row decides the org, never the caller.
      await lock(tx, `vision-run:${runId}`);
      const [run] = await tx<{ org_id: string | null }[]>`
        select coalesce(r.org_id, w.org_id) as org_id
        from workspace_runs r left join workspaces w on w.id = r.workspace_id
        where r.id = ${runId}`;
      const orgId = run?.org_id ?? null;
      if (orgId) await lock(tx, `vision-org:${orgId}`);
      // Settled and under its own id: no Rich charge checkpoint removes it, so the org bound holds on billed cost.
      if (orgId && extra > 0) {
        await tx`insert into vision_org_attempts (id, org_id, weight_cents, settled) values (${randomUUID()}, ${orgId}, ${extra}, true)`;
      }
      await tx`delete from vision_route_overruns where created_at < now() - make_interval(hours => ${ORG_ROW_RETENTION_HOURS})`;
      await tx`
        insert into vision_route_overruns (id, provider, model, org_id, run_id, billed_cents, bound_cents)
        values (${randomUUID()}, ${route.provider}, ${route.model}, ${orgId}, ${runId}, ${billedCents}, ${boundCents})`;
    });
  }
}

async function lock(tx: Tx, key: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
