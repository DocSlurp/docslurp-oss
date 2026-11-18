import { embeddingRouteSpaceUri, normalizeStoredPipelineFeatures, resolveEmbeddingRoute } from "@docslurp/shared";
import { sql } from "../db.js";
import { warmLanceDbSearch } from "./lancedb.js";

/**
 * Warm-up before the first search. A new process pays several one-time costs on its first
 * search of a table: loading the LanceDB library, the first storage connection, opening the
 * table and loading its vector and full-text indexes (seconds, even from the local disk
 * cache). Every cold search seen in production came within minutes of a process start, so
 * the process does that work itself, before startup completes, for the projects searched most in
 * the last week. It opens tables and loads indexes only: no query runs and nothing is returned.
 *
 * SEARCH_BOOT_WARM_PROJECTS: how many projects (default 5, at most 50; 0 turns it off, as
 * does SEARCH_LANCE_WARM=0). Production only (server.ts).
 */
const DEFAULT_PROJECTS = 5;
const MAX_PROJECTS = 50;
const RECENT_DAYS = 7;

export function bootWarmProjectLimit(env: Record<string, string | undefined> = process.env): number {
  // The per-search warm-up switch turns this one off as well.
  if (env.SEARCH_LANCE_WARM === "0") return 0;
  const raw = env.SEARCH_BOOT_WARM_PROJECTS?.trim();
  if (!raw) return DEFAULT_PROJECTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.warn(`[search] SEARCH_BOOT_WARM_PROJECTS="${raw}" is not a whole number of projects; using ${DEFAULT_PROJECTS}`);
    return DEFAULT_PROJECTS;
  }
  return Math.min(value, MAX_PROJECTS);
}

export interface BootWarmTarget { orgId: string; projectId: string; embeddingModel: string; dimension: number }

/** No organization takes more than this many of the warm places, however much it searches. */
const MAX_PROJECTS_PER_ORG = 2;
/** The whole lookup may hold a database connection this long; past it the warm-up is skipped. */
const LOOKUP_TIMEOUT_MS = 3_000;

/**
 * The projects to warm: the most searched of the last week that are not archived and have
 * indexed documents in the embedding space a search of them would use, at most
 * MAX_PROJECTS_PER_ORG per organization. Returned least searched first, so the busiest
 * project is loaded last and is the last to be evicted if the index cache fills.
 * - Org and project ids come from the projects table, never from a session's metadata.
 * - The embedding space comes from the project's pipeline, as it does for a search. The
 *   index rows only confirm that a table exists there (a project that changed its model
 *   still has rows for the old one).
 */
export async function recentSearchTargets(limit: number): Promise<BootWarmTarget[]> {
  if (limit <= 0) return [];
  return await sql.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = ${LOOKUP_TIMEOUT_MS}`);
    // More candidates than places: some have no index, and an organization's surplus is passed over.
    const candidates = await tx<Array<{ org_id: string | null; project_id: string; pipeline: unknown }>>`
      with recent as (
        select project_id, count(*) as searches, max(created_at) as last_search
        from search_sessions
        where project_id is not null and created_at > now() - make_interval(days => ${RECENT_DAYS})
        group by project_id
      )
      select p.org_id, p.id as project_id, p.pipeline
      from recent r
      join projects p on p.id = r.project_id
      where p.archived_at is null and p.org_id is not null
      order by r.searches desc, r.last_search desc
      limit ${limit * 4}
    `;
    const targets: BootWarmTarget[] = [];
    const perOrg = new Map<string, number>();
    for (const row of candidates) {
      if (targets.length >= limit) break;
      const orgId = row.org_id ?? "";
      if (!orgId || (perOrg.get(orgId) ?? 0) >= MAX_PROJECTS_PER_ORG) continue;
      let embedding: { provider: string; model: string; dimensions: number; modelUri?: string | null };
      try {
        embedding = resolveEmbeddingRoute(normalizeStoredPipelineFeatures(row.pipeline ?? null, `project ${row.project_id}`).embedding);
      } catch {
        continue; // A stored pipeline this build cannot read: that project is simply not warmed.
      }
      const [indexed] = await tx<Array<{ found: boolean }>>`
        select exists (
          select 1
          from documents d
          join vector_indexes vi on vi.document_id = d.id
          where d.project_id = ${row.project_id} and d.status = 'completed'
            and vi.backend = 'lancedb' and vi.embedding_model = ${embedding.model} and vi.dimension = ${embedding.dimensions}
            and coalesce(vi.embedding_model_uri = ${embeddingRouteSpaceUri(embedding, embedding.dimensions)}::text, true)
        ) as found
      `;
      if (!indexed?.found) continue;
      perOrg.set(orgId, (perOrg.get(orgId) ?? 0) + 1);
      targets.push({ orgId, projectId: row.project_id, embeddingModel: embedding.model, dimension: embedding.dimensions });
    }
    return targets.reverse();
  });
}

/**
 * Warm the recently searched projects, one after another (the index loader bounds its own
 * concurrency, and a search that arrives meanwhile joins a load in flight). Never throws.
 * `projects` counts the tables it asked for; a table that failed to load is retried by the
 * first search of it, as before.
 */
export async function warmRecentSearchIndexes(deps: {
  limit?: number;
  signal?: AbortSignal;
  targets?: (limit: number) => Promise<BootWarmTarget[]>;
  warm?: (target: BootWarmTarget & { hydrate: boolean; signal?: AbortSignal }) => Promise<void>;
  log?: (line: string) => void;
} = {}): Promise<{ projects: number; ms: number }> {
  const started = performance.now();
  const log = deps.log ?? ((line: string) => console.log(line));
  const limit = deps.limit ?? bootWarmProjectLimit();
  let projects = 0;
  try {
    if (limit > 0) {
      for (const target of await (deps.targets ?? recentSearchTargets)(limit)) {
        if (deps.signal?.aborted) break;
        // warmLanceDbSearch is best effort and swallows its own failures; guard the injected one too.
        await (deps.warm ?? warmLanceDbSearch)({ ...target, hydrate: true, ...(deps.signal ? { signal: deps.signal } : {}) }).catch(() => undefined);
        projects += 1;
      }
    }
  } catch (error) {
    log(`[search] boot warm skipped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const ms = Math.round(performance.now() - started);
  if (limit > 0) log(`[search] boot warm projects=${projects} limit=${limit} ms=${ms}`);
  return { projects, ms };
}


/** Startup never announces readiness after a timed-out warm-up. Native loads cannot
 * be cancelled; keep the one attempt shared so health probes cannot spawn retries.
 * Operators can disable warming explicitly with SEARCH_BOOT_WARM_PROJECTS=0.
 */
export function createBootWarmGate(warm: (signal: AbortSignal) => Promise<unknown>, timeoutMs = 30_000): () => Promise<void> {
  let attempt: Promise<void> | undefined;
  return () => attempt ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      await Promise.race([
        warm(controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Search boot warm-up exceeded readiness deadline")); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  })();
}
