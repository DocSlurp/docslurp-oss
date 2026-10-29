import type { Sql } from "postgres";
import {
  BILLABLE_UNIT_METRICS,
  UNIT_CHARGE_PROVIDER,
  compilePipelinePlan,
  deferredProfilesEnabled,
  pageCredits,
  qualityAllowsPageReading,
  unitChargeMetadata,
  type CompiledPipelinePlan,
  type PipelineRunStage,
} from "@docslurp/shared";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { retryTransaction } from "./transaction-retry.js";
import { pipelineTransaction } from "./transaction-pipeline.js";
import { debitRunUsageCredits, persistRunUsageEvents, runUsageEventStatements } from "./usage-event-store.js";

/**
 * Ingest page charges (PRICE_CARD). Pages a vision/OCR model read are charged
 * Rich as they are read (pipeline/usage-ledger.ts). When the run completes,
 * every other page of its completed documents is charged here: Rich for image
 * files and for pages the page facts show as scans (no text layer, an embedded
 * image), Fast otherwise. Quality `fast` never reads a page (pages without a
 * text layer are kept as page images); its pages bill Fast only on evidence
 * they were not read (splitRemainingPages), so a page that was read anyway
 * still bills Rich.
 * Audio and video bill by the minute (media stage).
 *
 * Stages that only rebuild indexes from existing content. A partial run that
 * executes nothing else is a reindex: its embeddings are mostly reused, so it
 * pays no page charge.
 */
const INDEX_ONLY_STAGES: ReadonlySet<PipelineRunStage> = new Set([
  "pii-detect", "embed", "graph-enrich", "page-index", "index",
]);

/**
 * Share of the completion page charge a run pays. Full runs pay 1. Partial
 * reprocess runs pay the fraction of enabled stages they execute (reused
 * stages are free), and reindex-only runs pay 0.
 */
export function pageBaseFeeMultiplier(plan: Pick<CompiledPipelinePlan, "stageOrder" | "reusedStages">): number {
  if (plan.reusedStages.length === 0) return 1;
  if (plan.stageOrder.every((stage) => INDEX_ONLY_STAGES.has(stage))) return 0;
  const enabled = plan.stageOrder.length + plan.reusedStages.length;
  return Math.round((plan.stageOrder.length / enabled) * 100) / 100;
}

/**
 * Splits a completed document's pages not already charged by a Rich read into Fast and Rich pages, by what the run
 * observed rather than the mode it declared.
 *
 * Auto and Good (`pagesRead`): image files and scanned pages (no text layer, an embedded image) bill Rich.
 *
 * Fast never reads a page, and bills one Fast only with evidence it was not read: a page with a native text layer,
 * or one Fast recorded as kept as an image or left unread (page facts `kept-as-image` / `not-read`, written by
 * render-images). Everything else that could have been read bills Rich, fail closed: a scanned page that ended up
 * with text and no such status (something OCR'd it), and an image file not recorded as kept (`fastUnread` = 0).
 */
export function splitRemainingPages(
  row: { image: boolean; pages: number; richRead: number; scanned: number; scannedRead?: number; fastUnread?: number },
  pagesRead: boolean,
): { fast: number; rich: number } {
  const remaining = Math.max(0, row.pages - row.richRead);
  let rich: number;
  if (pagesRead) {
    rich = row.image ? remaining : Math.min(remaining, Math.max(0, row.scanned - row.richRead));
  } else if (row.image) {
    rich = (row.fastUnread ?? 0) > 0 ? 0 : remaining;
  } else {
    rich = Math.min(remaining, Math.max(0, (row.scannedRead ?? row.scanned) - row.richRead));
  }
  return { fast: remaining - rich, rich };
}

export type RunPageCharges = { fastPages: number; richPages: number; multiplier: number; credits: number };

/**
 * Charge the run's remaining pages once it completes (deterministic ids per
 * run, so a retry charges nothing twice), excluding content-deduplicated,
 * failed and media documents and pages a vision/OCR read already charged Rich.
 */
export async function recordPageBaseFee(sql: Sql<Record<string, unknown>>, state: WorkflowState): Promise<RunPageCharges> {
  const multiplier = pageBaseFeeMultiplier(compilePipelinePlan(state.run.pipeline));
  let charges: RunPageCharges = { fastPages: 0, richPages: 0, multiplier, credits: 0 };
  const pagesRead = qualityAllowsPageReading(state.run.pipeline.quality);
  const charged = await retryTransaction(`page-charges run=${state.run.id}`, async () => {
    let total = 0;
    await pipelineTransaction(sql, (client) => [
      // FOR NO KEY UPDATE: serializes charge recording without blocking FK checks on child rows.
      client<{ spent_cents: number | string }[]>`select spent_cents from workspace_runs where id = ${state.run.id} for no key update`,
      // A full-index run re-indexes documents whose pages may already have paid through query
      // materialization (stamped on the source version's ledger). Those pages are not charged twice.
      // Rich reads are read through usage_attribution (the one spend reader the worker may use).
      client<{ document_id: string; image: boolean; pages: number; rich_read: number; scanned: number; scanned_read: number; fast_unread: number }[]>`
      with docs as (
        select d.id, coalesce(d.mime_type, '') like 'image/%' as image,
          greatest(0, d.page_count - case when ${state.run.kind === "full-index"} then (
            select count(*) from document_page_states s where s.document_id = d.previous_version_id and s.fee_billed_run is not null
          ) else 0 end)::int as pages
        from documents d
        where d.run_id = ${state.run.id} and d.deduped_from_document_id is null and d.status <> 'failed'
          and coalesce(d.mime_type, '') not like 'audio/%' and coalesce(d.mime_type, '') not like 'video/%'
          and (${!deferredProfilesEnabled()} or d.indexing_mode = 'full')
      )
      select docs.id as document_id, docs.image, docs.pages,
        coalesce((select count(distinct au.id) from usage_attribution au
          where au.run_id = ${state.run.id} and au.metric = ${BILLABLE_UNIT_METRICS.richPage}
            and au.metadata ->> 'documentId' = docs.id), 0)::int as rich_read,
        coalesce((select count(*) from document_page_facts f
          where f.document_id = docs.id and coalesce(f.text_bytes, 0) = 0 and coalesce(f.image_count, 0) > 0), 0)::int as scanned,
        -- Fast: scanned pages without evidence they stayed unread (see splitRemainingPages).
        coalesce((select count(*) from document_page_facts f
          where f.document_id = docs.id and coalesce(f.text_bytes, 0) = 0 and coalesce(f.image_count, 0) > 0
            and coalesce(f.vision_status, '') not in ('kept-as-image', 'not-read')), 0)::int as scanned_read,
        coalesce((select count(*) from document_page_facts f
          where f.document_id = docs.id and f.vision_status in ('kept-as-image', 'not-read')), 0)::int as fast_unread
      from docs
    `,
    ], async (client, [lockedRows, rows]) => {
      const locked = lockedRows[0];
      let fastPages = 0;
      let richPages = 0;
      const documents: Record<string, { fast: number; rich: number }> = {};
      for (const row of rows) {
        // Image files are read as images; scanned PDF pages without a vision read still bill Rich. Fast bills by
        // what it observed: only pages shown unread or with a text layer bill Fast.
        const { fast, rich } = splitRemainingPages(
          {
            image: row.image, pages: Number(row.pages), richRead: Number(row.rich_read), scanned: Number(row.scanned),
            scannedRead: Number(row.scanned_read), fastUnread: Number(row.fast_unread),
          },
          pagesRead,
        );
        fastPages += fast;
        richPages += rich;
        if (fast > 0 || rich > 0) documents[row.document_id] = { fast, rich };
      }
      const fastCredits = pageCredits("fast", fastPages) * multiplier;
      const richCredits = pageCredits("rich", richPages) * multiplier;
      charges = { fastPages, richPages, multiplier, credits: fastCredits + richCredits };
      const base = { workspaceId: state.run.workspaceId, multiplier, documents: Object.keys(documents).length <= 200 ? documents : undefined };
      // The insert and its pending debit (for exactly the rows it inserted) are one statement.
      const usage = runUsageEventStatements({ client, state, usageEvents: [
        // A fixed id per run also records a zero-page decision, so a retry cannot change it.
        {
          id: `fast:${state.run.id}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.fastPage,
          amount: fastPages, unit: "page", costCents: fastCredits, metadata: unitChargeMetadata({ ...base, pages: fastPages }),
        },
        ...(richPages > 0 ? [{
          id: `rich-scan:${state.run.id}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.richPage,
          amount: richPages, unit: "page", costCents: richCredits, metadata: unitChargeMetadata({ ...base, pages: richPages, readBy: "scan-or-image" }),
        }] : []),
      ] });
      const inserted = usage.cost(await Promise.all(usage.statements.map((statement) => statement.execute())));
      // The usage_events trigger added `inserted` to spent_cents (0056).
      // Pending debit, applied to the org's balance by the flusher.
      // No credit-lease consumption: the charge is recorded in completeRun after
      // the run turned completed, which already released its lease (0052).
      total = (Number(locked?.spent_cents ?? 0) || 0) + inserted;
    });
    return total;
  });
  state.run.spentCents = charged;
  return charges;
}

/**
 * Bills pages materialized on demand (deferred indexing) as Fast pages. One
 * usage event per (run, document, page) with a deterministic id, so a retried
 * activity or a second query that re-claims a page never charges it twice.
 * Pages in `richPages` were read by OCR and already charged Rich by the usage
 * ledger, so they get no Fast charge. Returns the newly billed credits.
 */
export async function recordMaterializedPageFee(
  sql: Sql<Record<string, unknown>>,
  runId: string,
  documentId: string,
  pages: number[],
  richPages: ReadonlySet<number> = new Set(),
): Promise<number> {
  const requested = [...new Set(pages)].filter((page) => !richPages.has(page)).sort((a, b) => a - b);
  const rateCents = pageCredits("fast", 1);
  if (requested.length === 0) return 0;
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
      id: `${runId}:${documentId}:${page}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.fastPage,
      amount: 1, unit: "page", costCents: rateCents,
      metadata: unitChargeMetadata({ workspaceId: row.workspace_id, documentId, page, materialized: true }),
    })) });
    // The usage_events trigger adds `inserted` to the run's spent_cents (0056_run_spent_cents).
    if (inserted > 0) await debitRunUsageCredits({ client, state, costCents: inserted });
    return inserted;
  });
}
