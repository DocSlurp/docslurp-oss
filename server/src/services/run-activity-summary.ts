import {
  combineRunEtas,
  estimateRunEta,
  observedPagesPerMinute,
  type ActivitySummary,
  type RunEta,
} from "@docslurp/shared";
import { emitTelemetryLog } from "@docslurp/shared/observability";

import { sql } from "../db.js";

/**
 * The organization summary on the activity feed: queued, in-progress and recently completed work, throughput and an
 * ETA bucket. Organization-scoped aggregates only (no run ids, names or projects), so one cached value serves every
 * member of that organization and nobody else: the cache key is the organization id and every query filters on it.
 * Bounded: at most ACTIVITY_SUMMARY_MAX_ACTIVE_RUNS active runs are read; past that the summary says `truncated`.
 */
export const ACTIVITY_SUMMARY_MAX_ACTIVE_RUNS = 200;
export const ACTIVITY_SUMMARY_TTL_MS = 5_000;
export const ACTIVITY_SUMMARY_RECENT_MINUTES = 15;
const CACHE_MAX_ORGS = 1_000;

type ActiveRunRow = {
  id: string;
  project_id: string;
  status: string;
  total_documents: number | string;
  processed_documents: number | string;
  pages_total: number | string;
  pages_processed: number | string;
  worker_started_at: string | Date | null;
};

type HistoryRow = { project_id: string; pages: number | string; runtime_ms: number | string };
type RecentRow = { runs: number | string; documents: number | string; pages: number | string };

const cache = new Map<string, { expiresAt: number; value: Promise<ActivitySummary> }>();

/** Tests only. */
export function clearActivitySummaryCache(): void {
  cache.clear();
  predicted.clear();
}

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * The organization a session user's activity summary describes: their personal organization, else their oldest
 * membership (the same pick as resolveDefaultOrganization, without provisioning one). Null when they have none.
 */
export async function activitySummaryOrgIdForUser(userId: string): Promise<string | null> {
  const [row] = await sql<Array<{ id: string }>>`
    select o.id from organizations o
    join org_memberships om on om.org_id = o.id and om.user_id = ${userId}
    where o.deleted_at is null
    order by (o.personal_owner_user_id = ${userId}) desc, om.created_at, o.id
    limit 1`;
  return row?.id ?? null;
}

/** Cached for ACTIVITY_SUMMARY_TTL_MS per organization; concurrent readers share one computation. */
export function getOrgActivitySummary(orgId: string, now: () => number = Date.now): Promise<ActivitySummary> {
  const at = now();
  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > at) return hit.value;
  const value = computeOrgActivitySummary(orgId, at);
  if (cache.size >= CACHE_MAX_ORGS) {
    for (const [key, entry] of cache) if (entry.expiresAt <= at) cache.delete(key);
    if (cache.size >= CACHE_MAX_ORGS) cache.delete(cache.keys().next().value!);
  }
  cache.set(orgId, { expiresAt: at + ACTIVITY_SUMMARY_TTL_MS, value });
  // A failed read is not cached: the next caller retries.
  value.catch(() => { if (cache.get(orgId)?.value === value) cache.delete(orgId); });
  return value;
}

export async function computeOrgActivitySummary(orgId: string, now = Date.now()): Promise<ActivitySummary> {
  // `org_id = $1 and status in (queued, processing)`: served by the partial index on active runs.
  const active = await sql<ActiveRunRow[]>`
    select id, project_id, status, total_documents, processed_documents, pages_total, pages_processed, worker_started_at
    from project_runs
    where org_id = ${orgId} and status in ('queued', 'processing')
    order by created_at, id
    limit ${ACTIVITY_SUMMARY_MAX_ACTIVE_RUNS + 1}`;
  const truncated = active.length > ACTIVITY_SUMMARY_MAX_ACTIVE_RUNS;
  const runs = active.slice(0, ACTIVITY_SUMMARY_MAX_ACTIVE_RUNS);
  const projectIds = [...new Set(runs.map(run => run.project_id))];
  const [historyRows, [recent]] = await Promise.all([
    projectIds.length === 0 ? Promise.resolve([] as HistoryRow[]) : sql<HistoryRow[]>`
      select cs.project_id, cs.completed_run_pages_processed as pages, cs.completed_run_runtime_ms as runtime_ms
      from project_corpus_stats cs join projects p on p.id = cs.project_id
      where cs.project_id = any(${sql.array(projectIds)}) and p.org_id = ${orgId}`,
    // Bounded by the (org_id, created_at) index: runs created in the last day that completed in the window.
    sql<RecentRow[]>`
      select count(*)::int as runs, coalesce(sum(processed_documents), 0)::bigint as documents, coalesce(sum(pages_processed), 0)::bigint as pages
      from (
        select processed_documents, pages_processed from project_runs
        where org_id = ${orgId} and created_at > now() - interval '1 day'
          and status = 'completed' and updated_at > now() - ${ACTIVITY_SUMMARY_RECENT_MINUTES}::int * interval '1 minute'
        order by created_at desc
        limit 1000
      ) recent`,
  ]);
  const history = new Map(historyRows.map(row => [row.project_id, { pages: Number(row.pages), runtimeMs: Number(row.runtime_ms) }]));

  const queued = { runs: 0, documents: 0, pages: 0 };
  const inProgress = { runs: 0, documents: 0, pages: 0, pagesProcessed: 0, pagesTotal: 0 };
  let pagesPerMinute: number | null = null;
  const etas: Array<RunEta | null> = [];
  for (const run of runs) {
    const total = count(run.pages_total);
    const processed = Math.min(total, count(run.pages_processed));
    const documentsLeft = Math.max(0, count(run.total_documents) - count(run.processed_documents));
    if (run.status === "queued") {
      queued.runs += 1; queued.documents += documentsLeft; queued.pages += total - processed;
    } else {
      inProgress.runs += 1; inProgress.documents += documentsLeft; inProgress.pages += total - processed;
      inProgress.pagesProcessed += processed; inProgress.pagesTotal += total;
      const rate = observedPagesPerMinute({ pagesProcessed: processed, startedAt: run.worker_started_at, now });
      if (rate !== null) pagesPerMinute = (pagesPerMinute ?? 0) + rate;
    }
    const eta = estimateRunEta({
      status: run.status, pagesTotal: total, pagesProcessed: processed, startedAt: run.worker_started_at,
      history: history.get(run.project_id) ?? null, now,
    });
    if (eta) notePrediction(run.id, orgId, eta);
    etas.push(eta);
  }
  const eta = truncated ? null : combineRunEtas(etas);
  return {
    queued,
    inProgress,
    recentlyCompleted: { runs: count(recent?.runs), documents: count(recent?.documents), pages: count(recent?.pages) },
    recentWindowMinutes: ACTIVITY_SUMMARY_RECENT_MINUTES,
    pagesPerMinute: pagesPerMinute === null ? null : Math.round(pagesPerMinute * 10) / 10,
    eta: eta ? { seconds: Math.round(eta.seconds), bucket: eta.bucket, estimate: eta.estimate } : null,
    truncated,
    generatedAt: new Date(now).toISOString(),
  };
}

const PREDICTED_MAX = 10_000;
const predicted = new Set<string>();

/**
 * ETA accuracy: the first estimate this process makes for a run, as a structured log. The worker logs the run's
 * actual duration when its outcome is recorded (`docslurp.run.eta.actual`); joining the two on run id in SigNoz
 * measures bucket accuracy. Per process, so a run seen by two API processes logs twice; take the earliest.
 */
export function notePrediction(runId: string, orgId: string, eta: RunEta): void {
  if (predicted.has(runId)) return;
  if (predicted.size >= PREDICTED_MAX) predicted.clear();
  predicted.add(runId);
  const seconds = Math.round(eta.seconds);
  const line = `[run-eta] predicted run=${runId} seconds=${seconds} bucket=${eta.bucket} basis=${eta.basis}`;
  console.log(line);
  emitTelemetryLog({
    severityText: "info", body: line, eventName: "docslurp.run.eta.predicted",
    attributes: {
      "docslurp.run.id": runId, "docslurp.org.id": orgId, "docslurp.eta.seconds": seconds, "docslurp.eta.bucket": eta.bucket,
      "docslurp.eta.basis": eta.basis, "docslurp.eta.pages_per_minute": Math.round(eta.pagesPerMinute * 100) / 100,
    },
  });
}
