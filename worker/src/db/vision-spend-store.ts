import { randomUUID } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

import {
  decideVisionAdmission,
  sanitizeCents,
  VISION_RESERVATION_TTL_MS,
  type VisionAdmitRequest,
  type VisionBackendAdmission,
  type VisionSettlement,
  type VisionSpendBackend,
} from "../lib/vision-spend-guard.js";

type Client = Sql<Record<string, unknown>>;
type Tx = TransactionSql<Record<string, unknown>>;

/** Old org buckets are dropped once they are well outside any window (max 168 h). */
const ORG_BUCKET_RETENTION = "8 days";

/**
 * Postgres vision spend ledger (migration 0101) behind `VisionRunGuard`. Admission and settlement
 * take the run's advisory lock, then the org's, in that order, so every worker of a run and every
 * run of an org read and change the ledger one at a time: a reservation is either live or settled
 * into the counters, never both or neither.
 */
export class PostgresVisionSpendBackend implements VisionSpendBackend {
  constructor(private readonly sql: Client, private readonly reservationTtlMs = VISION_RESERVATION_TTL_MS) {}

  async admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission> {
    const reserve = sanitizeCents(request.reserveCents);
    return await this.sql.begin(async (tx) => {
      await lock(tx, `vision-run:${request.runId}`);
      // The run row decides the org: a caller's org never widens or moves the scope.
      const [run] = await tx<{ org_id: string | null }[]>`select org_id from workspace_runs where id = ${request.runId}`;
      if (!run) throw new Error(`vision guard: run ${request.runId} not found`);
      const orgId = run.org_id ?? null;
      if (orgId) await lock(tx, `vision-org:${orgId}`);
      await foldExpired(tx, request.runId, orgId);

      const [spend] = await tx<{ cents: number | string }[]>`
        select provider_cost_cents as cents from vision_run_spend where run_id = ${request.runId}`;
      const [pages] = await tx<{ attempted: number; rejected: number }[]>`
        select count(*)::int as attempted, count(*) filter (where rejected)::int as rejected
        from vision_run_pages where run_id = ${request.runId}`;
      const [runReserved] = await tx<{ cents: number | string }[]>`
        select coalesce(sum(cents), 0) as cents from vision_spend_reservations where run_id = ${request.runId}`;
      let orgUnbilled = 0;
      let orgReserved = 0;
      if (orgId) {
        const [unbilled] = await tx<{ cents: number | string }[]>`
          select coalesce(sum(cents), 0) as cents from vision_org_unbilled_spend
          where org_id = ${orgId} and hour >= date_trunc('hour', now()) - make_interval(hours => ${request.config.orgWindowHours})`;
        const [reserved] = await tx<{ cents: number | string }[]>`
          select coalesce(sum(cents), 0) as cents from vision_spend_reservations where org_id = ${orgId}`;
        orgUnbilled = Number(unbilled?.cents ?? 0) || 0;
        orgReserved = Number(reserved?.cents ?? 0) || 0;
        await tx`delete from vision_org_unbilled_spend
          where org_id = ${orgId} and hour < now() - ${ORG_BUCKET_RETENTION}::interval`;
      }
      const stop = decideVisionAdmission({
        runCostCents: Number(spend?.cents ?? 0) || 0,
        runReservedCents: Number(runReserved?.cents ?? 0) || 0,
        attemptedPages: Number(pages?.attempted ?? 0),
        rejectedPages: Number(pages?.rejected ?? 0),
        orgUnbilledCents: orgUnbilled,
        orgReservedCents: orgReserved,
      }, reserve, request.config, orgId !== null);
      if (stop) return { admitted: false as const, stop };
      const reservationId = randomUUID();
      await tx`
        insert into vision_spend_reservations (id, run_id, org_id, cents, expires_at)
        values (${reservationId}, ${request.runId}, ${orgId}, ${reserve},
          now() + make_interval(secs => ${this.reservationTtlMs / 1000}))`;
      return { admitted: true as const, reservationId };
    });
  }

  async settle(reservationId: string, settlement: VisionSettlement): Promise<void> {
    const [owner] = await this.sql<{ run_id: string; org_id: string | null }[]>`
      select run_id, org_id from vision_spend_reservations where id = ${reservationId}`;
    // Already folded in full after expiring: nothing left to settle.
    if (!owner) return;
    await this.sql.begin(async (tx) => {
      await lock(tx, `vision-run:${owner.run_id}`);
      if (owner.org_id) await lock(tx, `vision-org:${owner.org_id}`);
      const [deleted] = await tx<{ id: string }[]>`delete from vision_spend_reservations where id = ${reservationId} returning id`;
      if (!deleted) return;
      await addSpend(tx, owner.run_id, owner.org_id, sanitizeCents(settlement.costCents), settlement.billable);
      if (settlement.page) {
        await tx`
          insert into vision_run_pages (run_id, document_id, page_number, rejected)
          values (${owner.run_id}, ${settlement.page.documentId}, ${settlement.page.pageNumber}, ${settlement.page.rejected})
          on conflict (run_id, document_id, page_number)
          do update set rejected = vision_run_pages.rejected or excluded.rejected`;
      }
    });
  }
}

async function lock(tx: Tx, key: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

async function addSpend(tx: Tx, runId: string, orgId: string | null, cents: number, billable: boolean): Promise<void> {
  if (cents <= 0) return;
  await tx`
    insert into vision_run_spend (run_id, provider_cost_cents) values (${runId}, ${cents})
    on conflict (run_id) do update
      set provider_cost_cents = vision_run_spend.provider_cost_cents + excluded.provider_cost_cents, updated_at = now()`;
  if (billable || !orgId) return;
  await tx`
    insert into vision_org_unbilled_spend (org_id, hour, cents) values (${orgId}, date_trunc('hour', now()), ${cents})
    on conflict (org_id, hour) do update set cents = vision_org_unbilled_spend.cents + excluded.cents`;
}

/**
 * Reservations never settled (their worker died mid-call) count in full, as unbilled spend: the
 * provider may have billed the call and no usage event says otherwise. Only rows under the locks
 * this transaction holds (the run's, and the org's when it has one).
 */
async function foldExpired(tx: Tx, runId: string, orgId: string | null): Promise<void> {
  const expired = orgId
    ? await tx<{ run_id: string; org_id: string | null; cents: number }[]>`
        delete from vision_spend_reservations where expires_at <= now() and (run_id = ${runId} or org_id = ${orgId})
        returning run_id, org_id, cents`
    : await tx<{ run_id: string; org_id: string | null; cents: number }[]>`
        delete from vision_spend_reservations where expires_at <= now() and run_id = ${runId}
        returning run_id, org_id, cents`;
  for (const row of expired) {
    console.warn(`[vision-guard] run=${row.run_id} reservation expired unsettled; counting ${row.cents} cents in full`);
    await addSpend(tx, row.run_id, row.org_id, Number(row.cents) || 0, false);
  }
}
