import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { isBillingExemptOrg } from "@docslurp/shared";
import { jobCreditReserve } from "../../db/chat-reserve.js";
import { WorkflowState } from "../../pipeline/pipeline.js";
import type { WorkspaceRun } from "../../models.js";
import { debitRunUsageCredits, persistRunUsageEvents } from "../../db/usage-event-store.js";
import { consumeRunCreditLease, creditLeasesActive } from "../../db/credit-lease.js";
import type { CapacityLease, CapacityLeaseStore } from "./types.js";
function decode(row: Record<string, any>): CapacityLease {
  return { id: row.id, provider: row.provider, name: row.name, scope: row.scope, beforeIds: row.before_ids,
    resourceId: row.resource_id, status: row.status, hourlyUsd: Number(row.hourly_usd), reservedUsd: Number(row.reserved_usd),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd), createdAt: new Date(row.created_at).getTime(), deadline: new Date(row.deadline).getTime() };
}
export class PostgresCapacityLeaseStore implements CapacityLeaseStore {
  constructor(private readonly sql: Sql<Record<string, unknown>>, private readonly loadRun: (id: string) => Promise<WorkspaceRun | null>,
    private readonly providerIds: string[]) {}
  async reserve(args: Parameters<CapacityLeaseStore["reserve"]>[0]): Promise<CapacityLease> {
    if (args.ttlMs < 60000 || args.ttlMs > 2 * 3600000 || args.quote.observedAt < Date.now() - 60000) throw new Error("Invalid capacity deadline or stale quote");
    const reserved = args.quote.hourlyUsd * args.ttlMs / 3600000 + args.quote.fixedReserveUsd;
    if (!Number.isFinite(reserved) || reserved <= 0 || reserved > args.budgetUsd) throw new Error("Capacity reservation exceeds budget");
    return await this.sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended('docslurp:media-capacity', 0))`;
      const [watchdog] = await tx`select id from remote_capacity_watchdog where id = 'media'
        and heartbeat_at > now() - interval '45 seconds' and providers ? ${args.provider}`;
      if (!watchdog) throw new Error("Independent capacity watchdog is not healthy");
      const [usage] = await tx<{ active: number; reserved: number }[]>`select count(*) filter (where status <> 'deleted')::int as active,
        coalesce(sum(reserved_usd) filter (where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' or status <> 'deleted'), 0) as reserved
        from remote_capacity_leases`;
      if (usage.active >= args.maxConcurrent || Number(usage.reserved) + reserved > args.budgetUsd) throw new Error("Capacity fleet budget or concurrency exhausted");
      await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${args.scope.orgId}))`;
      // Credit leases other runs hold (migration 0052) are spoken for, and the
      // chat reserve (0053) is not for jobs.
      const [status] = await tx<{ funded: boolean | null; available: number; leased: number; workspace_in_org: boolean; org_budget_paused: boolean; workspace_budget_paused: boolean }[]>`
        select s.*, org_outstanding_credit_leases(${args.scope.orgId}, 'run', ${args.scope.runId}) as leased
        from org_spend_status(${args.scope.orgId}, ${args.scope.workspaceId}, 0) s`;
      const [pending] = await tx<{ org_reserved: number; run_reserved: number }[]>`select
        coalesce(sum(cents) filter (where org = ${args.scope.orgId}), 0) as org_reserved,
        coalesce(sum(cents) filter (where run = ${args.scope.runId}), 0) as run_reserved from (
          select scope->>'orgId' as org, scope->>'runId' as run, (case when status='deleted' then fixed_reserve_usd else reserved_usd end) * 100 as cents
            from remote_capacity_leases where status <> 'deleted' or fixed_reserve_usd > 0
          union all
          select org_id, run_id, case when usage_settled then greatest(reserve_cents-coalesce(charged_cost_cents,cost_cents,0),0) else greatest(reserve_cents,coalesce(charged_cost_cents,cost_cents,0)) end
            from remote_media_jobs where usage_settled = false or cost_state = 'disputed'
        ) reservations`;
      if (!status?.workspace_in_org || status.org_budget_paused || status.workspace_budget_paused ||
        (Number(status.available) - Number(status.leased) - jobCreditReserve(status.funded) < reserved * 100 + Number(pending.org_reserved) && !isBillingExemptOrg(args.scope.orgId))) throw new Error("Capacity spend admission denied");
      const [run] = await tx<{ spent: number }[]>`select spent_cents as spent from workspace_runs
        where id = ${args.scope.runId} and org_id = ${args.scope.orgId} and workspace_id = ${args.scope.workspaceId}
        and coalesce(control_state, '') not in ('paused','pause_requested','cancelled','cancel_requested','dead-letter')`;
      if (!run || (args.maxRunCostCents != null && Number(run.spent) + Number(pending.run_reserved) + reserved * 100 > args.maxRunCostCents)) throw new Error("Capacity run admission denied");
      const [document] = await tx`select id from documents where id = ${args.scope.documentId} and run_id = ${args.scope.runId}`;
      if (!document) throw new Error("Capacity document scope mismatch");
      const id = randomUUID(); const createdAt = Date.now();
      const [row] = await tx`insert into remote_capacity_leases
        (id, provider, name, scope, before_ids, status, hourly_usd, reserved_usd, fixed_reserve_usd, created_at, deadline)
        values (${id}, ${args.provider}, ${`docslurp-${id}`}, ${JSON.stringify(args.scope)}::text::jsonb,
          ${JSON.stringify(args.beforeIds)}::text::jsonb, 'creating', ${args.quote.hourlyUsd}, ${reserved}, ${args.quote.fixedReserveUsd},
          ${new Date(createdAt)}, ${new Date(createdAt + args.ttlMs)}) returning *`;
      return decode(row);
    });
  }
  async attach(id: string, resourceId: string) {
    await this.sql`update remote_capacity_leases set resource_id = ${resourceId}, status = 'active'
      where id = ${id} and status = 'creating' and resource_id is null`;
  }
  async deleting(id: string) { await this.sql`update remote_capacity_leases set status = 'deleting' where id = ${id} and status <> 'deleted'`; }
  async deleted(lease: CapacityLease, verifiedAt: number) {
    const run = await this.loadRun(lease.scope.runId);
    return await this.sql.begin(async tx => {
      const [row] = await tx`select status, cost_usd from remote_capacity_leases where id = ${lease.id} for update`;
      if (!row) throw new Error('Capacity ownership record missing');
      if (row.status === 'deleted') return Number(row.cost_usd);
      const seconds = Math.max(0, (verifiedAt - lease.createdAt) / 1000);
      const costUsd = seconds * lease.hourlyUsd / 3600;
      if (run) {
        const state = new WorkflowState(run, []);
        state.usageLedger.enqueue({ id: lease.id, provider: lease.provider, model: "gpu-capacity", metric: "media-capacity",
          amount: seconds, unit: "host-seconds", costCents: costUsd * 100,
          metadata: { ...lease.scope, leaseId: lease.id, resourceId: lease.resourceId,
            costSource: "estimate", transferCostUsd: null, hourlyUsd: lease.hourlyUsd, verifiedDeletedAt: new Date(verifiedAt).toISOString() } });
        const batch = state.usageLedger.checkpoint();
        const client = tx as unknown as Sql<Record<string, unknown>>;
        const costCents = await persistRunUsageEvents({ client, state, usageEvents: batch.events });
        await debitRunUsageCredits({ client, state, costCents });
        // Same delta as the debit and spent_cents (usage_events trigger, 0056).
        if (creditLeasesActive() && costCents > 0) await consumeRunCreditLease(client, run, costCents);

        // No in-memory ledger is reused after this transaction; durable IDs prevent duplicate charges.
      }
      await tx`update remote_capacity_leases set status = 'deleted', cost_usd = ${costUsd}, verified_deleted_at = ${new Date(verifiedAt)} where id = ${lease.id}`;
      return costUsd;
    });
  }
  async outstanding() { return (await this.sql`select * from remote_capacity_leases where status <> 'deleted'`).map(decode); }
  async heartbeat() { await this.sql`insert into remote_capacity_watchdog(id, providers, heartbeat_at)
    values ('media', ${JSON.stringify(this.providerIds)}::text::jsonb, now())
    on conflict (id) do update set providers = excluded.providers, heartbeat_at = excluded.heartbeat_at`; }
}
