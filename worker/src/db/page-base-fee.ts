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
import type { PipelineUsageBatch, PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { retryTransaction } from "./transaction-retry.js";
import { pipelineTransaction } from "./transaction-pipeline.js";
import { debitRunUsageCredits, persistRunUsageEvents, runUsageEventStatements } from "./usage-event-store.js";

/**
 * Ingest page charges (PRICE_CARD). Pages a vision/OCR model read are charged
 * Rich as they are read (pipeline/usage-ledger.ts). When the run completes,
 * every other page of its completed documents is charged here: Rich for image
 * files and for pages the page facts show as scans (no text layer, an embedded
 * image), Fast otherwise. Quality `fast` never reads a page, so it bills from
 * the usage ledger alone (splitRemainingPages): a page bills Rich only when a
 * Rich read of it was recorded for this run, and every other page bills Fast.
 * Page facts are best effort and never decide a Fast charge.
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
 * Splits a completed document's pages not already charged by a Rich read into Fast and Rich pages.
 *
 * Auto and Good (`pagesRead`): image files and scanned pages (no text layer, an embedded image) bill Rich.
 *
 * Fast bills from the mandatory usage ledger only: every page a reader actually read (OCR, vision, materialization)
 * was charged Rich by the ledger when it was read (`richRead`), so the remaining pages bill Fast. Page facts are
 * optional and best effort (disabled, capped at WORKER_PAGE_FACTS_MAX_PAGES, a failed write), so Fast never consults
 * them.
 */
export function splitRemainingPages(
  row: { image: boolean; pages: number; richRead: number; scanned: number },
  pagesRead: boolean,
): { fast: number; rich: number } {
  const remaining = Math.max(0, row.pages - row.richRead);
  if (!pagesRead) return { fast: remaining, rich: 0 };
  const rich = row.image ? remaining : Math.min(remaining, Math.max(0, row.scanned - row.richRead));
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
      // A stamped page this run read again is already left out through rich_read, so it is not subtracted
      // twice (which would leave another page unbilled).
      // Rich reads are read through usage_attribution (the one spend reader the worker may use).
      client<{ document_id: string; image: boolean; pages: number; rich_read: number; scanned: number }[]>`
      with docs as (
        select d.id, coalesce(d.mime_type, '') like 'image/%' as image,
          greatest(0, d.page_count - case when ${state.run.kind === "full-index"} then (
            select count(*) from document_page_states s where s.document_id = d.previous_version_id and s.fee_billed_run is not null
              -- A stale stamp (its run charged nothing and can no longer commit) paid nothing, so this run charges it.
              and not ${staleStampSql(client)}
              and not exists (select 1 from usage_attribution au
                where au.run_id = ${state.run.id} and au.metric = ${BILLABLE_UNIT_METRICS.richPage}
                  and au.metadata ->> 'documentId' = d.id and au.metadata ->> 'pageNumber' = s.page_number::text)
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
        -- Auto and Good only: Fast bills from the ledger alone (splitRemainingPages).
        case when ${pagesRead} then coalesce((select count(*) from document_page_facts f
          where f.document_id = docs.id and coalesce(f.text_bytes, 0) = 0 and coalesce(f.image_count, 0) > 0), 0) else 0 end::int as scanned
      from docs
    `,
    ], async (client, [lockedRows, rows]) => {
      const locked = lockedRows[0];
      let fastPages = 0;
      let richPages = 0;
      const documents: Record<string, { fast: number; rich: number }> = {};
      for (const row of rows) {
        // Auto/Good: image files are read as images; scanned PDF pages without a vision read still bill Rich.
        // Fast: only pages the ledger recorded as read bill Rich (already charged), so the rest bill Fast.
        const { fast, rich } = splitRemainingPages(
          { image: row.image, pages: Number(row.pages), richRead: Number(row.rich_read), scanned: Number(row.scanned) },
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
 * Bills pages materialized on demand (deferred indexing). One usage event per
 * (run, document, page) with a deterministic id, so a retried activity or a
 * second query that re-claims a page never charges it twice.
 *
 * Opens a transaction, locks the pages' ledger rows, runs `transition` (which
 * moves the pages this run still holds and returns them), then bills them with
 * billLockedMaterializedPages. The materializer publishes and bills in its own
 * transaction (materialize-pages.ts); this entry point serves recovery
 * (`billUnbilled`) and tests.
 * Returns the newly billed credits.
 */
export async function recordMaterializedPageFee(
  sql: Sql<Record<string, unknown>>,
  runId: string,
  documentId: string,
  pages: number[],
  options: {
    ledger?: Pick<PipelineUsageEventLedger, "takeRichPageCharges">;
    /** Moves the pages this run still holds and returns them; only those are stamped and charged. */
    transition?: (client: Sql<Record<string, unknown>>) => Promise<number[]>;
  } = {},
): Promise<number> {
  const requested = [...new Set(pages)].filter((page) => Number.isInteger(page) && page >= 1).sort((a, b) => a - b);
  if (requested.length === 0) return 0;
  let richBatch: PipelineUsageBatch | undefined;
  const billed = await sql.begin(async tx => {
    const client = tx as unknown as typeof sql;
    // The ledger row is where a page's fee is stamped; create any that are missing (normally ensurePageRows did). A document deleted
    // meanwhile has no ledger to stamp, so its pages are not billed.
    await client`
      insert into document_page_states (document_id, page_number)
      select ${documentId}, p from unnest(${requested}::int[]) as p
      where exists (select 1 from documents where id = ${documentId})
      on conflict (document_id, page_number) do nothing
    `;
    await lockPageRows(client, documentId, requested);
    const moved = options.transition ? new Set(await options.transition(client)) : null;
    const outcome = await billLockedMaterializedPages(client, { runId, documentId, requested, moved, ledger: options.ledger });
    richBatch = outcome.richBatch;
    return outcome.inserted;
  });
  richBatch?.commit();
  return billed;
}

/**
 * Locks the pages' ledger rows in page order. Lock order everywhere a materialization transaction bills: page rows
 * first, then the run row (billLockedMaterializedPages), so publications and fee writes of different runs serialize
 * on the pages they share and never deadlock on run rows.
 */
export async function lockPageRows(client: Sql<Record<string, unknown>>, documentId: string, pages: number[]) {
  return await client<{ page_number: number; claimed_by_run: string | null; state: string }[]>`
    select page_number, claimed_by_run, state from document_page_states
    where document_id = ${documentId} and page_number = any(${pages}::int[])
    order by page_number for update
  `;
}

/**
 * The billing decision for materialized pages, inside the caller's transaction, with the pages' ledger rows already
 * locked (lockPageRows). The rule (one customer charge per indexed page):
 *
 * - The `fee_billed_run` stamp is each page's single billing decision, Fast or Rich. Only pages `moved` (the
 *   transition this run committed in the same transaction) are stamped and charged; a run that lost its claim
 *   bills nothing for those pages.
 * - Rich when this run read the page with a model: the ledger's pending Rich charges for the pages it stamps are
 *   persisted here, with the stamps, and a page with a Rich read already recorded for the run (a retry finds the
 *   read an earlier attempt persisted) gets no Fast charge.
 * - Rich, not Fast, when another run's genuine model read of this page of this document version is recorded on the
 *   ledger row (`model_read_run`: a run that read the page, lost its claim and published nothing). The winner's
 *   content came from the text layer, but the read was real and is billed once, through this decision.
 * - Fast otherwise.
 * - `modelReads`: pages this run read with a model (non-empty content) but does not own. If another run's committed
 *   decision for such a page is Fast, this run upgrades it to Rich with one event carrying only the difference
 *   (`rich-upgrade:<document>:<page>`, once per page). If the owner already charged Rich, nothing is added.
 * - This run's pending Rich charges for pages it does not own (lost claim, or another run's stamp stands) are dropped
 *   from the ledger: they stay provider usage (the read's AI usage event), never a customer charge.
 *
 * A stale stamp (staleStampSql: its run recorded no Fast or Rich charge for the page and can no longer commit one) is
 * taken over: it is re-stamped to this run and charged here, so no page stays unbilled. An active stamping run keeps
 * its page. Call `richBatch.commit()` after the transaction commits.
 */
export async function billLockedMaterializedPages(
  client: Sql<Record<string, unknown>>,
  args: {
    runId: string;
    documentId: string;
    requested: number[];
    moved: Set<number> | null;
    ledger?: Pick<PipelineUsageEventLedger, "takeRichPageCharges">;
    modelReads?: Map<number, number>;
  },
): Promise<{ inserted: number; richBatch?: PipelineUsageBatch }> {
  const { runId, documentId, requested, moved } = args;
  const rateCents = pageCredits("fast", 1);
  await client`select id from workspace_runs where id = ${runId} for update`;
  const candidates = moved ? requested.filter((page) => moved.has(page)) : requested;
  const [row] = await client<{ id: string; org_id: string | null; user_id: string; workspace_id: string | null; stats: Record<string, unknown> | null }[]>`
    select id, org_id, user_id, workspace_id, stats from workspace_runs where id = ${runId}
  `;
  if (!row) throw new Error(`run not found: ${runId}`);
  const state = { run: { id: row.id, orgId: row.org_id, userId: row.user_id, workspaceId: row.workspace_id ?? undefined, stats: row.stats ?? {} } } as unknown as WorkflowState;
  const owned = candidates.length === 0 ? [] : (await client<{ page_number: number }[]>`
    update document_page_states s
    set fee_billed_run = ${runId}, fee_billed_at = case when s.fee_billed_run = ${runId} then coalesce(s.fee_billed_at, now()) else now() end
    where s.document_id = ${documentId} and s.page_number = any(${candidates}::int[])
      and (s.fee_billed_run is null or s.fee_billed_run = ${runId} or ${staleStampSql(client)})
    returning s.page_number
  `).map((r) => r.page_number);
  const ownedSet = new Set(owned);
  const modelReads = args.modelReads ?? new Map<number, number>();
  // Pages this run does not own: the claim moved on (not transitioned), another run's stamp stands, or a page it
  // read but never held at publication.
  const foreignSet = new Set([
    ...(moved ? requested.filter((page) => !moved.has(page)) : []),
    ...[...modelReads.keys()].filter((page) => !ownedSet.has(page)),
    ...(await client<{ page_number: number }[]>`
      select page_number from document_page_states
      where document_id = ${documentId} and page_number = any(${requested}::int[])
        and fee_billed_run is not null and fee_billed_run <> ${runId}
    `).map((r) => r.page_number),
  ]);
  // The Rich charges for reads this attempt made land with the stamps they back (ids are deterministic per run
  // and page). Reads of pages another run owns are dropped from the ledger and never charged: the owner bills them.
  const richBatch = args.ledger?.takeRichPageCharges(documentId, (page) => ownedSet.has(page) || foreignSet.has(page));
  const richEvents = richBatch?.events ?? [];
  const chargeable = richEvents.filter((event) => ownedSet.has(Number(event.metadata?.pageNumber)));
  const dropped = richEvents.filter((event) => !ownedSet.has(Number(event.metadata?.pageNumber)));
  if (dropped.length > 0) {
    console.warn(`[page-fee] run=${runId} document=${documentId} dropped Rich charges for pages it does not own: ${dropped.map((event) => event.metadata?.pageNumber).join(",")}`);
  }
  const richInserted = await persistRunUsageEvents({ client, state, usageEvents: chargeable });
  const readRows = await client<{ page: number }[]>`
    select distinct (au.metadata ->> 'pageNumber')::int as page from usage_attribution au
    where au.run_id = ${runId} and au.metric = ${BILLABLE_UNIT_METRICS.richPage}
      and au.metadata ->> 'documentId' = ${documentId}
      and (au.metadata ->> 'pageNumber') ~ '^[0-9]{1,9}$'
  `;
  const rich = new Set(readRows.map((r) => Number(r.page)));
  const undecided = owned.filter((page) => !rich.has(page)).sort((x, y) => x - y);
  // Another run's genuine read of a page this run indexes from its text layer: the page bills Rich, once, here.
  const readElsewhere = undecided.length === 0 ? [] : await client<{ page_number: number; model_read_run: string; model_read_pages: number | null }[]>`
    select page_number, model_read_run, model_read_pages from document_page_states
    where document_id = ${documentId} and page_number = any(${undecided}::int[]) and model_read_run is not null
  `;
  const readElsewhereByPage = new Map(readElsewhere.map((r) => [r.page_number, r]));
  const richDecisions = undecided.filter((page) => readElsewhereByPage.has(page)).map((page) => {
    const read = readElsewhereByPage.get(page)!;
    const pagesRead = Math.max(1, Number(read.model_read_pages) || 1);
    return {
      id: `rich:${runId}:${documentId}:${page}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.richPage,
      amount: pagesRead, unit: "page", costCents: pageCredits("rich", pagesRead),
      metadata: unitChargeMetadata({ workspaceId: row.workspace_id, documentId, pageNumber: page, readBy: "model-read", readRun: read.model_read_run, materialized: true }),
    };
  });
  const fastPages = undecided.filter((page) => !readElsewhereByPage.has(page));
  const decidedInserted = await persistRunUsageEvents({ client, state, usageEvents: [
    ...richDecisions,
    ...fastPages.map(page => ({
      id: `${runId}:${documentId}:${page}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.fastPage,
      amount: 1, unit: "page", costCents: rateCents,
      metadata: unitChargeMetadata({ workspaceId: row.workspace_id, documentId, page, materialized: true }),
    })),
  ] });
  // This run read pages another run decided Fast: upgrade those decisions to Rich (the difference only, once).
  const upgradeCandidates = [...modelReads.keys()].filter((page) => !ownedSet.has(page));
  const upgrades = upgradeCandidates.length === 0 ? [] : await client<{ page_number: number; fee_billed_run: string; fast_id: string }[]>`
    select s.page_number, s.fee_billed_run, fast.id as fast_id
    from document_page_states s
    join lateral (
      select au.id from usage_attribution au
      where au.run_id = s.fee_billed_run and au.metric = ${BILLABLE_UNIT_METRICS.fastPage}
        and au.metadata ->> 'documentId' = s.document_id
        and coalesce(au.metadata ->> 'pageNumber', au.metadata ->> 'page') = s.page_number::text
      limit 1
    ) fast on true
    where s.document_id = ${documentId} and s.page_number = any(${upgradeCandidates}::int[])
      and s.state = 'indexed' and s.fee_billed_run is not null and s.fee_billed_run <> ${runId}
      and not exists (
        select 1 from usage_attribution au
        where au.run_id = s.fee_billed_run and au.metric = ${BILLABLE_UNIT_METRICS.richPage}
          and au.metadata ->> 'documentId' = s.document_id
          and au.metadata ->> 'pageNumber' = s.page_number::text
      )
  `;
  const upgradeInserted = await persistRunUsageEvents({ client, state, usageEvents: upgrades.map((upgrade) => {
    const pagesRead = Math.max(1, modelReads.get(upgrade.page_number) ?? 1);
    return {
      id: `rich-upgrade:${documentId}:${upgrade.page_number}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card",
      metric: BILLABLE_UNIT_METRICS.richPage, amount: pagesRead, unit: "page",
      costCents: Math.max(0, pageCredits("rich", pagesRead) - rateCents),
      metadata: unitChargeMetadata({ workspaceId: row.workspace_id, documentId, pageNumber: upgrade.page_number, readBy: "model-read",
        upgradeOf: upgrade.fast_id, decidedBy: upgrade.fee_billed_run, materialized: true }),
    };
  }) });
  const inserted = richInserted + decidedInserted + upgradeInserted;
  // The usage_events trigger adds `inserted` to the run's spent_cents (0056_run_spent_cents).
  if (inserted > 0) await debitRunUsageCredits({ client, state, costCents: inserted });
  return { inserted, richBatch };
}

/** Runs whose stamps can no longer be backed by a charge: finished, or a worker whose lease expired. */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"];

/**
 * SQL condition on a `document_page_states s` row: a stale stamp. Its stamping run recorded neither a Fast nor
 * a Rich charge for the page, and that run can no longer commit one: it is gone, terminal (completed, failed,
 * cancelled) or its worker's lease expired. Stamps and charges commit together (recordMaterializedPageFee), so
 * such a stamp is a failed fee write, a cancelled run, or a stamp from before that rule; recovery may take the
 * page over (billUnbilled, recordMaterializedPageFee) and a full index charges it (recordPageBaseFee). A live
 * stamping run keeps its page, so a page it read is never charged Fast by another run as well.
 */
export function staleStampSql(client: Sql<Record<string, unknown>>) {
  return client`(s.fee_billed_run is not null and not exists (
    select 1 from usage_attribution au
    where au.run_id = s.fee_billed_run
      and au.metric in (${BILLABLE_UNIT_METRICS.fastPage}, ${BILLABLE_UNIT_METRICS.richPage})
      and au.metadata ->> 'documentId' = s.document_id
      and coalesce(au.metadata ->> 'pageNumber', au.metadata ->> 'page') = s.page_number::text
  ) and not exists (
    select 1 from workspace_runs owner
    where owner.id = s.fee_billed_run
      and owner.status <> all(${client.array(TERMINAL_RUN_STATUSES)}::text[])
      and (owner.lease_expires_at is null or owner.lease_expires_at > now())
  ))`;
}
