import type { Sql } from "postgres";
import { compilePipelinePlan, deferredProfilesEnabled, type CompiledPipelinePlan, type PipelineRunStage } from "@docslurp/shared";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { retryTransaction } from "./transaction-retry.js";
import { debitRunUsageCredits, persistRunUsageEvents } from "./usage-event-store.js";

export function pageBaseFeeRateCents(raw = process.env.DOCSLURP_PAGE_BASE_FEE_USD ?? "0"): number {
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error("DOCSLURP_PAGE_BASE_FEE_USD must be a nonnegative dollar amount");
  return dollars * 100;
}

/**
 * Stages that only rebuild indexes from existing content. A partial run that
 * executes nothing else is a reindex: its compute is already metered and its
 * embeddings are mostly reused, so it carries no base fee.
 */
const INDEX_ONLY_STAGES: ReadonlySet<PipelineRunStage> = new Set([
  "pii-detect", "embed", "graph-enrich", "page-index", "index",
]);

/**
 * Share of the per-page base fee a run pays. Full runs pay 1. Partial
 * reprocess runs pay the fraction of enabled stages they execute (reused
 * stages are free), and reindex-only runs pay 0.
 */
export function pageBaseFeeMultiplier(plan: Pick<CompiledPipelinePlan, "stageOrder" | "reusedStages">): number {
  if (plan.reusedStages.length === 0) return 1;
  if (plan.stageOrder.every((stage) => INDEX_ONLY_STAGES.has(stage))) return 0;
  const enabled = plan.stageOrder.length + plan.reusedStages.length;
  return Math.round((plan.stageOrder.length / enabled) * 100) / 100;
}

/** Charge once per completed run, excluding content-deduplicated documents. */
export async function recordPageBaseFee(sql: Sql<Record<string, unknown>>, state: WorkflowState): Promise<void> {
  const fullRateCents = pageBaseFeeRateCents();
  const multiplier = pageBaseFeeMultiplier(compilePipelinePlan(state.run.pipeline));
  const rateCents = fullRateCents * multiplier;
  const charged = await retryTransaction(`page-base-fee run=${state.run.id}`, () => sql.begin(async tx => {
    const client = tx as unknown as typeof sql;
    // FOR NO KEY UPDATE: serializes fee recording without blocking FK checks on child rows.
    const [locked] = await client<{ spent_cents: number | string }[]>`select spent_cents from workspace_runs where id = ${state.run.id} for no key update`;
    // A full-index run re-indexes documents whose pages may already have paid their base fee through
    // query materialization (stamped on the source version's ledger). Those pages are not charged twice.
    const [row] = await client<{ pages: number }[]>`
      select coalesce(sum(greatest(0, d.page_count - case when ${state.run.kind === "full-index"} then (
        select count(*) from document_page_states s where s.document_id = d.previous_version_id and s.fee_billed_run is not null
      ) else 0 end)), 0)::int as pages
      from documents d
      where d.run_id = ${state.run.id} and d.deduped_from_document_id is null and d.status <> 'failed'
        and (${!deferredProfilesEnabled()} or d.indexing_mode = 'full')
    `;
    const pages = Number(row?.pages ?? 0);
    const costCents = pages * rateCents;
    const inserted = await persistRunUsageEvents({ client, state, usageEvents: [{
      // Run IDs are globally unique; a fixed usage ID also records a zero-rate
      // decision so a retry cannot retroactively apply a changed configuration.
      id: state.run.id, provider: "docslurp", model: "page-base-fee", metric: "page-base-fee",
      amount: pages, unit: "page", costCents,
      metadata: {
        workspaceId: state.run.workspaceId, pages, rateCents, fullRateCents, multiplier,
        costSource: "configured", billable: true,
      },
    }] });
    // The usage_events trigger added `inserted` to spent_cents (0056).
    // Pending debit, applied to the org's pools by the flusher.
    await debitRunUsageCredits({ client, state, costCents: inserted });
    // No credit-lease consumption: the fee is recorded in completeRun after
    // the run turned completed, which already released its lease (0052).
    return (Number(locked?.spent_cents ?? 0) || 0) + inserted;
  }));
  state.run.spentCents = charged;
}

/**
 * Bills pages materialized on demand (deferred indexing). One usage event per
 * (run, document, page) with a deterministic id, so a retried activity or a
 * second query that re-claims a page never charges it twice. Returns the
 * newly billed cost in cents.
 */
export async function recordMaterializedPageFee(
  sql: Sql<Record<string, unknown>>,
  runId: string,
  documentId: string,
  pages: number[],
): Promise<number> {
  const requested = [...new Set(pages)].sort((a, b) => a - b);
  const rateCents = pageBaseFeeRateCents();
  if (requested.length === 0 || rateCents === 0) return 0;
  return sql.begin(async tx => {
    const client = tx as unknown as typeof sql;
    await client`select id from workspace_runs where id = ${runId} for update`;
    // The ledger row is where a page's fee is stamped; create any that are missing (normally ensurePageRows did). A document deleted
    // meanwhile has no ledger to stamp, so its pages are not billed.
    await client`
      insert into document_page_states (document_id, page_number)
      select ${documentId}, p from unnest(${requested}::int[]) as p
      where exists (select 1 from documents where id = ${documentId})
      on conflict (document_id, page_number) do nothing
    `;
    // Lock the pages' ledger rows in page order, then stamp the ones nobody has billed. The stamp is the
    // billing decision: a concurrent run touching the same pages waits on these row locks and, after our commit,
    // sees them stamped. A retry of this run re-owns its own stamps (fee events are idempotent by id).
    await client`
      select page_number from document_page_states
      where document_id = ${documentId} and page_number = any(${requested}::int[])
      order by page_number for update
    `;
    const owned = await client<{ page_number: number }[]>`
      update document_page_states
      set fee_billed_run = ${runId}, fee_billed_at = coalesce(fee_billed_at, now())
      where document_id = ${documentId} and page_number = any(${requested}::int[])
        and (fee_billed_run is null or fee_billed_run = ${runId})
      returning page_number
    `;
    const unique = owned.map(r => r.page_number).sort((x, y) => x - y);
    if (unique.length === 0) return 0;
    const [row] = await client<{ id: string; org_id: string | null; user_id: string; workspace_id: string | null; stats: Record<string, unknown> | null }[]>`
      select id, org_id, user_id, workspace_id, stats from workspace_runs where id = ${runId}
    `;
    if (!row) throw new Error(`run not found: ${runId}`);
    const state = { run: { id: row.id, orgId: row.org_id, userId: row.user_id, workspaceId: row.workspace_id ?? undefined, stats: row.stats ?? {} } } as unknown as WorkflowState;
    const inserted = await persistRunUsageEvents({ client, state, usageEvents: unique.map(page => ({
      id: `${runId}:${documentId}:${page}`, provider: "docslurp", model: "page-base-fee", metric: "page-base-fee",
      amount: 1, unit: "page", costCents: rateCents,
      metadata: { workspaceId: row.workspace_id, documentId, page, rateCents, costSource: "configured", billable: true, materialized: true },
    })) });
    // The usage_events trigger adds `inserted` to the run's spent_cents (0056_run_spent_cents).
    if (inserted > 0) await debitRunUsageCredits({ client, state, costCents: inserted });
    return inserted;
  });
}
