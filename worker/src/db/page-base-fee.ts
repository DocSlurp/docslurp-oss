import type { Sql } from "postgres";
import {
  BILLABLE_UNIT_METRICS,
  PAGE_CHARGE_METRICS,
  PAGE_READ_METRICS,
  UNIT_CHARGE_PROVIDER,
  speedBoostMultiplier,
  compilePipelinePlan,
  deferredProfilesEnabled,
  pageCredits,
  pricing,
  pricingVersion,
  unitChargeMetadata,
  type CompiledPipelinePlan,
  type PipelineFeatures,
  type PipelineRunStage,
} from "@docslurp/shared";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { billableCents, type PipelineUsageBatch, type PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { retryTransaction } from "./transaction-retry.js";
import { pipelineTransaction, pipelineInTransaction } from "./transaction-pipeline.js";
import { debitRunUsageCredits, persistRunUsageEvents, runUsageEventStatements, type RunUsageState } from "./usage-event-store.js";

/**
 * Ingest page charges (priced by the pricing provider). Runs started by this release pin the per-read rule below
 * (`pinRunPageBillingRules`, from `startRun`). One rule, per page: a page bills OCR when the OCR route read it and Rich when a
 * vision model read it (an OCR page a vision model then reads is upgraded to Rich, once), and the usage ledger records that
 * read per page (pipeline/usage-ledger.ts, charged as the page is read). When the run completes, every other page of its
 * completed documents is charged here, Fast. Nothing about a page's content
 * (a scan, an image, a missing text layer) bills Rich by itself: those facts are best effort (page facts can be
 * disabled, capped or fail) and an unknown fact must never raise a charge. An uploaded image file is read by OCR or
 * vision, which the extraction stage records on the ledger like any other read.
 * Audio and video bill by the minute (media stage).
 *
 * A run without the pin (started by a release before the per-read rule, or a state whose pin is missing) bills by the same
 * rule. The earlier release's completion rule billed image files and pages without text bytes Rich here, from page facts
 * alone, and read an unknown text size as none; it is retired (DocSlurp/app issue 601): a missing pin or a missing fact
 * never raises a page's class, and a page nothing read bills Fast, never nothing.
 */

/**
 * Share of the completion page charge a run pays, from the pricing provider: a full run's share, and a partial
 * reprocess run's for the stages it executes and reuses. Clamped to [0, 1]: a provider can lower a run's page
 * charge, never raise it above a full run's.
 */
export function pageBaseFeeMultiplier(plan: Pick<CompiledPipelinePlan, "stageOrder" | "reusedStages">): number {
  const share = pricing().pageChargeShare({ stageOrder: plan.stageOrder, reusedStages: plan.reusedStages });
  if (!Number.isFinite(share)) throw new Error("pricing provider returned an invalid page charge share");
  return Math.min(1, Math.max(0, share));
}

/**
 * Fast pages of a completed document: its pages (1..page_count) that no OCR or Rich read of this run covers. `richRead` is
 * the number of distinct pages in that range a read charged (OCR or Rich), counted by page number, so a read outside the
 * document's pages (or a page read twice, or by OCR then vision) can never cancel another page's Fast charge.
 */
export function remainingFastPages(row: { pages: number; richRead: number }): number {
  return Math.max(0, row.pages - Math.min(row.richRead, row.pages));
}

/**
 * Version of the page billing rules this code settles by: 2 is the OCR page class (Fast, OCR, Rich). Every Fast charge
 * carries it (`metadata.pageRules`); the database refuses a Fast charge without it for a run that has OCR charges
 * (migration 0185), so a worker from before the OCR class can never bill a run's OCR pages Fast as well. Its activity
 * fails and is retried by a current worker.
 */
export const PAGE_BILLING_RULES_VERSION = 2;

/** Run artifact slot holding the page billing rules the run started under: the pricing version of the per-read rule. */
export const PAGE_BILLING_RULES_SLOT = "run:page-billing-rules";

type RunArtifactsState = { artifactLedger: Pick<WorkflowState["artifactLedger"], "read" | "record"> };

/**
 * Pins the run to the per-read page rule unless it already has a pin, persisted with the run's artifacts by the caller's
 * next progress write. Called by `startRun` before any stage executes; idempotent, so a retried start keeps the first value.
 */
export function pinRunPageBillingRules(state: RunArtifactsState): string {
  const stored = state.artifactLedger.read(PAGE_BILLING_RULES_SLOT);
  if (stored) return stored;
  const version = pricingVersion();
  state.artifactLedger.record(PAGE_BILLING_RULES_SLOT, version);
  return version;
}

/**
 * Whether the run has no page billing pin (started by a release before the per-read rule). The rule-retirement release (DocSlurp/app
 * issue 601) bills such a run like any other, but a worker of the release before it, completing the same run in a mixed fleet,
 * still bills pages without text bytes Rich from page-facts rows; so page facts are not written for these runs (extract-markdown
 * recordDopplerFactsEvidence) for one more release. Delete this and its caller in the release after the retirement ships, once no
 * worker of the earlier release can complete a run.
 */
export function runHasNoPageBillingPin(state: RunArtifactsState): boolean {
  return !state.artifactLedger.read(PAGE_BILLING_RULES_SLOT);
}

/**
 * What a terminal charge decided: `fastPages` it charged now, `ocrPages` and `richPages` already charged as they were read
 * (counted, not charged here; a page upgraded from OCR to Rich counts as Rich), the share of the fee this run pays and the
 * Fast credits it charged. `fastPagesOwed` is every Fast page the run's billed documents owe, `fastPagesCharged` what earlier
 * terminal charges of the run already covered, and `unmeasuredDocuments` the billed documents whose page count is still an
 * intake estimate (they bill nothing until measured; see recordPageBaseFee).
 */
export type RunPageCharges = {
  fastPages: number; ocrPages: number; richPages: number; multiplier: number; credits: number;
  fastPagesOwed?: number; fastPagesCharged?: number; unmeasuredDocuments?: number;
};

/** How a run's execution generation ended: its terminal transaction (run-ledger finalizeRun) calls recordPageBaseFee. */
export type PageBaseFeeTerminal = {
  /**
   * `completed`: completeRun, every document not failed is being completed in the same transaction. `failed`: failRun (a
   * failure or a cancel), only documents already completed (indexed, searchable) bill; the others never completed.
   */
  outcome: "completed" | "failed";
  /** The execution generation ending (ExecutionOwner.executionGeneration); a resumed run starts a new one. */
  generation?: string | null;
};

/** The run's first Fast charge: the id every release has written, so an older worker's charge and this one's are one row. */
export function firstFastChargeId(runId: string): string {
  return `fast:${runId}`;
}

/** A later terminal charge of the same run (a resumed or retried run): only the Fast pages earlier charges did not cover. */
export function fastChargeDeltaId(runId: string, generation: string | null | undefined): string {
  return `fast:${runId}:g:${generation ?? "none"}`;
}

/**
 * Fast pages a terminal charge owes now: what the run's billed documents owe in all, less what its earlier Fast charges (and an
 * earlier release's `rich-scan:` charge, which billed some of those pages Rich instead) already covered. Never negative: a
 * document never earns a refund here, and pages charged once are never charged again.
 */
export function fastPagesDue(owed: number, charged: number): number {
  return Math.max(0, Math.trunc(owed) - Math.max(0, Math.trunc(charged)));
}

/**
 * Charge the Fast pages of a run's billed documents when one of its execution generations ends (completeRun or failRun, inside
 * the terminal transaction). Excludes content-deduplicated, failed and media documents and pages an OCR or vision read already
 * charged (OCR or Rich).
 *
 * Exactly once per page, however the run ends and however often it is resumed:
 * - the charge is a delta. Inside the transaction, after locking the run row, it sums the Fast pages the run's earlier terminal
 *   charges recorded (`fast:<run>` and `fast:<run>:g:<generation>`, plus a pre-OCR-class `rich-scan:<run>`) and charges only
 *   what the documents owe beyond that. A retried run's earlier documents are covered; its retried documents are not, so they
 *   bill now. A completed document stays completed when its run is resumed, so what it owes never changes between charges.
 * - the first charge of a run keeps the id every release writes (`fast:<run>`), so an older worker that completes the same run
 *   conflicts on it (charging nothing twice); later charges are `fast:<run>:g:<generation>`, one per generation.
 * - terminal transactions are once per generation (finalizeRun's receipt), refuse a stale generation (ownership check), and lock
 *   the run row before reading earlier charges, so a cancel racing a completion, or two workers finishing the same run, serialize
 *   and the second sees the first's charge.
 * The pending debit rides on the insert, as for every charge: a run that already indexed its documents records the debt rather
 * than refusing it (a cancelled run's searchable documents are billed like a completed run's).
 */
export async function recordPageBaseFee(
  sql: Sql<Record<string, unknown>>,
  state: WorkflowState,
  transaction?: { afterCommit: Array<() => void> },
  terminal: PageBaseFeeTerminal = { outcome: "completed" },
): Promise<RunPageCharges> {
  const multiplier = pageBaseFeeMultiplier(compilePipelinePlan(state.run.pipeline));
  let charges: RunPageCharges = { fastPages: 0, ocrPages: 0, richPages: 0, multiplier, credits: 0 };
  if (runHasNoPageBillingPin(state)) {
    console.warn(`[page-charges] run=${state.run.id} has no page billing pin: billing its recorded reads and Fast for every other page`);
  }
  const runId = state.run.id;
  const firstId = firstFastChargeId(runId);
  const deltaPrefix = `${firstId}:`;
  const write = async () => {
    let total = 0;
    await (transaction ? pipelineInTransaction : pipelineTransaction)(sql, (client) => [
      // FOR NO KEY UPDATE: serializes charge recording without blocking FK checks on child rows.
      client<{ spent_cents: number | string }[]>`select spent_cents from project_runs where id = ${runId} for no key update`,
      // A full-index run re-indexes documents whose pages may already have paid through query
      // materialization (stamped on the source version's ledger). Those pages are not charged twice.
      // A stamped page this run read again is already left out through rich_read, so it is not subtracted
      // twice (which would leave another page unbilled).
      // OCR and Rich reads are read through usage_attribution (the one spend reader the worker may use).
      client<{ document_id: string; pages: number; measured: boolean; rich_read: number; rich_only: number }[]>`
      with docs as (
        -- billing_pages: the worker's measured count of an Office, slide, sheet or EPUB file; page_count (the page basis the text
        -- splits into) bills for every other document.
        select d.id, d.page_count as page_count,
          -- Only measured counts bill: the worker's billing_pages, or a page_count counted from the bytes or by the worker. A count
          -- still assumed (an intake estimate: a PDF's size, a sampled text file, an Office file's one page) bills nothing here,
          -- and is reported (unmeasuredDocuments), never guessed.
          (d.billing_pages is not null or d.page_count_source = 'counted') as measured,
          greatest(0, coalesce(d.billing_pages, d.page_count) - case when ${state.run.kind === "full-index"} then (
            select count(*) from document_page_states s where s.document_id = d.previous_version_id
              -- A stale stamp (its run charged nothing and can no longer commit) paid nothing, so this run charges it.
              -- A page whose read was charged and then failed (read_billed_run) paid its one charge.
              and ((s.fee_billed_run is not null and not ${staleStampSql(client)}) or s.read_billed_run is not null)
              and not exists (select 1 from usage_attribution au
                where au.run_id = ${runId} and au.metric = any(${[...PAGE_READ_METRICS]}::text[])
                  and au.metadata ->> 'documentId' = d.id and au.metadata ->> 'pageNumber' = s.page_number::text)
          ) else 0 end)::int as pages
        from documents d
        where d.run_id = ${runId} and ${billedDocumentSql(client, terminal.outcome)}
          and coalesce(d.mime_type, '') not like 'audio/%' and coalesce(d.mime_type, '') not like 'video/%'
          and (${!deferredProfilesEnabled()} or d.indexing_mode = 'full')
      )
      select docs.id as document_id, docs.pages, docs.measured,
        -- Distinct pages of this document a read charged (OCR or Rich): by page number, inside the document's pages.
        coalesce((select count(distinct (au.metadata ->> 'pageNumber')::int) from usage_attribution au
          where docs.measured and au.run_id = ${runId} and au.metric = any(${[...PAGE_READ_METRICS]}::text[])
            and au.metadata ->> 'documentId' = docs.id
            and (au.metadata ->> 'pageNumber') ~ '^[0-9]{1,9}$'
            and (au.metadata ->> 'pageNumber')::int between 1 and docs.page_count), 0)::int as rich_read,
        -- Of those, the pages a Rich read charged (an OCR page upgraded to Rich counts here), for the report.
        coalesce((select count(distinct (au.metadata ->> 'pageNumber')::int) from usage_attribution au
          where docs.measured and au.run_id = ${runId} and au.metric = ${BILLABLE_UNIT_METRICS.richPage}
            and au.metadata ->> 'documentId' = docs.id
            and (au.metadata ->> 'pageNumber') ~ '^[0-9]{1,9}$'
            and (au.metadata ->> 'pageNumber')::int between 1 and docs.page_count), 0)::int as rich_only
      from docs
    `,
      // The Fast pages earlier terminal charges of this run covered (read after the run row lock above, so a concurrent terminal
      // charge of the run has committed or not started). An earlier release's completion billed some pages Rich instead
      // (`rich-scan:<run>`): those are covered too. Scoped to the run and its organization.
      client<{ first: number; pages: string | number }[]>`
      select count(*) filter (where au.id = ${firstId})::int as first, coalesce(sum(au.amount), 0)::text as pages
      from usage_attribution au
      where au.run_id = ${runId} and (${state.run.orgId ?? null}::text is null or au.org_id = ${state.run.orgId ?? null})
        and ((au.metric = ${BILLABLE_UNIT_METRICS.fastPage} and (au.id = ${firstId} or left(au.id, ${deltaPrefix.length}) = ${deltaPrefix}))
          or (au.metric = ${BILLABLE_UNIT_METRICS.richPage} and au.id = ${`rich-scan:${runId}`}))
    `,
    ], async (client, [lockedRows, rows, priorRows]) => {
      const locked = lockedRows[0];
      let owed = 0;
      const unmeasured: string[] = [];
      // Report shape kept for readers of `documents` (`rich` is always 0 here: Rich pages are charged as they are read).
      const documents: Record<string, { fast: number; rich: number }> = {};
      for (const row of rows) {
        if (!row.measured) {
          unmeasured.push(row.document_id);
          continue;
        }
        const fast = remainingFastPages({ pages: Number(row.pages), richRead: Number(row.rich_read) });
        owed += fast;
        if (fast > 0) documents[row.document_id] = { fast, rich: 0 };
      }
      if (unmeasured.length > 0) {
        // Visible, never guessed: a billed document whose page count is still an intake estimate bills no Fast page here.
        console.warn(`[page-charges] run=${runId} unmeasured-documents=${unmeasured.length} billed-pages=0 documents=${unmeasured.slice(0, 20).join(",")}${unmeasured.length > 20 ? ",..." : ""}`);
      }
      const prior = priorRows[0];
      const first = !(Number(prior?.first ?? 0) > 0);
      const charged = Number(prior?.pages ?? 0) || 0;
      const fastPages = fastPagesDue(owed, charged);
      // OCR and Rich pages are charged as they are read (the ledger); here they are only counted, for the report: the distinct
      // pages of the billed documents a read charged this run, inside each document's pages. A page OCR read and a vision
      // model then upgraded counts as Rich.
      const measuredRows = rows.filter((row) => row.measured);
      const readPages = measuredRows.reduce((sum, row) => sum + Math.min(Number(row.rich_read) || 0, Number(row.pages) || 0), 0);
      const richPages = measuredRows.reduce((sum, row) => sum + Math.min(Number(row.rich_only) || 0, Number(row.rich_read) || 0, Number(row.pages) || 0), 0);
      const ocrPages = Math.max(0, readPages - richPages);
      const fastCredits = pageCredits("fast", fastPages) * multiplier;
      charges = { fastPages, ocrPages, richPages, multiplier: multiplier * speedBoostMultiplier(state.usageLedger.speedBoost),
        credits: fastCredits * speedBoostMultiplier(state.usageLedger.speedBoost),
        fastPagesOwed: owed, fastPagesCharged: charged, unmeasuredDocuments: unmeasured.length };
      // The run's first charge records its decision even at zero pages on completion (an older worker completing the run later
      // conflicts on it). A failed generation with nothing to bill, and a later generation with nothing new, write nothing.
      const writeRow = fastPages > 0 || (first && terminal.outcome === "completed");
      const base = { projectId: state.run.projectId, multiplier, documents: Object.keys(documents).length <= 200 ? documents : undefined };
      const usage = runUsageEventStatements({ client, state, usageEvents: writeRow ? [
        {
          id: first ? firstId : fastChargeDeltaId(runId, terminal.generation), provider: UNIT_CHARGE_PROVIDER, model: "price-card",
          metric: BILLABLE_UNIT_METRICS.fastPage, amount: fastPages, unit: "page", costCents: fastCredits,
          metadata: unitChargeMetadata({ ...base, pages: fastPages, pageRules: PAGE_BILLING_RULES_VERSION,
            ...(first ? {} : { owedPages: owed, chargedPages: charged, generation: terminal.generation ?? null }),
            ...(terminal.outcome === "failed" ? { runOutcome: "failed" } : {}) }),
        },
      ] : [] });
      // The insert and its pending debit (for exactly the rows it inserted) are one statement.
      const inserted = usage.cost(await Promise.all(usage.statements.map((statement) => statement.execute())));
      // The usage_events trigger added `inserted` to spent_cents (0056).
      // Pending debit, applied to the org's balance by the flusher.
      // No credit-lease consumption: the charge is recorded after the run turned terminal (completed or failed), which already
      // released its lease (0052).
      total = (Number(locked?.spent_cents ?? 0) || 0) + inserted;
    });
    return total;
  };
  const charged = transaction ? await write() : await retryTransaction(`page-charges run=${runId}`, write);
  const commit = () => { state.run.spentCents = charged; };
  if (transaction) transaction.afterCommit.push(commit);
  else commit();
  return charges;
}

/**
 * The documents a terminal charge bills (`documents d`). The one place that decides which of a run's documents owe Fast pages:
 * not content-deduplicated copies (they pay nothing of their own here), and by how the generation ended. A completing run bills
 * every document it does not leave failed (they are completed in the same transaction); a failed or cancelled one only those
 * already completed, which search serves whatever the run's status (a document that never completed bills nothing).
 */
function billedDocumentSql(client: Sql<Record<string, unknown>>, outcome: PageBaseFeeTerminal["outcome"]) {
  const status = outcome === "completed" ? client`d.status <> 'failed'` : client`d.status = 'completed'`;
  return client`d.deduped_from_document_id is null and ${status}`;
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
  return await client<{ page_number: number; claimed_by_run: string | null; state: string; read_text: string | null }[]>`
    select page_number, claimed_by_run, state, read_text from document_page_states
    where document_id = ${documentId} and page_number = any(${pages}::int[])
    order by page_number for update
  `;
}

/**
 * The billing decision for materialized pages, inside the caller's transaction, with the pages' ledger rows already
 * locked (lockPageRows). The rule (one customer charge per indexed page):
 *
 * - The `fee_billed_run` stamp is each page's single billing decision, Fast, OCR or Rich. Only pages `moved` (the
 *   transition this run committed in the same transaction) are stamped and charged; a run that lost its claim
 *   bills nothing for those pages.
 * - OCR or Rich when this run read the page (the OCR route, or a vision model): the ledger's pending read charges for the
 *   pages it stamps are persisted here, with the stamps, and a page with a read already recorded for the run (a retry
 *   finds the read an earlier attempt persisted) gets no Fast charge.
 * - Rich, not Fast, when another run's genuine model read of this page of this document version is recorded on the
 *   ledger row (`model_read_run`: a run that read the page, lost its claim and published nothing). The winner's
 *   content came from the text layer, but the read was real and is billed once, through this decision.
 * - Fast otherwise.
 * - `modelReads`: pages this run read with a model (non-empty content) but does not own. If another run's committed
 *   decision for such a page is Fast or OCR, this run upgrades it to Rich with one event carrying only the difference
 *   from that decision (`rich-upgrade:<document>:<page>`, once per page). If the owner already charged Rich, nothing is added.
 * - This run's pending Rich charges for pages it does not own (lost claim, or another run's stamp stands) are dropped
 *   from the ledger: they stay provider usage (the read's AI usage event), never a customer charge.
 * - `failedReads`: pages this run holds, read with a model (a pending Rich charge) and then failed after the read
 *   (embedding, vector write, PII). The Rich charge is persisted here and the page row records it (`read_billed_run`,
 *   plus `read_text` for a retry to reuse), unless the page already carries a decision (`read_billed_run` or another
 *   run's `fee_billed_run`), in which case the read stays provider usage.
 * - A page whose `read_billed_run` is set already paid its one charge for this document version: the run that indexes
 *   it stamps it with no new charge (no Fast, no `model_read_run` Rich, no upgrade), and its own pending Rich read of
 *   the page is dropped (provider usage).
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
    /** Pages this run holds that failed after a charged model read, with the read text to keep (null: none). */
    failedReads?: Map<number, string | null>;
  },
): Promise<{ inserted: number; credits: number; richBatch?: PipelineUsageBatch }> {
  const { runId, documentId, requested, moved } = args;
  const rateCents = pageCredits("fast", 1);
  await client`select id from project_runs where id = ${runId} for update`;
  const candidates = moved ? requested.filter((page) => moved.has(page)) : requested;
  const [row] = await client<{ id: string; org_id: string | null; user_id: string; project_id: string | null; stats: Record<string, unknown> | null; pipeline: PipelineFeatures }[]>`
    select r.id, coalesce(r.org_id, (select w.org_id from projects w where w.id = r.project_id)) as org_id,
      r.user_id, r.project_id, r.stats, r.pipeline from project_runs r where r.id = ${runId}
  `;
  if (!row) throw new Error(`run not found: ${runId}`);
  // This path has no WorkflowState: take pricing from the locked run snapshot,
  // never a caller's mutable project configuration or a fabricated ledger.
  speedBoostMultiplier(row.pipeline.speedBoost);
  const state: RunUsageState = {
    run: { id: row.id, orgId: row.org_id, userId: row.user_id, projectId: row.project_id ?? undefined, stats: row.stats ?? {} },
    usageLedger: { speedBoost: row.pipeline.speedBoost === true },
  };
  const owned = candidates.length === 0 ? [] : (await client<{ page_number: number }[]>`
    update document_page_states s
    set fee_billed_run = ${runId}, fee_billed_at = case when s.fee_billed_run = ${runId} then coalesce(s.fee_billed_at, now()) else now() end
    where s.document_id = ${documentId} and s.page_number = any(${candidates}::int[])
      and (s.fee_billed_run is null or s.fee_billed_run = ${runId} or ${staleStampSql(client)})
    returning s.page_number
  `).map((r) => r.page_number);
  const ownedSet = new Set(owned);
  const modelReads = args.modelReads ?? new Map<number, number>();
  const failedReads = args.failedReads ?? new Map<number, string | null>();
  // Pages whose one charge an earlier read already made (it failed after the read). This run's own earlier attempt
  // (same run id) persisted that charge under the same deterministic id, so a repeat is a no-op.
  const decidedPages = [...new Set([...requested, ...failedReads.keys()])];
  const readBilled = decidedPages.length === 0 ? [] : await client<{ page_number: number; read_billed_run: string | null; fee_billed_run: string | null }[]>`
    select page_number, read_billed_run, fee_billed_run from document_page_states
    where document_id = ${documentId} and page_number = any(${decidedPages}::int[])
  `;
  const readBilledBy = new Map(readBilled.filter((r) => r.read_billed_run !== null).map((r) => [r.page_number, r.read_billed_run!]));
  const billedElsewhere = new Set([...readBilledBy].filter(([, run]) => run !== runId).map(([page]) => page));
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
  const richBatch = args.ledger?.takeRichPageCharges(documentId, (page) => ownedSet.has(page) || foreignSet.has(page) || failedReads.has(page));
  const richEvents = richBatch?.events ?? [];
  // A failed read becomes the page's one charge only when the page has no decision yet, and only when a Rich charge
  // backs it: a chargeable Rich event in this batch, or one this run already committed for the page. A read whose
  // charge the ledger never buffered (or already dropped) leaves the page undecided, so a later run bills it.
  const feeRunByPage = new Map(readBilled.map((r) => [r.page_number, r.fee_billed_run]));
  const undecidedFailedReads = [...failedReads.keys()].filter((page) => !readBilledBy.has(page) && feeRunByPage.get(page) == null);
  const pendingRichPages = new Set(richEvents.filter((event) => billableCents(event) > 0).map((event) => Number(event.metadata?.pageNumber)));
  const needCommitted = undecidedFailedReads.filter((page) => !pendingRichPages.has(page));
  const committedRichPages = new Set(needCommitted.length === 0 ? [] : (await client<{ page: number }[]>`
    select distinct (au.metadata ->> 'pageNumber')::int as page from usage_attribution au
    where au.run_id = ${runId} and au.metric = any(${[...PAGE_READ_METRICS]}::text[]) and au.cost_cents > 0
      and au.metadata ->> 'documentId' = ${documentId}
      and au.metadata ->> 'pageNumber' = any(${needCommitted.map(String)}::text[])
  `).map((r) => Number(r.page)));
  const chargeFailedRead = undecidedFailedReads.filter((page) => pendingRichPages.has(page) || committedRichPages.has(page))
    .sort((a, b) => a - b);
  if (chargeFailedRead.length > 0) {
    await client`
      update document_page_states s
      set read_billed_run = ${runId}, read_text = r.text
      from unnest(${chargeFailedRead}::int[], ${chargeFailedRead.map((page) => failedReads.get(page) ?? null)}::text[]) as r(page, text)
      where s.document_id = ${documentId} and s.page_number = r.page and s.read_billed_run is null
    `;
  }
  const chargeableSet = new Set([...owned, ...chargeFailedRead, ...[...readBilledBy].filter(([, run]) => run === runId).map(([page]) => page)]
    .filter((page) => !billedElsewhere.has(page)));
  const chargeable = richEvents.filter((event) => chargeableSet.has(Number(event.metadata?.pageNumber)));
  const dropped = richEvents.filter((event) => !chargeableSet.has(Number(event.metadata?.pageNumber)));
  if (dropped.length > 0) {
    console.warn(`[page-fee] run=${runId} document=${documentId} dropped Rich charges for pages it does not own: ${dropped.map((event) => event.metadata?.pageNumber).join(",")}`);
  }
  const richInserted = await persistRunUsageEvents({ client, state, usageEvents: chargeable });
  const readRows = await client<{ page: number }[]>`
    select distinct (au.metadata ->> 'pageNumber')::int as page from usage_attribution au
    where au.run_id = ${runId} and au.metric = any(${[...PAGE_READ_METRICS]}::text[])
      and au.metadata ->> 'documentId' = ${documentId}
      and (au.metadata ->> 'pageNumber') ~ '^[0-9]{1,9}$'
  `;
  const rich = new Set(readRows.map((r) => Number(r.page)));
  // A page an earlier failed read already charged gets this run's stamp and nothing else.
  const undecided = owned.filter((page) => !rich.has(page) && !readBilledBy.has(page)).sort((x, y) => x - y);
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
      metadata: unitChargeMetadata({ projectId: row.project_id, documentId, pageNumber: page, readBy: "model-read", readRun: read.model_read_run, materialized: true }),
    };
  });
  const fastPages = undecided.filter((page) => !readElsewhereByPage.has(page));
  const decidedInserted = await persistRunUsageEvents({ client, state, usageEvents: [
    ...richDecisions,
    ...fastPages.map(page => ({
      id: `${runId}:${documentId}:${page}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.fastPage,
      amount: 1, unit: "page", costCents: rateCents,
      metadata: unitChargeMetadata({ projectId: row.project_id, documentId, page, materialized: true, pageRules: PAGE_BILLING_RULES_VERSION }),
    })),
  ] });
  // This run read pages another run decided Fast or OCR: upgrade those decisions to Rich (the difference only, once).
  const upgradeCandidates = [...modelReads.keys()].filter((page) => !ownedSet.has(page));
  const upgrades = upgradeCandidates.length === 0 ? [] : await client<{ page_number: number; fee_billed_run: string; fast_id: string; decided_metric: string }[]>`
    select s.page_number, s.fee_billed_run, fast.id as fast_id, fast.metric as decided_metric
    from document_page_states s
    join lateral (
      select au.id, au.metric from usage_attribution au
      where au.run_id = s.fee_billed_run and au.metric in (${BILLABLE_UNIT_METRICS.fastPage}, ${BILLABLE_UNIT_METRICS.ocrPage})
        and au.metadata ->> 'documentId' = s.document_id
        and coalesce(au.metadata ->> 'pageNumber', au.metadata ->> 'page') = s.page_number::text
      -- An OCR decision is the dearer of the two: the upgrade owes the difference from it.
      order by (au.metric = ${BILLABLE_UNIT_METRICS.ocrPage}) desc, au.id
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
    const from = upgrade.decided_metric === BILLABLE_UNIT_METRICS.ocrPage ? "ocr" as const : "fast" as const;
    return {
      id: `rich-upgrade:${documentId}:${upgrade.page_number}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card",
      metric: BILLABLE_UNIT_METRICS.richPage, amount: pagesRead, unit: "page",
      costCents: Math.max(0, pageCredits("rich", pagesRead) - pageCredits(from, 1)),
      metadata: unitChargeMetadata({ projectId: row.project_id, documentId, pageNumber: upgrade.page_number, readBy: "model-read",
        upgradeOf: upgrade.fast_id, upgradeFrom: from, decidedBy: upgrade.fee_billed_run, materialized: true }),
    };
  }) });
  const inserted = richInserted + decidedInserted + upgradeInserted;
  // The usage_events trigger adds `inserted` to the run's spent_cents (0056_run_spent_cents).
  if (inserted > 0) await debitRunUsageCredits({ client, state, costCents: inserted });
  // Customer credit reporting comes from committed decisions only: each page this decision stamped (or whose failed
  // read it charged) reports this run's committed Fast or Rich charge for it. A page an earlier read already paid for
  // (read_billed_run before this decision) reports 0, and provider usage (embeddings, dropped reads) is never included.
  const reported = [...new Set([...owned, ...chargeFailedRead])].filter((page) => !readBilledBy.has(page));
  const charges = new Map(reported.length === 0 ? [] : (await client<{ page: number; credits: number | string }[]>`
    select (coalesce(au.metadata ->> 'pageNumber', au.metadata ->> 'page'))::int as page, sum(au.cost_cents) as credits
    from usage_attribution au
    where au.run_id = ${runId} and au.metric = any(${[...PAGE_CHARGE_METRICS]}::text[])
      and au.metadata ->> 'documentId' = ${documentId} and au.id not like 'rich-upgrade:%'
      and coalesce(au.metadata ->> 'pageNumber', au.metadata ->> 'page') = any(${reported.map(String)}::text[])
    group by 1
  `).map((r) => [Number(r.page), Number(r.credits) || 0] as const));
  if (owned.length > 0) {
    await client`
      update document_page_states s set cost_credits = r.credits
      from unnest(${owned}::int[], ${owned.map((page) => charges.get(page) ?? 0)}::numeric[]) as r(page, credits)
      where s.document_id = ${documentId} and s.page_number = r.page
    `;
  }
  const credits = [...charges.values()].reduce((sum, value) => sum + value, 0) + upgradeInserted;
  return { inserted, credits, richBatch };
}

/** Runs whose stamps can no longer be backed by a charge: finished, or a worker whose lease expired. */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"];

/**
 * SQL condition on a `document_page_states s` row: a stale stamp. Its stamping run recorded no Fast, OCR or
 * Rich charge for the page, and that run can no longer commit one: it is gone, terminal (completed, failed,
 * cancelled) or its worker's lease expired. Stamps and charges commit together (recordMaterializedPageFee), so
 * such a stamp is a failed fee write, a cancelled run, or a stamp from before that rule; recovery may take the
 * page over (billUnbilled, recordMaterializedPageFee) and a full index charges it (recordPageBaseFee). A live
 * stamping run keeps its page, so a page it read is never charged Fast by another run as well. A page with
 * `read_billed_run` is never stale: its one charge is that earlier read's, committed with the `read_billed_run` stamp.
 */
export function staleStampSql(client: Sql<Record<string, unknown>>) {
  return client`(s.fee_billed_run is not null and s.read_billed_run is null and not exists (
    select 1 from usage_attribution au
    where au.run_id = s.fee_billed_run
      and au.metric = any(${[...PAGE_CHARGE_METRICS]}::text[])
      and au.metadata ->> 'documentId' = s.document_id
      and coalesce(au.metadata ->> 'pageNumber', au.metadata ->> 'page') = s.page_number::text
  ) and not exists (
    select 1 from project_runs owner
    where owner.id = s.fee_billed_run
      and owner.status <> all(${client.array(TERMINAL_RUN_STATUSES)}::text[])
      and (owner.lease_expires_at is null or owner.lease_expires_at > now())
  ))`;
}
