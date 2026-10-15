import type { Sql } from "postgres";
import { compilePipelinePlan, type CompiledPipelinePlan, type PipelineRunStage } from "@docslurp/shared";
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
    const [row] = await client<{ pages: number }[]>`
      select coalesce(sum(page_count), 0)::int as pages from documents
      where run_id = ${state.run.id} and deduped_from_document_id is null and status <> 'failed'
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
