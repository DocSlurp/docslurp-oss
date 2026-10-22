import type { MediaAccounting } from "./accounting.js";
import { videoPolicy } from "./video-policy.js";
import { randomUUID } from "node:crypto";
import type { Sql, JSONValue } from "postgres";
import { isBillingExemptOrg } from "@docslurp/shared";
import { jobCreditReserve } from "../db/chat-reserve.js";
import type { MediaJournal, MediaReceipt } from "./types.js";

type Row = { id: string; status: MediaReceipt["status"]; result_key: string | null; cost_cents: number | null };
const receipt = (row: Row): MediaReceipt => ({ id: row.id, status: row.status, resultKey: row.result_key,
  costCents: row.cost_cents === null ? null : Number(row.cost_cents) });
export class PostgresMediaJournal implements MediaJournal {
  constructor(private readonly sql: Sql<Record<string, unknown>>) {}
  async admit(args: Parameters<MediaJournal["admit"]>[0]) {
    const { scope } = args;
    return await this.sql.begin(async tx => {
      // One short transaction serializes platform budget/concurrency, not inference.
      await tx`select pg_advisory_xact_lock(hashtextextended('docslurp:remote-media-admission', 0))`;
      const [existing] = await tx<Row[]>`select id, status, result_key, cost_cents from remote_media_jobs
        where request_key = ${args.key} and run_id = ${scope.runId} and document_id = ${scope.documentId}
        and org_id = ${scope.orgId} and workspace_id = ${scope.workspaceId}`;
      if (existing) return { receipt: receipt(existing), acquired: false };
      const [pricingHold] = await tx`select id from remote_media_jobs where provider = ${args.provider} and org_id = ${scope.orgId}
        and model = ${args.model} and pricing_uncertain = true limit 1`;
      if (pricingHold) throw new Error("Media provider pricing requires reconciliation before more admissions");
      await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${scope.orgId}))`;
      await this.assertCanSpend(tx as unknown as Sql<Record<string, unknown>>, args);
      const [totals] = await tx<{ inflight: number; daily: number; run_cost: number }[]>`
        select count(*) filter (where status <> 'completed')::int as inflight,
          coalesce(sum(case when usage_settled and cost_state <> 'disputed' then coalesce(charged_cost_cents, cost_cents, 0) else greatest(reserve_cents, coalesce(charged_cost_cents, cost_cents, 0)) end) filter
            (where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
              or status <> 'completed'), 0) as daily,
          coalesce(sum(case when usage_settled and cost_state <> 'disputed' then coalesce(charged_cost_cents, cost_cents, 0) else greatest(reserve_cents, coalesce(charged_cost_cents, cost_cents, 0)) end) filter (where run_id = ${scope.runId}), 0) as run_cost
        from remote_media_jobs`;
      if (!totals || totals.inflight >= args.maxConcurrent) throw new Error("Media concurrency exhausted; uncertain requests need reconciliation");
      if (Number(totals.daily) + args.reserveCents > args.dailyBudgetCents) throw new Error("Media daily budget exhausted");
      const [run] = await tx<{ spent_cents: number }[]>`
        select spent_cents from workspace_runs
        where id = ${scope.runId} and org_id = ${scope.orgId} and workspace_id = ${scope.workspaceId}
          and coalesce(control_state, '') not in ('cancelled', 'cancel_requested', 'paused', 'pause_requested', 'dead-letter')`;
      if (!run) throw new Error("Media run is not admitted");
      const [document] = await tx`select id from documents where id = ${scope.documentId} and run_id = ${scope.runId}`;
      if (!document) throw new Error("Media document scope mismatch");
      const [capacity] = await tx<{ reserved: number }[]>`select coalesce(sum((case when status='deleted' then fixed_reserve_usd else reserved_usd end) * 100), 0) as reserved
        from remote_capacity_leases where scope->>'runId' = ${scope.runId} and (status <> 'deleted' or fixed_reserve_usd > 0)`;
      // Persisted run cost already includes settled receipts; add only outstanding exposure.
      if (args.maxRunCostCents != null && Number(run.spent_cents) + Number(capacity.reserved) + Number((await tx`select coalesce(sum(case when usage_settled then greatest(reserve_cents-coalesce(charged_cost_cents,cost_cents,0),0) else greatest(reserve_cents,coalesce(charged_cost_cents,cost_cents,0)) end), 0) as pending from remote_media_jobs where run_id = ${scope.runId} and (usage_settled = false or cost_state = 'disputed')`)[0].pending) + args.reserveCents > args.maxRunCostCents) {
        throw new Error("Media run cost cap exhausted");
      }
      if (args.maxDocumentCostCents !== undefined) {
        const [spent] = await tx`select coalesce(sum(case when usage_settled and cost_state <> 'disputed' then coalesce(charged_cost_cents,cost_cents,0) else greatest(reserve_cents,coalesce(charged_cost_cents,cost_cents,0)) end),0) as value from remote_media_jobs where document_id = ${scope.documentId}`;
        if (Number(spent.value) + args.reserveCents > args.maxDocumentCostCents) throw new Error("Media document cost cap exhausted");
      }
      const [created] = await tx<Row[]>`insert into remote_media_jobs
        (id, request_key, org_id, workspace_id, run_id, document_id, provider, model, status, reserve_cents)
        values (${randomUUID()}, ${args.key}, ${scope.orgId}, ${scope.workspaceId}, ${scope.runId}, ${scope.documentId},
          ${args.provider}, ${args.model}, 'submitting', ${args.reserveCents})
        returning id, status, result_key, cost_cents`;
      return { receipt: receipt(created), acquired: true };
    });
  }
  async admitVideo(scope: Parameters<NonNullable<MediaJournal["admitVideo"]>>[0], duration: number, frames: number) {
    await this.sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${scope.orgId}))`;
      const [org] = await tx`select o.funded_at is not null as funded from organizations o join workspace_runs r on r.org_id=o.id join documents d on d.run_id=r.id
        where o.id=${scope.orgId} and r.id=${scope.runId} and r.workspace_id=${scope.workspaceId} and d.id=${scope.documentId}`;
      if (!org) throw new Error("Video admission scope mismatch");
      const policy = videoPolicy(org.funded === true, duration);
      if (!Number.isInteger(frames) || frames < 0 || frames > policy.frames) throw new Error("Video frame budget exceeds tier");
      const [existing] = await tx`select * from media_video_admissions where document_id=${scope.documentId}`;
      if (existing) {
        if (existing.org_id !== scope.orgId || existing.run_id !== scope.runId || Number(existing.duration_seconds) !== duration || Number(existing.reserved_frames) !== frames) throw new Error("Video admission changed on retry");
        return;
      }
      if (policy.tier === "starter") {
        const [used] = await tx`select coalesce(sum(duration_seconds),0) as seconds, coalesce(sum(reserved_frames),0) as frames from media_video_admissions
          where org_id=${scope.orgId} and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;
        if (Number(used.seconds)+duration > 600 || Number(used.frames)+frames > 60) throw new Error("Starter video daily organization quota exhausted");
      }
      await tx`insert into media_video_admissions(document_id,org_id,run_id,duration_seconds,reserved_frames) values (${scope.documentId},${scope.orgId},${scope.runId},${duration},${frames})`;
    });
  }
  private async assertCanSpend(tx: Sql<Record<string, unknown>>, args: Parameters<MediaJournal["admit"]>[0]) {
    // Credit leases other runs hold (migration 0052) are spoken for; this
    // run's own lease is what its media spend draws from.
    // The chat reserve (migration 0053) is not for jobs either.
    const [status] = await tx<{ funded: boolean | null; available: number; leased: number; workspace_in_org: boolean; org_budget_paused: boolean; workspace_budget_paused: boolean }[]>`
      select s.*, org_outstanding_credit_leases(${args.scope.orgId}, 'run', ${args.scope.runId}) as leased
      from org_spend_status(${args.scope.orgId}, ${args.scope.workspaceId}, 0) s`;
    const [pending] = await tx<{ reserved: number }[]>`select
      coalesce((select sum(case when usage_settled then greatest(reserve_cents-coalesce(charged_cost_cents,cost_cents,0),0) else greatest(reserve_cents,coalesce(charged_cost_cents,cost_cents,0)) end) from remote_media_jobs
        where org_id = ${args.scope.orgId} and (usage_settled = false or cost_state = 'disputed')), 0) +
      coalesce((select sum((case when status='deleted' then fixed_reserve_usd else reserved_usd end) * 100) from remote_capacity_leases
        where scope->>'orgId' = ${args.scope.orgId} and (status <> 'deleted' or fixed_reserve_usd > 0)), 0) as reserved`;
    if (!status?.workspace_in_org || status.org_budget_paused || status.workspace_budget_paused ||
      (Number(status.available) - Number(status.leased) - jobCreditReserve(status.funded) < args.reserveCents + Number(pending.reserved) && !isBillingExemptOrg(args.scope.orgId))) throw new Error("Media spend admission denied");
  }
  async complete(id: string, resultKey: string, costCents: number, pricingMismatch = false, accounting?: MediaAccounting, chargedCostCents = costCents) {
    await this.sql`update remote_media_jobs set status = 'completed', result_key = ${resultKey}, cost_cents = ${costCents}, charged_cost_cents = ${chargedCostCents}, pricing_uncertain = ${pricingMismatch}, accounting = ${accounting ? this.sql.json(accounting as unknown as JSONValue) : null}, cost_state = ${accounting?.state ?? 'estimated'}, updated_at = now()
      where id = ${id} and status = 'submitting'`;
  }
  async settled(id: string) {
    await this.sql`update remote_media_jobs set usage_settled = true where id = ${id} and status = 'completed'`;
  }
  async uncertain(id: string) {
    await this.sql`update remote_media_jobs set status = 'uncertain', updated_at = now() where id = ${id} and status = 'submitting'`;
  }
}
