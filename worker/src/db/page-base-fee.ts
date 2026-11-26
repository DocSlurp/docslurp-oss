import type { PendingQuery, Sql } from "postgres";
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
import { OCR_PAGE_CLASS_SLOT } from "../pipeline/ocr-page-class.js";
import { debitRunUsageCredits, persistRunUsageEvents, runUsageEventStatements, runUsageScope, type RunUsageState } from "./usage-event-store.js";

/**
 * Ingest page charges (priced by the pricing provider). One rule, per page: a page bills OCR when the OCR route read it and
 * Rich when a vision model read it (an OCR page a vision model then reads is upgraded to Rich, once), and the usage ledger
 * records that read per page (pipeline/usage-ledger.ts, charged as the page is read). Every other page of a document bills
 * Fast. Nothing about a page's content (a scan, an image, a missing text layer) bills Rich by itself: those facts are best
 * effort and an unknown fact must never raise a charge. Audio and video bill by the minute (media stage).
 *
 * When Fast is charged depends on the run's pin (pinRunFastPerDocument, at the run's first start):
 * - per document (pin "1"): each document's Fast pages are charged when it becomes completed, in the transaction that
 *   completes it (chargeDocumentsFastStatement), so a document's content is paid for the moment search can serve it,
 *   however the run ends (paused, cancelled, failed, deleted or never finished);
 * - run-wide (no pin or "0": runs started before that rule): one charge when the run completes (recordPageBaseFee), as before.
 *
 * A run without the per-read pin (started by a release before it) bills by the same per-read rule. The earlier release's
 * completion rule billed image files and pages without text bytes Rich from page facts alone; it is retired (DocSlurp/app
 * issue 601): a missing pin or fact never raises a page's class, and a page nothing read bills Fast, never nothing.
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
 * Version of the page billing rules this code settles by: 2 is the OCR page class (Fast, OCR, Rich), 3 the per-document Fast
 * charge. Every Fast charge carries it (`metadata.pageRules`). The database refuses a Fast charge below 2 for a run that has
 * OCR charges (migration 0185) and below 3 for a run that has per-document Fast charges (migration
 * 20261126T0327_fast_per_document), so a worker of an earlier release can never bill such a run's pages Fast a second time:
 * its activity fails and is retried by a current worker.
 */
export const PAGE_BILLING_RULES_VERSION = 3;

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
 * What a run's page charges came to, reported in its stats (`pageCharges`): `fastPages` and `credits` charged by this call,
 * `ocrPages` and `richPages` charged as they were read (counted, not charged here; an OCR page upgraded to Rich counts as
 * Rich), the share of the fee the run pays, and `unmeasuredDocuments`, billed documents whose page count is still an intake
 * estimate (they bill nothing; never guessed). `fastDocuments`: documents charged by this call (per-document runs).
 */
export type RunPageCharges = {
  fastPages: number; ocrPages: number; richPages: number; multiplier: number; credits: number;
  unmeasuredDocuments: number; fastDocuments?: number;
};

/**
 * The documents of a run that bill pages of their own. The one copy predicate: a content-deduplicated copy
 * (`deduped_from_document_id`) pays nothing of its own here; how copies bill is decided in this function only.
 */
export function ownDocumentSql(client: Sql<Record<string, unknown>>) {
  return client`d.deduped_from_document_id is null`;
}

/**
 * The run-wide completion charge, for runs started before the per-document rule (no `run:page-billing-fast-document` pin, or
 * pinned "0"): charge the run's remaining pages once it completes, with one fixed id per run (`fast:<run>`, the id every
 * release has written, so a retried or second completion charges nothing twice), excluding content-deduplicated, failed and
 * media documents and pages an OCR or vision read already charged (OCR or Rich). Called from completeRun only; a run that fails
 * or is cancelled is not charged here. Runs pinned to the per-document rule never reach it (chargeDocumentsFastStatement).
 */
export async function recordPageBaseFee(sql: Sql<Record<string, unknown>>, state: WorkflowState, transaction?: { afterCommit: Array<() => void> }): Promise<RunPageCharges> {
  const multiplier = pageBaseFeeMultiplier(compilePipelinePlan(state.run.pipeline));
  let charges: RunPageCharges = { fastPages: 0, ocrPages: 0, richPages: 0, multiplier, credits: 0, unmeasuredDocuments: 0 };
  if (runHasNoPageBillingPin(state)) {
    console.warn(`[page-charges] run=${state.run.id} has no page billing pin: billing its recorded reads and Fast for every other page`);
  }
  const runId = state.run.id;
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
          greatest(0, coalesce(d.billing_pages, d.page_count) - ${stampedPagesSql(client, state)})::int as pages
        from documents d
        where d.run_id = ${runId} and ${ownDocumentSql(client)} and d.status <> 'failed'
          and coalesce(d.mime_type, '') not like 'audio/%' and coalesce(d.mime_type, '') not like 'video/%'
          and (${!deferredProfilesEnabled()} or d.indexing_mode = 'full')
      ), reads as (
        -- The run's page-read charges, read once (one pass over the run's usage, not one per document): each distinct page of
        -- a document a read charged (OCR or Rich), and whether a Rich read charged it (an OCR page upgraded to Rich counts).
        select au.metadata ->> 'documentId' as document_id,
          case when (au.metadata ->> 'pageNumber') ~ '^[0-9]{1,9}$' then (au.metadata ->> 'pageNumber')::int end as page,
          bool_or(au.metric = ${BILLABLE_UNIT_METRICS.richPage}) as rich
        from usage_attribution au
        where au.run_id = ${runId} and au.metric = any(${[...PAGE_READ_METRICS]}::text[])
        group by 1, 2
      ), counted as (
        -- By page number, inside the document's pages.
        select r.document_id, count(*)::int as rich_read, count(*) filter (where r.rich)::int as rich_only
        from reads r join docs on docs.id = r.document_id
        where docs.measured and r.page between 1 and docs.page_count
        group by r.document_id
      )
      select docs.id as document_id, docs.pages, docs.measured,
        coalesce(counted.rich_read, 0)::int as rich_read, coalesce(counted.rich_only, 0)::int as rich_only
      from docs left join counted on counted.document_id = docs.id
    `,
    ], async (client, [lockedRows, rows]) => {
      const locked = lockedRows[0];
      let fastPages = 0;
      const unmeasured: string[] = [];
      // Report shape kept for readers of `documents` (`rich` is always 0 here: Rich pages are charged as they are read).
      const documents: Record<string, { fast: number; rich: number }> = {};
      for (const row of rows) {
        if (!row.measured) {
          unmeasured.push(row.document_id);
          continue;
        }
        const fast = remainingFastPages({ pages: Number(row.pages), richRead: Number(row.rich_read) });
        fastPages += fast;
        if (fast > 0) documents[row.document_id] = { fast, rich: 0 };
      }
      logUnmeasured(runId, unmeasured);
      // OCR and Rich pages are charged as they are read (the ledger); here they are only counted, for the report: the distinct
      // pages of the completed documents a read charged this run, inside each document's pages. A page OCR read and a vision
      // model then upgraded counts as Rich.
      const measuredRows = rows.filter((row) => row.measured);
      const readPages = measuredRows.reduce((sum, row) => sum + Math.min(Number(row.rich_read) || 0, Number(row.pages) || 0), 0);
      const richPages = measuredRows.reduce((sum, row) => sum + Math.min(Number(row.rich_only) || 0, Number(row.rich_read) || 0, Number(row.pages) || 0), 0);
      const ocrPages = Math.max(0, readPages - richPages);
      const fastCredits = pageCredits("fast", fastPages) * multiplier;
      charges = { fastPages, ocrPages, richPages, multiplier: multiplier * speedBoostMultiplier(state.usageLedger.speedBoost),
        credits: fastCredits * speedBoostMultiplier(state.usageLedger.speedBoost), unmeasuredDocuments: unmeasured.length };
      const base = { projectId: state.run.projectId, multiplier, documents: Object.keys(documents).length <= 200 ? documents : undefined };
      // The insert and its pending debit (for exactly the rows it inserted) are one statement.
      const usage = runUsageEventStatements({ client, state, usageEvents: [
        // A fixed id per run also records a zero-page decision, so a retry cannot change it.
        {
          id: `fast:${runId}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.fastPage,
          amount: fastPages, unit: "page", costCents: fastCredits, metadata: unitChargeMetadata({ ...base, pages: fastPages, pageRules: PAGE_BILLING_RULES_VERSION }),
        },
      ] });
      const inserted = usage.cost(await Promise.all(usage.statements.map((statement) => statement.execute())));
      // The usage_events trigger added `inserted` to spent_cents (0056).
      // Pending debit, applied to the org's balance by the flusher.
      // No credit-lease consumption: the charge is recorded in completeRun after
      // the run turned completed, which already released its lease (0052).
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
 * Pages of a full-index run's document that already paid through query materialization (stamped on the source version's page
 * ledger) and that this run did not read again. 0 for every other run kind.
 */
function stampedPagesSql(client: Sql<Record<string, unknown>>, state: WorkflowState) {
  if (state.run.kind !== "full-index") return client`0`;
  return client`(
    select count(*) from document_page_states s where s.document_id = d.previous_version_id
      -- A stale stamp (its run charged nothing and can no longer commit) paid nothing, so this run charges it.
      -- A page whose read was charged and then failed (read_billed_run) paid its one charge.
      and ((s.fee_billed_run is not null and not ${staleStampSql(client)}) or s.read_billed_run is not null)
      and not exists (select 1 from usage_attribution au
        where au.run_id = ${state.run.id} and au.metric = any(${[...PAGE_READ_METRICS]}::text[])
          and au.metadata ->> 'documentId' = d.id and au.metadata ->> 'pageNumber' = s.page_number::text)
  )`;
}

function logUnmeasured(runId: string, unmeasured: readonly string[], total = unmeasured.length) {
  if (total === 0) return;
  // Visible, never guessed: a billed document whose page count is still an intake estimate bills no Fast page.
  console.error(`[page-charges] run=${runId} unmeasured-documents=${total} billed-pages=0 documents=${unmeasured.slice(0, 20).join(",")}${total > 20 ? ",..." : ""}`);
}

/**
 * The per-document Fast rule (DocSlurp/app issue 601): a document's Fast pages are charged once, when that document becomes
 * completed (searchable), as its own event `fast:<run>:<document>`, in the transaction that completes it. A page read is
 * charged when it is read, as before. Nothing else: no run-wide charge, no delta against earlier charges.
 *
 * Which runs: those pinned at their first start (`pinRunFastPerDocument`), and only when every live worker advertised
 * `billing.fast-per-document`, so no worker of an earlier release (which writes the run-wide `fast:<run>` at completion)
 * can complete such a run. A run started under the run-wide rule keeps it until it ends, so no run is billed under both.
 */
export const FAST_PER_DOCUMENT_SLOT = "run:page-billing-fast-document";

/** DOCSLURP_FAST_PER_DOCUMENT: `off` (or `0`, `false`) keeps new runs on the run-wide completion charge. Default on. */
export function fastPerDocumentConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DOCSLURP_FAST_PER_DOCUMENT?.trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false");
}

/**
 * Pin the run's Fast rule unless it has one. Called by startRun before any other billing pin is written. "1" (per document)
 * only on the run's first start: no page billing pin yet, no OCR class decision, no completion report (`pageCharges`) and no
 * document it completed itself (a copy's seeded checkpoints do not count), so a run an earlier release started, billed or
 * completed (and that is now retried) keeps the run-wide rule and is never billed under both. Then only when the operator has
 * it on and every live worker advertises the capability; a fleet check that fails reads as no.
 */
export async function pinRunFastPerDocument(
  state: { artifactLedger: RunArtifactsState["artifactLedger"]; run: { stats?: Record<string, unknown> | null } },
  fleetSupports: () => Promise<boolean>,
  options: { completedDocuments: boolean; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  const env = options.env ?? process.env;
  const stored = state.artifactLedger.read(FAST_PER_DOCUMENT_SLOT);
  if (stored === "1" || stored === "0") return stored === "1";
  let reason: "on" | "started-earlier" | "operator-off" | "fleet-not-ready" | "fleet-check-failed" = "on";
  if (state.artifactLedger.read(PAGE_BILLING_RULES_SLOT) || state.artifactLedger.read(OCR_PAGE_CLASS_SLOT) || state.run.stats?.pageCharges
    || options.completedDocuments) reason = "started-earlier";
  else if (!fastPerDocumentConfigured(env)) reason = "operator-off";
  else {
    const supported = await fleetSupports().then((value) => value, () => null);
    if (supported === null) reason = "fleet-check-failed";
    else if (!supported) reason = "fleet-not-ready";
  }
  const on = reason === "on";
  state.artifactLedger.record(FAST_PER_DOCUMENT_SLOT, on ? "1" : "0");
  if (!on) console.warn(`[page-charges] run pinned to the run-wide Fast charge reason=${reason}`);
  return on;
}

/** Whether the run bills Fast per document (its pin is "1"). Anything else, including no pin, is the run-wide rule. */
export function runChargesFastPerDocument(ledger: { read(key: string): string | undefined | null }): boolean {
  return ledger.read(FAST_PER_DOCUMENT_SLOT) === "1";
}

/** The one Fast charge of a document in a run. */
export function documentFastChargeId(runId: string, documentId: string): string {
  return `fast:${runId}:${documentId}`;
}

/** Safety bound on the pages one document's read lookup probes (a measured count above it is not a real document). */
const MAX_PROBED_PAGES = 1_000_000;

/** What one per-document Fast statement charged. */
export type DocumentFastChargeRow = { documents: number; pages: string; cents: string; unmeasured: number; unmeasured_ids: string[] | null; debits: number };

/**
 * One statement that charges the Fast pages of completed documents of the run, per document (`fast:<run>:<document>`), and the
 * pending debit for exactly the rows it inserted. It rides the caller's transaction (the one that completes the documents) with
 * no round trip of its own when pipelined.
 *
 * - `scope`: one document just completed (its buffered read charges are persisted earlier in the same transaction, so only
 *   persisted reads count), or `"run"`, every completed document of the run that has no Fast charge yet.
 * - Pages: the document's measured pages (billing_pages, else a counted page_count; an intake estimate bills nothing and is
 *   reported), less a full-index run's pages already paid through materialization, less the distinct pages 1..page_count an
 *   OCR or Rich read of this run charged (looked up by the reads' primary keys, `ocr:`/`rich:<run>:<document>:<page>`).
 * - Exactly once: the id is deterministic and the insert is `on conflict do nothing`; a document completed again (a retry, a
 *   stale worker, a re-index in the same run) inserts nothing.
 * - Scope: the run's own organization on every row read and written; documents of the run only, never copies (ownDocumentSql),
 *   media or deferred documents, and only `completed` ones (failed, cancelled, PII-blocked documents never served bill nothing).
 * - `accrue`: mid-run, the inserted credits also count toward the run's next spend check and consume its credit lease, as a
 *   checkpoint's charges do, so an unfunded run pauses at its next checkpoint. The charge itself never refuses: completing the
 *   document records the debt.
 * Returns null (and logs) for a run without an organization: nothing can be charged to it.
 */
export function chargeDocumentsFastStatement(
  client: Sql<Record<string, unknown>>,
  state: WorkflowState,
  scope: { documentId: string } | "run",
  options: { accrue: boolean },
): PendingQuery<DocumentFastChargeRow[]> | null {
  const runId = state.run.id;
  const orgId = state.run.orgId ?? null;
  if (!orgId) {
    console.error(`[page-charges] run=${runId} has no organization: Fast pages not charged`);
    return null;
  }
  const scopeUsage = runUsageScope(state);
  const share = pageBaseFeeMultiplier(compilePipelinePlan(state.run.pipeline));
  const boost = speedBoostMultiplier(state.usageLedger.speedBoost);
  // Fast is priced per page (as OCR and Rich reads are), so a document's charge is its pages times one page's price.
  const baseRate = pageCredits("fast", 1) * share;
  const base = unitChargeMetadata({
    projectId: state.run.projectId, multiplier: share, pageRules: PAGE_BILLING_RULES_VERSION, perDocument: true, runId,
    ...(boost !== 1 ? { speedBoost: state.usageLedger.speedBoost === true } : {}),
  });
  const only = scope === "run"
    ? client`and not exists (select 1 from usage_attribution au where au.id = 'fast:' || ${runId}::text || ':' || d.id and au.stamped_org_id = ${orgId})`
    : client`and d.id = ${scope.documentId}`;
  const accrue = options.accrue
    ? client`,
      counted as (
        update project_runs set spend_unchecked_credits = project_runs.spend_unchecked_credits + total.cents
        from total where project_runs.id = ${runId} and total.cents > 0 returning 1
      ),
      leased as (
        update credit_leases set consumed = consumed + total.cents, updated_at = now()
        from total where holder_kind = 'run' and holder_id = ${runId} and org_id = ${orgId} and total.cents > 0 returning 1
      )`
    : client``;
  const accrued = options.accrue ? client`(select count(*) from counted) + (select count(*) from leased)` : client`0`;
  return client<DocumentFastChargeRow[]>`
    with docs as materialized (
      select d.id, d.page_count, (d.billing_pages is not null or d.page_count_source = 'counted') as measured,
        greatest(0, coalesce(d.billing_pages, d.page_count) - ${stampedPagesSql(client, state)})::bigint as pages
      from documents d
      where d.run_id = ${runId} and d.org_id = ${orgId} and d.status = 'completed' and ${ownDocumentSql(client)}
        and coalesce(d.mime_type, '') not like 'audio/%' and coalesce(d.mime_type, '') not like 'video/%'
        and (${!deferredProfilesEnabled()} or d.indexing_mode = 'full')
        ${only}
        -- A run an older worker already charged run-wide (fast:<run>) is never charged per document as well.
        and not exists (select 1 from usage_attribution au0 where au0.id = 'fast:' || ${runId}::text and au0.stamped_org_id = ${orgId})
    ), charges as (
      select docs.id, greatest(0, docs.pages - least(docs.pages, coalesce(r.read, 0)))::bigint as fast
      from docs
      left join lateral (
        select count(*)::bigint as read
        from generate_series(1, least(greatest(coalesce(docs.page_count, 0), 0), ${MAX_PROBED_PAGES})) as p(n)
        where exists (
          select 1 from usage_attribution au
          where au.run_id = ${runId} and au.stamped_org_id = ${orgId} and au.metric = any(${[...PAGE_READ_METRICS]}::text[])
            and au.id in ('ocr:' || ${runId}::text || ':' || docs.id || ':' || p.n, 'rich:' || ${runId}::text || ':' || docs.id || ':' || p.n))
      ) r on true
      where docs.measured
    ), inserted as (
      insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, input_tokens, output_tokens, metadata, org_id, project_id, api_key_id)
      select 'fast:' || ${runId}::text || ':' || c.id, ${state.run.userId}, ${runId}, ${UNIT_CHARGE_PROVIDER}, 'price-card',
        ${BILLABLE_UNIT_METRICS.fastPage}, c.fast, 'page', c.fast * ${baseRate * boost}::numeric, 0, 0,
        ${client.json(JSON.parse(JSON.stringify(base)))}::jsonb || jsonb_build_object('documentId', c.id, 'pages', c.fast)
          || case when ${boost !== 1} then jsonb_build_object('speedBoostCharge',
            jsonb_build_object('version', 1, 'baseCredits', c.fast * ${baseRate}::numeric, 'multiplier', ${boost}::numeric)) else '{}'::jsonb end,
        ${orgId}, ${scopeUsage.projectId}, ${scopeUsage.apiKeyId}
      from charges c where c.fast > 0
      order by c.id
      on conflict (id) do nothing
      returning id, amount, cost_cents
    ), total as (
      select coalesce(sum(cost_cents), 0) as cents, coalesce(sum(amount), 0) as pages, count(*) as documents from inserted
    ), debit as (
      select enqueue_org_credit_debit(${orgId}, total.cents, ${state.run.userId}, 'usage', ${runId}, ${scopeUsage.projectId}, '{}'::jsonb)
      from total where total.cents > 0
    )${accrue}
    select total.documents::int as documents, total.pages::text as pages, total.cents::text as cents,
      (select count(*) from docs where not docs.measured)::int as unmeasured,
      (select array_agg(u.id) from (select id from docs where not docs.measured order by id limit 20) u) as unmeasured_ids,
      ((select count(*) from debit) + ${accrued})::int as debits
    from total
  `;
}

/** The statement's row, logged and reported. */
export function noteDocumentsFastCharge(state: Pick<WorkflowState, "run" | "usageLedger">, rows: readonly DocumentFastChargeRow[] | undefined): RunPageCharges & { fastDocuments: number } {
  const row = rows?.[0];
  const multiplier = pageBaseFeeMultiplier(compilePipelinePlan(state.run.pipeline)) * speedBoostMultiplier(state.usageLedger.speedBoost);
  const result = { fastDocuments: Number(row?.documents ?? 0) || 0, fastPages: Number(row?.pages ?? 0) || 0, ocrPages: 0, richPages: 0, multiplier,
    credits: Number(row?.cents ?? 0) || 0, unmeasuredDocuments: Number(row?.unmeasured ?? 0) || 0 };
  logUnmeasured(state.run.id, row?.unmeasured_ids ?? [], result.unmeasuredDocuments);
  return result;
}

/**
 * Charge every completed document of a per-document run that has no Fast charge yet, in its own transaction (retried on a
 * deadlock). Used at the end of the index stage, after its checkpoint persisted the stage's reads: documents the first pass
 * indexed before the ordinary loop could read them are charged here when the loop did not index them again.
 */
export async function chargeCompletedDocumentsFast(sql: Sql<Record<string, unknown>>, state: WorkflowState): Promise<void> {
  if (!runChargesFastPerDocument(state.artifactLedger)) return;
  // One statement: atomic on its own, retried on a deadlock or serialization failure.
  const rows = await retryTransaction(`fast-documents run=${state.run.id}`, async () => {
    const statement = chargeDocumentsFastStatement(sql, state, "run", { accrue: true });
    return statement ? await statement : [];
  });
  noteDocumentsFastCharge(state, rows);
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
