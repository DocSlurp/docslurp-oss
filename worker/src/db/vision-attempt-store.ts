import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

import {
  decideVisionAdmission,
  VISION_ORG_WINDOW_HOURS,
  type VisionAdmitRequest,
  type VisionAttemptBackend,
  type VisionBackendAdmission,
  type VisionSettleRequest,
} from "../lib/vision-attempt-guard.js";

type Client = Sql<Record<string, unknown>>;
type Tx = TransactionSql<Record<string, unknown>>;

/** Org rows are dropped once they are outside the 24 h window (plus an hour of slack). */
const ORG_ROW_RETENTION_HOURS = VISION_ORG_WINDOW_HOURS + 1;

/**
 * Postgres vision attempt ledger (migration 0101) behind `VisionRunGuard`. Admission takes the run's
 * advisory lock, then the org's, in that order, so every worker of a run and every run of an org read
 * the counts and add their request one at a time. Settlement only marks rows (settled, failed, or
 * deleted once a new customer charge is confirmed), which can never let an admission through that a
 * concurrent reader would have refused.
 */
export class PostgresVisionAttemptBackend implements VisionAttemptBackend {
  constructor(private readonly sql: Client) {}

  async admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission> {
    const { runId, target, config } = request;
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
      let org = { attempts: 0, settled: 0 };
      if (orgId) {
        await tx`delete from vision_org_attempts
          where org_id = ${orgId} and created_at < now() - make_interval(hours => ${ORG_ROW_RETENTION_HOURS})`;
        const [counts] = await tx<{ attempts: number; settled: number }[]>`
          select count(*)::int as attempts, count(*) filter (where settled)::int as settled
          from vision_org_attempts
          where org_id = ${orgId} and created_at > now() - make_interval(hours => ${VISION_ORG_WINDOW_HOURS})`;
        org = { attempts: counts?.attempts ?? 0, settled: counts?.settled ?? 0 };
      }
      const stop = decideVisionAdmission({
        scoped: orgId !== null,
        pageAttempts: page?.attempts ?? 0,
        runAttempts: totals?.attempts ?? 0,
        runFailures: totals?.failures ?? 0,
        orgAttempts: org.attempts,
        orgSettledAttempts: org.settled,
      }, target, config);
      if (stop) return { admitted: false as const, stop };
      const ticketId = randomUUID();
      await tx`insert into vision_org_attempts (id, org_id) values (${ticketId}, ${orgId})`;
      await tx`
        insert into vision_run_attempts (run_id, document_id, page_number, purpose, attempts)
        values (${runId}, ${target.documentId}, ${target.pageNumber}, ${target.purpose}, 1)
        on conflict (run_id, document_id, page_number, purpose)
        do update set attempts = vision_run_attempts.attempts + 1`;
      return { admitted: true as const, ticketId };
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
      let uncharged = request.tickets;
      if (request.charged) {
        // The page's first charge in this run (and the run still exists): that request leaves the org count.
        const first = await tx`
          insert into vision_run_charged_pages (run_id, document_id, page_number)
          select ${runId}, ${target.documentId}, ${target.pageNumber}
          where exists (select 1 from workspace_runs where id = ${runId})
          on conflict do nothing
          returning 1`;
        if (first.length > 0) {
          await tx`delete from vision_org_attempts where id = ${request.charged}`;
          uncharged = request.tickets.filter((ticket) => ticket !== request.charged);
        }
      }
      if (uncharged.length > 0) await tx`update vision_org_attempts set settled = true where id = any(${tx.array(uncharged)}::text[])`;
    });
  }
}

async function lock(tx: Tx, key: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
