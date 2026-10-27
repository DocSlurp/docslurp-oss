import { apiPool, sql } from "../db.js";
import type { SqlFragment } from "../lib/sql-fragments.js";
import { SEARCH_ELIGIBILITY_CHANNEL } from "./eligibility-hint.js";
import { lexicalSearchableDocument } from "./eligibility.js";
import type { SearchFilters } from "./filters.js";
import type { HashFilter } from "./index-serving.js";
import { loadSearchAvailability, type SearchAvailabilityRow } from "./session-setup.js";
import { envInt, TtlLruCache } from "./ttl-lru.js";

/**
 * Native search (SEARCH_LANCEDB_NATIVE): the per-workspace set of documents
 * search may serve, loaded with one query and cached for a short TTL, so a
 * search on a warm cache runs no eligibility or availability SQL. The set is
 * the LanceDB prefilter (documentId IN …) for vector and full-text queries.
 *
 * Freshness: entries live SEARCH_ELIGIBLE_CACHE_TTL_MS (default 15000) and are
 * dropped early when the worker's `run_events` NOTIFY hint names a run of the
 * workspace, i.e. when a document or run of the workspace changes state. A
 * document that completes indexing is therefore searchable within one hint
 * (or at worst one TTL), and one that is deleted or superseded stops being
 * served by the same bound; hits are still filtered to this set, never wider.
 */

export interface EligibleDocument {
  id: string;
  filename: string;
  mimeType: string | null;
  runId: string;
  tags: string[];
  /** Completed, current and registered in LanceDB for the cached embedding space. */
  vectorReady: boolean;
  /** Keyword search may serve it (fully indexed, or early lexical). */
  lexical: boolean;
  /** Document whose LanceDB rows are keyed by (dedup source); itself when not a copy. */
  ownerId: string | null;
  /** The owner's index config hash (index-config serving). */
  ownerIndexConfigHash: string | null;
  /**
   * A correction reindex rewrote the document's chunks after its LanceDB rows
   * were written: their text and hydration are stale, so native keyword
   * search leaves the document to Postgres FTS.
   */
  lanceStale: boolean;
}

export interface EligibleDocumentSet {
  workspaceId: string;
  embeddingModel: string;
  dimension: number;
  documents: EligibleDocument[];
  /** Completed documents with stored pages but no chunks: only completed-page search serves them. */
  pageOnlyCompletedDocuments: number;
  loadedAt: number;
}

type EligibleRow = {
  id: string;
  filename: string | null;
  mime_type: string | null;
  run_id: string;
  tags: string[] | null;
  vector_ready: boolean;
  lexical: boolean;
  page_only_completed: boolean;
  owner_id: string | null;
  owner_index_config_hash: string | null;
  lance_stale: boolean;
};

function falsy(value: string | undefined): boolean {
  return ["0", "false", "off", "no"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Native search is the default: lexical (BM25), vector and hydration come
 * from LanceDB, with Postgres fallbacks for tables without an FTS index, rows
 * without hydration columns and legacy tables. SEARCH_LANCEDB_NATIVE=0 is the
 * global kill switch; while it is off, SEARCH_LANCEDB_NATIVE_WORKSPACES=<id,…>
 * still turns native search on for the listed workspaces.
 */
export function searchLanceDbNativeEnabled(workspaceId: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!falsy(env.SEARCH_LANCEDB_NATIVE)) return true;
  if (!workspaceId) return false;
  return (env.SEARCH_LANCEDB_NATIVE_WORKSPACES ?? "").split(",").map((id) => id.trim()).filter(Boolean).includes(workspaceId);
}

export function eligibleCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return envInt("SEARCH_ELIGIBLE_CACHE_TTL_MS", 15_000, env);
}

const MAX_ENTRIES = 500;
let eligibleCache: TtlLruCache<Promise<EligibleDocumentSet>> | null = null;
let availabilityCache: TtlLruCache<Promise<SearchAvailabilityRow | undefined>> | null = null;
/** Workspace of each run seen in a cached set, so a run_events hint can drop the right entries. */
const runWorkspaces = new Map<string, string>();
/** Cache keys per workspace, for invalidation. */
const keysByWorkspace = new Map<string, Set<string>>();

function caches() {
  eligibleCache ??= new TtlLruCache(MAX_ENTRIES, eligibleCacheTtlMs());
  availabilityCache ??= new TtlLruCache(MAX_ENTRIES, eligibleCacheTtlMs());
  return { eligibleCache, availabilityCache };
}

function remember(workspaceId: string, key: string): void {
  const keys = keysByWorkspace.get(workspaceId) ?? new Set<string>();
  keys.add(key);
  keysByWorkspace.set(workspaceId, keys);
}

/** Drop every cached eligibility and availability entry of the workspace. */
export function invalidateSearchWorkspace(workspaceId: string): void {
  const keys = keysByWorkspace.get(workspaceId);
  if (!keys) return;
  keysByWorkspace.delete(workspaceId);
  for (const key of keys) {
    eligibleCache?.delete(key);
    availabilityCache?.delete(key);
  }
}

/** A run_events hint: invalidate the workspaces of the hinted runs (unknown runs are looked up off the search path). */
export async function invalidateSearchRuns(runIds: string[]): Promise<void> {
  const unknown: string[] = [];
  for (const runId of runIds) {
    const workspaceId = runWorkspaces.get(runId);
    if (workspaceId) invalidateSearchWorkspace(workspaceId);
    else unknown.push(runId);
  }
  if (unknown.length === 0 || keysByWorkspace.size === 0) return;
  const rows = await sql<{ id: string; workspace_id: string }[]>`
    select id, workspace_id from workspace_runs where id = any(${sql.array(unknown)})
  `;
  for (const row of rows) {
    if (runWorkspaces.size < 100_000) runWorkspaces.set(row.id, row.workspace_id);
    invalidateSearchWorkspace(row.workspace_id);
  }
}

let listening: Promise<unknown> | null = null;

function stringIds(payload: string, field: "runIds" | "workspaceIds"): string[] {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const ids = parsed[field];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** A search_eligibility hint (search/eligibility-hint.ts): drop the named workspaces. */
export function handleSearchEligibilityHint(payload: string): void {
  for (const workspaceId of stringIds(payload, "workspaceIds")) invalidateSearchWorkspace(workspaceId);
}

/**
 * Subscribe once per process to run_events hints (worker/src/db/run-event-store.ts)
 * and search_eligibility hints (API-side deletes). Best effort: the TTL still bounds staleness.
 */
function ensureInvalidationListener(): void {
  if (listening) return;
  // Tests replace ../db.js with partial mocks; without a pool there is nothing to listen on.
  let pool: typeof apiPool | undefined;
  try { pool = apiPool; } catch { /* mocked module without apiPool */ }
  if (typeof pool?.listen !== "function") return;
  listening = Promise.all([
    pool.listen("run_events", (payload) => {
      const runIds = stringIds(payload, "runIds");
      if (runIds.length) void invalidateSearchRuns(runIds).catch(() => undefined);
    }),
    pool.listen(SEARCH_ELIGIBILITY_CHANNEL, handleSearchEligibilityHint),
  ]).catch(() => {
    listening = null;
  });
}

async function queryEligibleDocuments(workspaceId: string, embeddingModel: string, dimension: number): Promise<EligibleDocumentSet> {
  const lexical: SqlFragment = lexicalSearchableDocument("d");
  // The vector part is the per-search `current_docs` CTE of vectorSearch,
  // including the walk from dedup copies to the document that owns the rows.
  const rows = await sql<EligibleRow[]>`
    with recursive scoped as (
      select d.id, d.filename, d.mime_type, d.run_id,
        (d.status = 'completed' and d.superseded_at is null and exists (
          select 1 from vector_indexes v
          where v.document_id = d.id and v.backend = 'lancedb'
            and v.embedding_model = ${embeddingModel} and v.dimension = ${dimension}
        )) as vector_ready,
        ${lexical} as lexical,
        (d.status = 'completed' and d.superseded_at is null
          and coalesce(d.chunk_count, 0) = 0 and coalesce(d.stored_page_count, 0) > 0) as page_only_completed,
        exists (
          select 1 from document_corrections dc
          join vector_indexes v on v.document_id = d.id and v.backend = 'lancedb'
          where dc.document_id = d.id and dc.reindex_completed_at > v.created_at
        ) as lance_stale
      from documents d
      where d.workspace_id = ${workspaceId}
        and ((d.status = 'completed' and d.superseded_at is null) or ${lexical})
    ),
    chain as (
      select s.id, d.id as node, d.deduped_from_document_id as next, 0 as depth
      from scoped s join documents d on d.id = s.id
      where s.vector_ready
      union all
      select chain.id, d.id, d.deduped_from_document_id, chain.depth + 1
      from chain join documents d on d.id = chain.next
      -- Rows live in this workspace's database: a source in another workspace
      -- is not the owner (the copy was indexed as its own rows).
      where chain.depth < 8 and d.workspace_id = ${workspaceId}
    ),
    owners as (
      select distinct on (chain.id) chain.id, chain.node as owner_id, owner.index_config_hash
      from chain join documents owner on owner.id = chain.node
      order by chain.id, chain.depth desc
    )
    select s.id, s.filename, s.mime_type, s.run_id, s.vector_ready, s.lexical, s.page_only_completed, s.lance_stale,
      o.owner_id, o.index_config_hash as owner_index_config_hash,
      (select array_agg(t.tag) from document_tags t where t.document_id = s.id) as tags
    from scoped s
    left join owners o on o.id = s.id
  `;
  const documents = rows.filter((row) => row.vector_ready || row.lexical).map((row) => ({
    id: row.id,
    filename: row.filename ?? "",
    mimeType: row.mime_type,
    runId: row.run_id,
    tags: row.tags ?? [],
    vectorReady: row.vector_ready,
    lexical: row.lexical,
    ownerId: row.vector_ready ? row.owner_id ?? row.id : null,
    ownerIndexConfigHash: row.owner_index_config_hash,
    lanceStale: row.lance_stale,
  }));
  return {
    workspaceId,
    embeddingModel,
    dimension,
    documents,
    pageOnlyCompletedDocuments: rows.filter((row) => row.page_only_completed).length,
    loadedAt: Date.now(),
  };
}

/** The cached eligible set for one workspace and embedding space; one query on a miss, none on a hit. */
export function loadEligibleDocuments(args: { workspaceId: string; embeddingModel: string; dimension: number }): Promise<EligibleDocumentSet> {
  ensureInvalidationListener();
  const { eligibleCache } = caches();
  const key = JSON.stringify(["eligible", args.workspaceId, args.embeddingModel, args.dimension]);
  const cached = eligibleCache.get(key);
  if (cached) return cached;
  const loading = queryEligibleDocuments(args.workspaceId, args.embeddingModel, args.dimension).then((set) => {
    for (const document of set.documents) if (runWorkspaces.size < 100_000) runWorkspaces.set(document.runId, set.workspaceId);
    return set;
  });
  // A failed load is not cached.
  loading.catch(() => eligibleCache.delete(key));
  eligibleCache.set(key, loading);
  remember(args.workspaceId, key);
  return loading;
}

/** Cached search availability (session-setup loadSearchAvailability) for native search. */
export function loadCachedSearchAvailability(args: { workspaceId: string; runId?: string }): Promise<SearchAvailabilityRow | undefined> {
  ensureInvalidationListener();
  const { availabilityCache } = caches();
  const key = JSON.stringify(["availability", args.workspaceId, args.runId ?? null]);
  const cached = availabilityCache.get(key);
  if (cached) return cached;
  const loading = loadSearchAvailability(args);
  loading.catch(() => availabilityCache.delete(key));
  availabilityCache.set(key, loading);
  remember(args.workspaceId, key);
  return loading;
}

/** Filters native search resolves from the cached set; anything else (chunk-level) uses the Postgres path. */
export function nativeScopeSupported(filters: SearchFilters | undefined): boolean {
  return !filters?.language && !filters?.headingPath?.length
    && filters?.pageRange?.from === undefined && filters?.pageRange?.to === undefined
    && filters?.dateRange?.from === undefined && filters?.dateRange?.to === undefined;
}

type LikeToken = { kind: "char"; value: string } | { kind: "one" } | { kind: "any" };

/**
 * Postgres `filename ILIKE '%' || value || '%'` (the Postgres path's filter) as
 * a linear-time matcher: `%` matches any run, `_` one character, a backslash
 * escapes the next character, case-insensitive. A glob match with one
 * backtrack point (the last `%`), so it is O(pattern x filename) at worst and
 * a pattern like `%%%%%!` cannot stall the event loop the way a regex can.
 */
export function ilikeContainsMatcher(value: string): (text: string) => boolean {
  const tokens: LikeToken[] = [{ kind: "any" }];
  const chars = Array.from(value.toLowerCase());
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === "\\" && index + 1 < chars.length) tokens.push({ kind: "char", value: chars[++index]! });
    else if (char === "%") { if (tokens.at(-1)?.kind !== "any") tokens.push({ kind: "any" }); }
    else if (char === "_") tokens.push({ kind: "one" });
    else tokens.push({ kind: "char", value: char });
  }
  if (tokens.at(-1)?.kind !== "any") tokens.push({ kind: "any" });
  return (text: string) => {
    const input = Array.from(text.toLowerCase());
    let t = 0;
    let p = 0;
    let starP = -1;
    let starT = 0;
    while (t < input.length) {
      const token = tokens[p];
      if (token && token.kind !== "any" && (token.kind === "one" || token.value === input[t])) {
        t += 1;
        p += 1;
      } else if (token?.kind === "any") {
        starP = p;
        starT = t;
        p += 1;
      } else if (starP >= 0) {
        p = starP + 1;
        starT += 1;
        t = starT;
      } else {
        return false;
      }
    }
    while (tokens[p]?.kind === "any") p += 1;
    return p === tokens.length;
  };
}

/** The documents of the set in scope for these filters (document-level filters only; see nativeScopeSupported). */
export function scopeEligibleDocuments(
  set: EligibleDocumentSet,
  filters: SearchFilters | undefined,
  runId: string | undefined,
): EligibleDocument[] {
  if (filters?.workspaceId && filters.workspaceId !== set.workspaceId) return [];
  const ids = new Set([...(filters?.documentId ? [filters.documentId] : []), ...(filters?.documentIds ?? [])]);
  const filename = filters?.filenameContains ? ilikeContainsMatcher(filters.filenameContains) : null;
  const mimeTypes = filters?.mimeTypes?.length ? new Set(filters.mimeTypes) : null;
  const tags = filters?.tags?.length ? new Set(filters.tags) : null;
  const runIds = [runId, filters?.runId].filter((id): id is string => Boolean(id));
  return set.documents.filter((document) =>
    (!filters?.documentId || document.id === filters.documentId)
    && (!filters?.documentIds?.length || ids.has(document.id))
    && (!filename || filename(document.filename))
    && (!mimeTypes || (document.mimeType !== null && mimeTypes.has(document.mimeType)))
    && (!tags || document.tags.some((tag) => tags.has(tag)))
    && runIds.every((id) => document.runId === id));
}

/** Index-config serving: keep documents whose owner was indexed under (or not under) the hash. */
export function matchesServingHash(document: EligibleDocument, hash: HashFilter | null | undefined): boolean {
  if (!hash) return true;
  return hash.op === "eq" ? document.ownerIndexConfigHash === hash.value : document.ownerIndexConfigHash !== hash.value;
}

export function resetEligibleDocumentCachesForTests(): void {
  eligibleCache = null;
  availabilityCache = null;
  runWorkspaces.clear();
  keysByWorkspace.clear();
}
