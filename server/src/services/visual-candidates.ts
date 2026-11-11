import { VISUAL_CANDIDATE_STATS_KEY, visualCandidateStatsSchema, type VisualCandidateStats, type VisualSource } from "@docslurp/shared";
import { sql, type SqlClient } from "../db.js";

/**
 * Charts and diagrams the pipeline noticed in a project's current documents, aggregated from the per-document
 * `VisualCandidateStats` the worker records at ingest under `VISUAL_CANDIDATE_STATS_KEY` in the stats of a stage of the
 * document's current run. Document metadata is never read: the worker does not write it there, and a metadata field a
 * tenant could write must not be able to forge counts that lower estimates or steer recommendations. Free signals only: chat suggestions and the ingest report use it
 * to say "this project has N charts that were not exported".
 *
 * Tenant boundary: every read is scoped to both the organization and the project, and the project must belong to
 * that organization. A missing scope is a programming error and throws instead of widening the query.
 */
export interface ProjectVisualCandidates {
  /** Current documents that reported visual candidate stats. */
  documents: number;
  charts: number;
  diagrams: number;
  exported: number;
  /** charts + diagrams not exported (never negative). */
  unexported: number;
  pagesWithUnexportedVisuals: number;
  /** Documents with at least one unexported visual (newest first, capped). */
  documentIds: string[];
}

/** Documents read per project; enough for a suggestion signal, bounded for chat latency. */
export const VISUAL_CANDIDATES_DOCUMENT_LIMIT = 2_000;
const DOCUMENT_ID_LIMIT = 100;

export const emptyProjectVisualCandidates = (): ProjectVisualCandidates => ({
  documents: 0, charts: 0, diagrams: 0, exported: 0, unexported: 0, pagesWithUnexportedVisuals: 0, documentIds: [],
});

/** Validated stats or null: the stored JSON is worker output, so anything malformed is ignored. */
export function parseVisualCandidateStats(value: unknown): VisualCandidateStats | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = visualCandidateStatsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Pure aggregation (exported for tests). */
export function aggregateVisualCandidates(rows: Array<{ documentId: string; stats: unknown }>): ProjectVisualCandidates {
  const out = emptyProjectVisualCandidates();
  for (const row of rows) {
    const stats = parseVisualCandidateStats(row.stats);
    if (!stats) continue;
    out.documents += 1;
    out.charts += stats.charts;
    out.diagrams += stats.diagrams;
    const exported = Math.min(stats.exported, stats.charts + stats.diagrams);
    out.exported += exported;
    const unexported = stats.charts + stats.diagrams - exported;
    out.unexported += unexported;
    out.pagesWithUnexportedVisuals += new Set(stats.pagesWithUnexportedVisuals).size;
    if ((unexported > 0 || stats.pagesWithUnexportedVisuals.length > 0) && out.documentIds.length < DOCUMENT_ID_LIMIT) out.documentIds.push(row.documentId);
  }
  return out;
}

/** Documents a chat turn reads (newest first): a suggestion hint, so a small sample is enough. */
export const CHAT_VISUAL_CANDIDATES_DOCUMENT_LIMIT = 300;
/** How long a project's chat hint counts are reused (per process). */
const CHAT_CACHE_TTL_MS = 5 * 60_000;
const CHAT_CACHE_MAX = 500;
const chatCache = new Map<string, { at: number; value: ProjectVisualCandidates }>();

export async function loadProjectVisualCandidates(
  scope: { orgId: string; projectId: string },
  client: SqlClient = sql,
  options: { limit?: number } = {},
): Promise<ProjectVisualCandidates> {
  if (!scope.orgId || !scope.projectId) throw new Error("loadProjectVisualCandidates requires orgId and projectId");
  const rows = await loadStatsRows(scope, null, client, options.limit ?? VISUAL_CANDIDATES_DOCUMENT_LIMIT);
  return aggregateVisualCandidates(rows);
}

/**
 * Chat suggestions' read of `loadProjectVisualCandidates`: the newest CHAT_VISUAL_CANDIDATES_DOCUMENT_LIMIT documents,
 * cached per organization and project for a few minutes, so a suggestions turn costs at most one bounded query.
 */
export async function loadChatVisualCandidates(scope: { orgId: string; projectId: string }, now = Date.now()): Promise<ProjectVisualCandidates> {
  if (!scope.orgId || !scope.projectId) throw new Error("loadChatVisualCandidates requires orgId and projectId");
  const key = `${scope.orgId}:${scope.projectId}`;
  const hit = chatCache.get(key);
  if (hit && now - hit.at < CHAT_CACHE_TTL_MS) return hit.value;
  const value = await loadProjectVisualCandidates(scope, sql, { limit: CHAT_VISUAL_CANDIDATES_DOCUMENT_LIMIT });
  if (chatCache.size >= CHAT_CACHE_MAX) chatCache.delete(chatCache.keys().next().value!);
  chatCache.set(key, { at: now, value });
  return value;
}

/** Recorded visual counts for a set of documents, in the shape chart export estimates price (`VisualCandidateStats`). */
export interface VisualEstimateStats {
  /** Documents among the requested ones that reported stats. */
  documents: number;
  charts: number;
  diagrams: number;
  bySource: Partial<Record<VisualSource, number>>;
}

/** Pure sum (exported for tests). */
export function sumVisualEstimateStats(rows: Array<{ documentId: string; stats: unknown }>): VisualEstimateStats {
  const out: VisualEstimateStats = { documents: 0, charts: 0, diagrams: 0, bySource: {} };
  for (const row of rows) {
    const stats = parseVisualCandidateStats(row.stats);
    if (!stats) continue;
    out.documents += 1;
    out.charts += stats.charts;
    out.diagrams += stats.diagrams;
    for (const [source, count] of Object.entries(stats.bySource) as Array<[VisualSource, number | undefined]>) {
      if (count) out.bySource[source] = (out.bySource[source] ?? 0) + count;
    }
  }
  return out;
}

/**
 * Recorded stats for estimating chart export over `documentIds` in one project. Scoped like
 * `loadProjectVisualCandidates` (organization and project, both required); ids outside the scope are ignored.
 */
export async function loadVisualStatsForEstimate(
  scope: { orgId: string; projectId: string; documentIds: readonly string[] },
  client: SqlClient = sql,
): Promise<VisualEstimateStats> {
  if (!scope.orgId || !scope.projectId) throw new Error("loadVisualStatsForEstimate requires orgId and projectId");
  if (scope.documentIds.length === 0) return { documents: 0, charts: 0, diagrams: 0, bySource: {} };
  const rows = await loadStatsRows(scope, scope.documentIds.slice(0, VISUAL_CANDIDATES_DOCUMENT_LIMIT), client, VISUAL_CANDIDATES_DOCUMENT_LIMIT);
  return sumVisualEstimateStats(rows);
}

async function loadStatsRows(
  scope: { orgId: string; projectId: string },
  documentIds: readonly string[] | null,
  client: SqlClient,
  limit: number,
): Promise<Array<{ documentId: string; stats: unknown }>> {
  const key = VISUAL_CANDIDATE_STATS_KEY;
  // The documents are picked (and limited) first, so the per-document stage lookup runs at most `limit` times.
  const rows = await client<{ document_id: string; stats: unknown }[]>`
    with picked as (
      select d.id, d.run_id, d.created_at
      from documents d
      join projects p on p.id = d.project_id
      where p.id = ${scope.projectId} and p.org_id = ${scope.orgId}
        and d.project_id = ${scope.projectId} and d.org_id = ${scope.orgId}
        and d.purged_at is null and d.superseded_at is null and d.archived_at is null
        ${documentIds ? client`and d.id = any(${client.array([...documentIds])})` : client``}
      order by d.created_at desc, d.id
      limit ${Math.max(1, Math.min(limit, VISUAL_CANDIDATES_DOCUMENT_LIMIT))}
    )
    select picked.id as document_id, stage.stats
    from picked
    left join lateral (
      select s.stats -> ${key}::text as stats from document_run_stage_states s
      where s.document_id = picked.id and s.run_id = picked.run_id and jsonb_typeof(s.stats -> ${key}::text) = 'object'
      order by s.updated_at desc limit 1
    ) stage on true
    order by picked.created_at desc, picked.id
  `;
  return rows.map((row) => ({ documentId: row.document_id, stats: row.stats }));
}
