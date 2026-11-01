import type { Sql } from "postgres";
import { applyDefaultVisionOverride, normalizeStoredPipelineFeatures, type MaterializePagesInput } from "@docslurp/shared";

import { isMissingDocumentError } from "../db/missing-document.js";
import { recordMaterializedPageFee, staleStampSql } from "../db/page-base-fee.js";
import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";
import type { Store } from "../db/store.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { coerceIndexingModeForFlag } from "../pipeline/stage-execution.js";
import type { MaterializeResult } from "../temporal/materialize-ranges.js";
import { claimPages, ensurePageRows } from "./page-ledger.js";
import { materializePageRange, type PageMaterializerDeps } from "./materialize-pages.js";

/** Claim lifetime; longer than the activity's 5 minute startToClose so a live attempt never loses its pages. */
export const MATERIALIZE_CLAIM_TTL_SECONDS = 6 * 60;
/** Failure reason for pages whose document was deleted mid-run; not an error worth failing the run for. */
export const DOCUMENT_DELETED_REASON = "document-deleted";
/** Lease a heartbeat grants a materialize run: longer than the activity's 5 minute startToClose. */
export const MATERIALIZE_LEASE_SECONDS = 10 * 60;
const AWAIT_POLL_MS = [250, 500, 1000, 2000, 3000];

export interface MaterializeActivityDeps {
  store: Store;
  sql: Sql<Record<string, unknown>>;
  materializer: Omit<PageMaterializerDeps, "sql" | "store" | "usage">;
  /** Max time spent waiting on pages another run holds. */
  awaitTimeoutMs?: number;
  heartbeat?: () => void;
  /** Heartbeat cadence while a range materializes (must stay under the activity heartbeatTimeout). */
  heartbeatIntervalMs?: number;
  /** The activity's startToCloseTimeout; the wait budget never outlives it. */
  startToCloseMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A materialize run must apply the pipeline the document was ingested with (PII policy, privacy mode,
 * embedding model). The app copies it into the run row; if that row carries none (an empty pipeline would
 * silently become the defaults and write vectors to the wrong table or leak OCR to hosted providers),
 * load the source document's ingest run pipeline, then the workspace's, and refuse to run on defaults.
 */
async function withSourcePipeline<R extends { id: string; kind?: string; pipeline: unknown; workspaceId?: string | null }>(
  sql: Sql<Record<string, unknown>>,
  run: R,
  documentId: string,
): Promise<R> {
  if (run.kind !== "materialize") return run;
  const [own] = await sql<{ empty: boolean }[]>`
    select (pipeline = '{}'::jsonb) as empty from workspace_runs where id = ${run.id}
  `;
  if (own && !own.empty) return run;
  const [source] = await sql<{ pipeline: Record<string, unknown> | null }[]>`
    select coalesce(nullif(r.pipeline, '{}'::jsonb), nullif(w.pipeline, '{}'::jsonb)) as pipeline
    from documents d
    left join workspace_runs r on r.id = d.run_id
    left join workspaces w on w.id = d.workspace_id
    where d.id = ${documentId}
  `;
  if (!source?.pipeline) {
    throw new Error(`materialize run ${run.id} has no pipeline and document ${documentId} has no source pipeline; refusing to run on defaults`);
  }
  return { ...run, pipeline: applyDefaultVisionOverride(normalizeStoredPipelineFeatures(source.pipeline as never, `document ${documentId} source pipeline`)) };
}

/**
 * One contiguous range: claim, materialize what this run owns, wait for pages
 * other runs are materializing, bill the pages this run indexed.
 */
export async function runMaterializeRange(deps: MaterializeActivityDeps, input: MaterializePagesInput): Promise<MaterializeResult> {
  const result: MaterializeResult = { indexed: [], blocked: [], failed: [], costCredits: 0 };
  try {
    return await materializeRange(deps, input, result);
  } catch (error) {
    // The document was deleted while (or before) its pages were materialized: stop cleanly. Retrying would
    // only repeat the foreign-key error; pages already written were billed as they finished, the rest are not.
    if (!isMissingDocumentError(error)) throw error;
    console.warn(`[materialize] document ${input.documentId} was deleted; stopping run=${input.runId}`);
    const settled = new Set([...result.indexed, ...result.blocked, ...result.failed.map((f) => f.page)]);
    for (const page of input.pages) if (!settled.has(page)) result.failed.push({ page, reason: DOCUMENT_DELETED_REASON });
    result.indexed.sort((a, b) => a - b);
    result.failed.sort((a, b) => a.page - b.page);
    return result;
  }
}

async function materializeRange(deps: MaterializeActivityDeps, input: MaterializePagesInput, result: MaterializeResult): Promise<MaterializeResult> {
  const { store, sql } = deps;
  const startedAt = Date.now();
  // The run row carries a lease so alerts flag it only when this worker stops heartbeating.
  const pendingRenewals = new Set<Promise<unknown>>();
  const renewLease = (): Promise<unknown> => {
    // Ranges of one run renew concurrently: greatest() keeps one from shortening another's (or the app's) lease.
    const renewal: Promise<unknown> = sql`
      update workspace_runs
      set last_heartbeat_at = now(),
          lease_expires_at = greatest(coalesce(lease_expires_at, now()), now() + (${MATERIALIZE_LEASE_SECONDS} * interval '1 second'))
      where id = ${input.runId} and status = 'processing'
    `
      .catch((error) => { console.warn(`[materialize] lease renewal failed run=${input.runId}: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => pendingRenewals.delete(renewal));
    pendingRenewals.add(renewal);
    return renewal;
  };
  const heartbeat = deps.heartbeat ? () => { deps.heartbeat!(); void renewLease(); } : undefined;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const loaded = await store.loadRun(input.runId);
  const document = await store.loadDocument(input.documentId);
  const run = coerceIndexingModeForFlag(await withSourcePipeline(sql, loaded, document.id));
  const state = WorkflowState.create(run, [document]);
  // Full-index runs label their pages 'full-index'; query/backfill keep the requested reason.
  const reason = run.kind === "full-index" ? "full-index" : input.reason;

  await ensurePageRows(sql, input.documentId, document.pageCount);
  await renewLease();

  /** Materializes pages this run owns, heartbeating while it works, and bills what it indexed. */
  const materializeClaimed = async (pages: number[]): Promise<void> => {
    if (pages.length === 0) return;
    const beat = heartbeat ? setInterval(heartbeat, deps.heartbeatIntervalMs ?? 20_000) : null;
    heartbeat?.();
    try {
      // Provider calls carry the run's org for fair share and its China-provider policy (org AND workspace).
      const own = await runWithProviderRateScope({ orgId: state.run.orgId, allowChinaProviders: state.run.allowChinaProviders, speedBoost: state.run.pipeline.speedBoost }, () => materializePageRange(
        { ...deps.materializer, sql, store, usage: state.usageLedger },
        { ...input, reason, pages, document, pipeline: run.pipeline, run: state.run },
      ));
      result.indexed.push(...own.indexed);
      result.blocked.push(...own.blocked);
      result.failed.push(...own.failed);
      result.costCredits += own.costCredits;
      // materializePageRange billed the pages it indexed in the same transaction (Rich reads, Fast pages and
      // stamps); full-index runs pay page charges through the normal run path.
    } finally {
      if (beat) clearInterval(beat);
      // Persists buffered AI usage even when materialization threw.
      await store.updateProgress(state);
    }
  };

  /**
   * Pages another run indexed: charge any that carry no billing decision. A query page turns indexed in the
   * same transaction that writes its charges and stamp (materialize-pages.ts), so this normally finds nothing.
   * It covers unstamped pages and stale stamps: a stamping run with no Fast or Rich charge for the page that can
   * no longer commit one (terminal, or its lease expired) loses the page to this run (staleStampSql). A retry of this
   * run finishes its own (ids are idempotent, and a page with a recorded Rich read gets no Fast charge).
   */
  const billUnbilled = async (pages: number[]): Promise<void> => {
    if (pages.length === 0) return;
    const rows = await sql<{ page_number: number }[]>`
      select s.page_number from document_page_states s
      where s.document_id = ${input.documentId} and s.page_number = any(${pages}::int[])
        and s.state = 'indexed' and s.materialized_by in ('query', 'backfill')
        and (s.fee_billed_run is null or s.fee_billed_run = ${input.runId} or ${staleStampSql(sql)})
    `;
    await recordMaterializedPageFee(sql, input.runId, input.documentId, rows.map((r) => r.page_number), { ledger: state.usageLedger });
  };

  const claim = await claimPages(sql, {
    documentId: input.documentId, pages: input.pages, runId: input.runId,
    ttlSeconds: MATERIALIZE_CLAIM_TTL_SECONDS, reason,
  });
  result.indexed.push(...claim.ready);
  await billUnbilled(claim.ready);
  await materializeClaimed(claim.claimed);

  // One deadline per attempt: never outlive the activity's startToClose.
  const budgetMs = Math.max(0, Math.min(
    deps.awaitTimeoutMs ?? 4 * 60_000,
    (deps.startToCloseMs ?? 5 * 60_000) - (Date.now() - startedAt) - 30_000,
  ));
  const deadline = Date.now() + budgetMs;
  let waiting = claim.awaiting;
  for (let attempt = 0; waiting.length > 0 && Date.now() < deadline && !deps.signal?.aborted; attempt += 1) {
    heartbeat?.();
    await sleep(AWAIT_POLL_MS[Math.min(attempt, AWAIT_POLL_MS.length - 1)]!);
    // Re-claim: pages whose holder died (expired claim) become ours; finished pages come back as ready.
    const again = await claimPages(sql, {
      documentId: input.documentId, pages: waiting, runId: input.runId,
      ttlSeconds: MATERIALIZE_CLAIM_TTL_SECONDS, reason,
    });
    result.indexed.push(...again.ready);
    await billUnbilled(again.ready);
    await materializeClaimed(again.claimed);
    const settled = new Set([...again.ready, ...again.claimed]);
    const rest = waiting.filter((p) => !settled.has(p) && !again.awaiting.includes(p));
    if (rest.length > 0) {
      // In no list: blocked-pii or failed with attempts exhausted.
      const rows = await sql<{ page_number: number; state: string; failure_reason: string | null }[]>`
        select page_number, state, failure_reason from document_page_states
        where document_id = ${input.documentId} and page_number = any(${rest}::int[])
      `;
      for (const row of rows) {
        if (row.state === "blocked-pii") result.blocked.push(row.page_number);
        else result.failed.push({ page: row.page_number, reason: row.failure_reason ?? "peer-run-failed" });
      }
    }
    waiting = again.awaiting;
  }
  for (const page of waiting) result.failed.push({ page, reason: "await-timeout" });

  result.indexed.sort((a, b) => a - b);
  result.blocked.sort((a, b) => a - b);
  result.failed.sort((a, b) => a.page - b.page);
  await Promise.all(pendingRenewals);
  return result;
}

/** Marks the materialize run row terminal; the app inserted it with kind 'materialize'. */
export async function completeMaterializeRun(
  sql: Sql<Record<string, unknown>>,
  runId: string,
  result: MaterializeResult,
): Promise<void> {
  const realFailures = result.failed.filter((f) => f.reason !== DOCUMENT_DELETED_REASON);
  const status = result.indexed.length === 0 && realFailures.length > 0 ? "failed" : "completed";
  await sql`
    update workspace_runs
    set status = ${status}, stage = ${status},
        pages_total = ${result.indexed.length + result.blocked.length + result.failed.length},
        pages_processed = ${result.indexed.length},
        processed_documents = total_documents,
        lease_expires_at = null, updated_at = now()
    where id = ${runId}
  `;
}
