import { sql } from "../db.js";
import { warmLanceDbSearch } from "./lancedb.js";

/**
 * Warm-up before the first search. A new process pays several one-time costs on its first
 * search of a table: loading the LanceDB library, the first storage connection, opening the
 * table and loading its vector and full-text indexes (seconds, even from the local disk
 * cache). Every cold search seen in production came within minutes of a process start, so
 * the process does that work itself, in the background, for the projects searched most
 * recently. It opens tables and loads indexes only: no query runs and nothing is returned.
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

/**
 * The most recently searched projects that have a LanceDB index, newest first. Org and
 * project ids come from the projects table, never from the search session's metadata.
 */
export async function recentSearchTargets(limit: number): Promise<BootWarmTarget[]> {
  if (limit <= 0) return [];
  const rows = await sql<Array<{ org_id: string; project_id: string; embedding_model: string; dimension: number }>>`
    with recent as (
      select project_id, max(created_at) as last_search
      from search_sessions
      where project_id is not null and created_at > now() - make_interval(days => ${RECENT_DAYS})
      group by project_id
      order by last_search desc
      limit ${limit}
    )
    select p.org_id, p.id as project_id, v.embedding_model, v.dimension
    from recent r
    join projects p on p.id = r.project_id
    cross join lateral (
      select vi.embedding_model, vi.dimension
      from documents d
      join vector_indexes vi on vi.document_id = d.id
      where d.project_id = p.id and vi.backend = 'lancedb'
      limit 1
    ) v
    order by r.last_search desc
  `;
  return rows.map((row) => ({ orgId: row.org_id, projectId: row.project_id, embeddingModel: row.embedding_model, dimension: Number(row.dimension) }));
}

/**
 * Warm the recently searched projects, one after another (the index loader bounds its own
 * concurrency, and a search that arrives meanwhile joins a load in flight). Never throws.
 */
export async function warmRecentSearchIndexes(deps: {
  limit?: number;
  targets?: (limit: number) => Promise<BootWarmTarget[]>;
  warm?: (target: BootWarmTarget & { hydrate: boolean }) => Promise<void>;
  log?: (line: string) => void;
} = {}): Promise<{ projects: number; ms: number }> {
  const started = performance.now();
  const log = deps.log ?? ((line: string) => console.log(line));
  const limit = deps.limit ?? bootWarmProjectLimit();
  let projects = 0;
  try {
    if (limit > 0) {
      for (const target of await (deps.targets ?? recentSearchTargets)(limit)) {
        // warmLanceDbSearch is best effort and swallows its own failures; guard the injected one too.
        await (deps.warm ?? warmLanceDbSearch)({ ...target, hydrate: true }).catch(() => undefined);
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
