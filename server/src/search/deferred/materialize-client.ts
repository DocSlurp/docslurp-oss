import { randomUUID } from "node:crypto";

import {
  classifyTemperature,
  materializeWorkflowId,
  type DeferredSearchStats,
  type MaterializationPolicy,
  type MaterializePagesInput,
} from "@docslurp/shared";

import { sql } from "../../db.js";
import { startMaterializeWorkflow } from "../../lib/temporal.js";
import { canSpend } from "../../services/billing/spend-guard.js";
import type { MaterializeEvent } from "./deferred-context.js";

export const MATERIALIZE_POLL_MS = 250;

export interface PageState {
  state: string;
  costCredits: number;
}

export interface MaterializeDeps {
  loadPageStates(pairs: Array<{ documentId: string; page: number }>): Promise<Map<string, PageState>>;
  canSpend(orgId: string, workspaceId: string): Promise<boolean>;
  createRun(args: { orgId: string; userId: string; workspaceId: string; documentId: string; documents: number; pages: number }): Promise<string>;
  /** Marks a run whose workflow start was deduplicated; the winning workflow owns the real work. */
  closeDedupedRun(runId: string): Promise<void>;
  /** Marks a run whose workflow could not be started. */
  failRun(runId: string, reason: string): Promise<void>;
  startWorkflow(input: MaterializePagesInput, workflowId: string): Promise<"started" | "already-running">;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const pageKey = (documentId: string, page: number) => `${documentId}:${page}`;

const TERMINAL_FAILED = new Set(["failed", "blocked-pii"]);

/**
 * Credits one on-demand page is expected to cost: the page base fee
 * (`DOCSLURP_PAGE_BASE_FEE_USD` x 100) plus the parse/embed estimate
 * (`DOCSLURP_EST_PAGE_MATERIALIZE_CREDITS`, default 0.5). Rate card unchanged.
 */
export function estimatedPageMaterializeCredits(env: NodeJS.ProcessEnv = process.env): number {
  const estimate = Number.parseFloat(env.DOCSLURP_EST_PAGE_MATERIALIZE_CREDITS ?? "");
  const baseFeeUsd = Number.parseFloat(env.DOCSLURP_PAGE_BASE_FEE_USD ?? "");
  return (Number.isFinite(estimate) && estimate >= 0 ? estimate : 0.5)
    + (Number.isFinite(baseFeeUsd) && baseFeeUsd > 0 ? baseFeeUsd * 100 : 0);
}

export const defaultMaterializeDeps: MaterializeDeps = {
  async loadPageStates(pairs) {
    const result = new Map<string, PageState>();
    if (pairs.length === 0) return result;
    const rows = await sql<{ document_id: string; page_number: number; state: string; cost: number | string }[]>`
      select s.document_id, s.page_number, s.state, s.cost_credits::float8 as cost
      from unnest(${sql.array(pairs.map((p) => p.documentId), 25)}, ${sql.array(pairs.map((p) => p.page), 23)}) as c(document_id, page_number)
      join document_page_states s on s.document_id = c.document_id and s.page_number = c.page_number
    `;
    for (const row of rows) result.set(pageKey(row.document_id, row.page_number), { state: row.state, costCredits: Number(row.cost) || 0 });
    return result;
  },
  canSpend: (orgId, workspaceId) => canSpend(orgId, workspaceId),
  async createRun(args) {
    const id = `mat_${randomUUID()}`;
    // The run carries the source document's pipeline (its ingest run, else the workspace's), so the
    // worker applies the same PII policy, privacy mode and embedding model as the original ingest.
    // It is inserted `processing` with a confirmed workflow start: run-start recovery and the stale
    // sweepers (which only chase `queued` rows with no confirmed start) must never run it as an upload.
    // It also gets a lease (3x the activity's 5 min startToClose, so ranges queued for worker slots do not trip stale alerts) that the worker renews on every heartbeat,
    // so the stale-lease alerts and health counts flag a materialize run only when its worker really died.
    await sql`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pages_total, pipeline, workflow_started_at, lease_expires_at, creation_ready_at, creation_expires_at)
      select ${id}, ${args.orgId}, ${args.userId}, ${args.workspaceId}, 'materialize', 'processing', 'materialize',
             ${args.documents}, ${args.pages},
             coalesce(nullif(r.pipeline, '{}'::jsonb), nullif(w.pipeline, '{}'::jsonb), '{}'::jsonb), now(),
             now() + interval '15 minutes', now(), null
      from (select 1) one
      left join documents d on d.id = ${args.documentId}
      left join workspace_runs r on r.id = d.run_id
      left join workspaces w on w.id = ${args.workspaceId}
    `;
    return id;
  },
  async closeDedupedRun(runId) {
    await sql`
      update workspace_runs set status = 'completed', stage = 'completed', stats = stats || '{"deduplicated":true}'::jsonb, updated_at = now()
      where id = ${runId} and kind = 'materialize' and status in ('queued', 'processing')
    `;
  },
  async failRun(runId, reason) {
    await sql`
      update workspace_runs set status = 'failed', stage = 'failed', error = ${reason.slice(0, 500)}, updated_at = now()
      where id = ${runId} and kind = 'materialize' and status in ('queued', 'processing')
    `;
  },
  startWorkflow: startMaterializeWorkflow,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Make the candidate pages searchable now. Order is chosen for latency:
 * one batched ledger read classifies the query hot/warm/cold; hot returns
 * immediately. Otherwise pending pages are trimmed to the policy and credit
 * caps (candidate order is priority order), the worker's `materializePages`
 * workflow is started once per document, and the ledger is polled every 250 ms
 * until every page is indexed or the policy deadline passes. A blocked or
 * exhausted budget never throws: the stats report `stoppedBy`.
 */
export async function materializeForQuery(
  args: {
    orgId: string;
    userId: string;
    workspaceId: string;
    sessionId: string;
    candidates: Array<{ documentId: string; page: number }>;
    policy: MaterializationPolicy;
    onEvent?: (event: MaterializeEvent) => void;
    recordDiagnostic?: (key: string, value: unknown) => void;
    /** Aborts polling (client disconnected); started workflows keep running. */
    signal?: AbortSignal;
    /** Start of the deferred phase, so the deadline covers locating as well as waiting. */
    startedAt?: number;
  },
  deps: MaterializeDeps = defaultMaterializeDeps,
): Promise<DeferredSearchStats> {
  const startedAt = args.startedAt ?? deps.now();
  const seen = new Set<string>();
  const deduped = args.candidates.filter((c) => {
    const key = pageKey(c.documentId, c.page);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const stats: DeferredSearchStats = {
    temperature: "hot", candidatePages: deduped.length, indexedCandidatePages: deduped.length,
    materializedPages: 0, pendingPages: 0, materializeMs: 0, creditsSpent: 0,
    routerUsed: false, fallbackUsed: false, stoppedBy: null,
  };
  if (deduped.length === 0) return stats;

  const states = await deps.loadPageStates(deduped);
  // Pages blocked by PII can never become searchable: not candidates at all.
  const candidates = deduped.filter((c) => states.get(pageKey(c.documentId, c.page))?.state !== "blocked-pii");
  stats.candidatePages = candidates.length;
  stats.indexedCandidatePages = candidates.length;
  if (candidates.length === 0) return stats;
  const stateOf = (c: { documentId: string; page: number }) => states.get(pageKey(c.documentId, c.page));
  const indexed = candidates.filter((c) => stateOf(c)?.state === "indexed").length;
  stats.indexedCandidatePages = indexed;
  stats.temperature = classifyTemperature(candidates.length, indexed);
  if (stats.temperature === "hot") return stats;

  let pending = candidates.filter((c) => stateOf(c)?.state !== "indexed");
  const finish = (): DeferredSearchStats => {
    stats.materializeMs = deps.now() - startedAt;
    return stats;
  };

  const { policy } = args;
  if (policy.maxPagesPerQuery <= 0 || policy.maxCreditsPerQuery <= 0) {
    stats.pendingPages = pending.length;
    stats.stoppedBy = "policy";
    return finish();
  }
  let trimmedBy: "policy" | "credits" | null = null;
  if (pending.length > policy.maxPagesPerQuery) {
    pending = pending.slice(0, policy.maxPagesPerQuery);
    trimmedBy = "policy";
  }
  const perPage = estimatedPageMaterializeCredits();
  if (perPage > 0 && pending.length * perPage > policy.maxCreditsPerQuery) {
    pending = pending.slice(0, Math.floor(policy.maxCreditsPerQuery / perPage));
    trimmedBy = "credits";
  }
  const notAttempted = candidates.length - indexed - pending.length;

  if (pending.length > 0 && !(await deps.canSpend(args.orgId, args.workspaceId))) {
    stats.pendingPages = pending.length + notAttempted;
    stats.stoppedBy = "credits";
    return finish();
  }
  if (pending.length === 0) {
    stats.pendingPages = notAttempted;
    stats.stoppedBy = trimmedBy ?? (notAttempted > 0 ? "policy" : null);
    return finish();
  }

  const byDocument = new Map<string, number[]>();
  for (const c of pending) byDocument.set(c.documentId, [...(byDocument.get(c.documentId) ?? []), c.page]);
  // One run row per document workflow (matches worker accounting); the credit
  // cap is split pro-rata by page count so the documents together stay under it.
  const failedDocs = new Set<string>();
  await Promise.all([...byDocument].map(async ([documentId, pages]) => {
    pages.sort((a, b) => a - b);
    let runId: string | null = null;
    try {
      runId = await deps.createRun({
        orgId: args.orgId, userId: args.userId, workspaceId: args.workspaceId, documentId, documents: 1, pages: pages.length,
      });
      const outcome = await deps.startWorkflow(
        {
          runId, documentId, pages, reason: "query", sessionId: args.sessionId,
          maxCredits: (policy.maxCreditsPerQuery * pages.length) / pending.length,
        },
        materializeWorkflowId(documentId, pages),
      );
      if (outcome === "already-running") await deps.closeDedupedRun(runId).catch(() => undefined);
      args.onEvent?.({ type: "page-materializing", documentId, pages });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[deferred-search] materialize start failed document=${documentId}: ${message}`);
      args.recordDiagnostic?.("deferredStartFailure", { documentId, message });
      if (runId) await deps.failRun(runId, message).catch(() => undefined);
      failedDocs.add(documentId);
      args.onEvent?.({ type: "materialize-failed", documentId, pages });
    }
  }));

  const waiting = new Map<string, { documentId: string; page: number }>();
  for (const c of pending) if (!failedDocs.has(c.documentId)) waiting.set(pageKey(c.documentId, c.page), c);
  const initialCost = new Map(pending.map((c) => [pageKey(c.documentId, c.page), stateOf(c)?.costCredits ?? 0]));
  const deadline = startedAt + policy.deadlineMs;
  let materialized = 0;
  let credits = 0;
  while (waiting.size > 0 && !args.signal?.aborted) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) break;
    await deps.sleep(Math.min(MATERIALIZE_POLL_MS, remaining));
    const latest = await deps.loadPageStates([...waiting.values()]);
    const ready = new Map<string, number[]>();
    const failed = new Map<string, number[]>();
    for (const [key, c] of [...waiting]) {
      const state = latest.get(key);
      if (!state) continue;
      if (state.state === "indexed") {
        waiting.delete(key);
        materialized++;
        credits += Math.max(0, state.costCredits - (initialCost.get(key) ?? 0));
        ready.set(c.documentId, [...(ready.get(c.documentId) ?? []), c.page]);
      } else if (TERMINAL_FAILED.has(state.state)) {
        waiting.delete(key);
        failed.set(c.documentId, [...(failed.get(c.documentId) ?? []), c.page]);
      }
    }
    for (const [documentId, pages] of ready) args.onEvent?.({ type: "page-ready", documentId, pages: pages.sort((a, b) => a - b) });
    for (const [documentId, pages] of failed) args.onEvent?.({ type: "materialize-failed", documentId, pages: pages.sort((a, b) => a - b) });
  }

  stats.materializedPages = materialized;
  stats.creditsSpent = Number(credits.toFixed(4));
  const startFailedPages = [...byDocument].filter(([id]) => failedDocs.has(id)).reduce((sum, [, pages]) => sum + pages.length, 0);
  stats.pendingPages = waiting.size + notAttempted + startFailedPages;
  // A failed workflow start has no enum value of its own: it reports as "policy" with a diagnostic.
  stats.stoppedBy = waiting.size > 0 ? "deadline" : trimmedBy ?? (notAttempted > 0 || startFailedPages > 0 ? "policy" : null);
  return finish();
}
