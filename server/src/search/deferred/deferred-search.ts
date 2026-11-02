import { classifyTemperature, type DeferredSearchStats, type MaterializationPolicy, type PrivacyMode } from "@docslurp/shared";

import { sql } from "../../db.js";
import type { UsageRecorder } from "../../lib/ai-usage.js";
import { canSpend } from "../../services/billing/spend-guard.js";
import type { SearchChunk, SearchOptions } from "../../services/search.js";
import { deferredCandidateDocument } from "../eligibility.js";
import { reciprocalRankFusion } from "../rrf.js";
import type { SearchSessionJournal } from "../session.js";
import type { MaterializeEvent } from "./deferred-context.js";
import { locateMapCandidates, type MapRouterCall } from "./map-locator.js";
import { createMapRouterCall } from "./map-router.js";
import { materializeForQuery } from "./materialize-client.js";
import { embedPageQuery } from "./page-query-embedder.js";
import { clearPageVectorCache, listPageVectorModels, locatePageImageCandidates } from "./page-vector-locator.js";

type Locator = "map-node" | "page-image";
interface Candidate {
  documentId: string;
  page: number;
  locator: Locator;
}

export interface DeferredSearchDeps {
  /** One query: scoped deferred documents with their page count and indexed-page coverage. */
  listDeferredDocuments(workspaceId: string, documentIds?: string[]): Promise<DeferredDocument[]>;
  now(): number;
  locateMap: typeof locateMapCandidates;
  listModels: typeof listPageVectorModels;
  embed: typeof embedPageQuery;
  locateImages: typeof locatePageImageCandidates;
  materialize: typeof materializeForQuery;
  canSpend(orgId: string, workspaceId: string): Promise<boolean>;
  invalidateVectors(workspaceId: string): void;
}

export interface DeferredDocument {
  id: string;
  mode: string;
  pageCount: number;
  indexedPages: number;
}

export const defaultDeferredSearchDeps: DeferredSearchDeps = {
  async listDeferredDocuments(workspaceId, documentIds) {
    if (documentIds?.length === 0) return [];
    type Row = { id: string; indexing_mode: string; page_count: number; indexed: number };
    const rows = documentIds && documentIds.length > 0
      ? await sql<Row[]>`
          select d.id, d.indexing_mode, d.page_count,
                 (select count(*)::int from document_page_states s
                   where s.document_id = d.id and s.state in ('indexed', 'blocked-pii')) as indexed
          from documents d
          where d.workspace_id = ${workspaceId} and d.indexing_mode <> 'full' and ${deferredCandidateDocument("d")}
            and d.id = any(${sql.array(documentIds, 25)})`
      : await sql<Row[]>`
          select d.id, d.indexing_mode, d.page_count,
                 (select count(*)::int from document_page_states s
                   where s.document_id = d.id and s.state in ('indexed', 'blocked-pii')) as indexed
          from documents d
          where d.workspace_id = ${workspaceId} and d.indexing_mode <> 'full' and ${deferredCandidateDocument("d")}`;
    return rows.map((row) => ({ id: row.id, mode: row.indexing_mode, pageCount: Number(row.page_count) || 0, indexedPages: Number(row.indexed) || 0 }));
  },
  now: () => Date.now(),
  locateMap: locateMapCandidates,
  listModels: listPageVectorModels,
  embed: embedPageQuery,
  locateImages: locatePageImageCandidates,
  materialize: materializeForQuery,
  canSpend: (orgId, workspaceId) => canSpend(orgId, workspaceId),
  invalidateVectors: clearPageVectorCache,
};

export interface DeferredSearchArgs {
  query: string;
  textQuery: string;
  queryVector: number[] | null;
  userId: string;
  orgId: string;
  workspaceId: string;
  options: SearchOptions;
  /**
   * The policy, or a lazy resolver: it is only invoked once the scope is known to hold deferred documents
   * that are not fully indexed, so full-mode workspaces never pay for key lookups.
   */
  policy: MaterializationPolicy | (() => Promise<MaterializationPolicy>);
  privacyMode: PrivacyMode;
  openRouterApiKey?: string | undefined;
  journal: SearchSessionJournal;
  onEvent?: (event: MaterializeEvent) => void;
  signal?: AbortSignal;
  /** Restricted retrieval over the candidate documents once their pages are searchable. */
  search: {
    textSearch(args: { query: string; userId: string; options: SearchOptions }): Promise<SearchChunk[]>;
    vectorSearch(args: { queryVector: number[]; userId: string; workspaceId: string; options: SearchOptions }): Promise<SearchChunk[]>;
  };
}

function scopedDocumentIds(options: SearchOptions): string[] | undefined {
  const filters = options.filters;
  if (filters?.documentIds !== undefined) {
    return [...new Set(filters.documentIds)].filter(id => !filters.documentId || id === filters.documentId);
  }
  return filters?.documentId ? [filters.documentId] : undefined;
}

/** Interleave ranked lists so each locator's best pages survive the per-query cap. */
function interleave(lists: Candidate[][], cap: number): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (let rank = 0; out.length < cap && lists.some((list) => rank < list.length); rank++) {
    for (const list of lists) {
      const item = list[rank];
      if (!item) continue;
      const key = `${item.documentId}:${item.page}`;
      if (seen.has(key) || out.length >= cap) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export interface DeferredSearchResult {
  chunks: SearchChunk[];
  stats: DeferredSearchStats;
  /** Deferred-mode documents in scope; only their results carry retrieval temperature. */
  documentIds: string[];
}

function emptyStats(over: Partial<DeferredSearchStats>): DeferredSearchStats {
  return {
    temperature: "hot", candidatePages: 0, indexedCandidatePages: 0, materializedPages: 0, pendingPages: 0,
    materializeMs: 0, creditsSpent: 0, routerUsed: false, fallbackUsed: false, stoppedBy: null, ...over,
  };
}

/**
 * Deferred page search: locate candidate pages in the Index Maps and page-image
 * vectors of deferred-mode documents, materialize only those pages (bounded by
 * the policy), then return chunks restricted to the candidate documents with
 * the pages the locators picked ranked first. Returns null when the scope has
 * no deferred documents. Never throws: any failure degrades to the normal
 * retrieval path with a diagnostic.
 */
export async function runDeferredPageSearch(
  args: DeferredSearchArgs,
  deps: DeferredSearchDeps = defaultDeferredSearchDeps,
): Promise<DeferredSearchResult | null> {
  const { journal, workspaceId } = args;
  try {
    const startedAt = deps.now();
    const selected = scopedDocumentIds(args.options);
    if (selected?.length === 0) return null;
    // Spatial queries use accepted current structured projections. Cold-page locators
    // cannot maintain that revision fence throughout model/materialization work.
    if (args.options.filters?.geo) {
      journal.recordDiagnostic("deferredSkipped", { reason: "spatial-scope" });
      return null;
    }
    const docs = (await deps.listDeferredDocuments(workspaceId, selected))
      .filter(doc => selected === undefined || selected.includes(doc.id));
    if (docs.length === 0) return null;
    const documentIdsInScope = docs.map((d) => d.id);

    // Hot: every page of every scoped deferred document is already searchable.
    // Normal retrieval covers them, so skip locators, router and embedding.
    if (docs.every((d) => d.pageCount > 0 && d.indexedPages >= d.pageCount)) {
      const stats = emptyStats({});
      journal.recordDiagnostic("deferred", stats);
      return { chunks: [], stats, documentIds: documentIdsInScope };
    }
    const policy = typeof args.policy === "function" ? await args.policy() : args.policy;
    // The policy forbids materializing anything: indexed results only.
    if (policy.maxPagesPerQuery <= 0 || policy.maxCreditsPerQuery <= 0) {
      // Temperature comes from the ledger: partially indexed scopes are warm, untouched ones cold.
      const totalPages = docs.reduce((sum, d) => sum + d.pageCount, 0);
      const indexedPages = docs.reduce((sum, d) => sum + d.indexedPages, 0);
      const stats = emptyStats({ temperature: classifyTemperature(totalPages, indexedPages), stoppedBy: "policy" });
      journal.recordDiagnostic("deferred", stats);
      return { chunks: [], stats, documentIds: documentIdsInScope };
    }

    // One memoized spend check gates every model call of this phase.
    let spendOk: Promise<boolean> | null = null;
    const spend = () => (spendOk ??= deps.canSpend(args.orgId, workspaceId));
    let routerCall: MapRouterCall | undefined;
    if (args.openRouterApiKey && policy.mapRouter !== "off") {
      const llm = createMapRouterCall({ apiKey: args.openRouterApiKey, privacyMode: args.privacyMode, journal });
      routerCall = async (input) => {
        if (!(await spend())) throw new Error("router skipped: cannot spend");
        return llm(input);
      };
    }

    const mapDocs = docs.filter((d) => d.mode === "map").map((d) => d.id);
    const visualDocs = docs.filter((d) => d.mode === "visual").map((d) => d.id);
    const cap = policy.maxPagesPerQuery;

    const locateImages = async (documentIds: string[]): Promise<{ list: Candidate[]; degraded: boolean }> => {
      if (documentIds.length === 0) return { list: [], degraded: false };
      const models = await deps.listModels(workspaceId, documentIds);
      const model = models[0];
      if (!model) return { list: [], degraded: false };
      if (!(await spend())) return { list: [], degraded: true };
      const vector = await deps.embed({ model, query: args.query, journal: journal as UsageRecorder, privacyMode: args.privacyMode });
      if (!vector) return { list: [], degraded: true };
      const hits = await deps.locateImages({ workspaceId, documentIds, model, queryVector: vector, k: cap });
      return { list: hits.map((h) => ({ documentId: h.documentId, page: h.page, locator: "page-image" as const })), degraded: false };
    };

    const [map, images] = await Promise.all([
      mapDocs.length > 0
        ? deps.locateMap({ query: args.query, documentIds: mapDocs, maxPages: cap, router: policy.mapRouter, routerCall })
        : Promise.resolve({ pages: [], routerUsed: false, confident: true }),
      locateImages(visualDocs).catch(() => ({ list: [] as Candidate[], degraded: true })),
    ]);
    const mapList: Candidate[] = map.pages.map((p) => ({ documentId: p.documentId, page: p.page, locator: "map-node" as const }));
    let degraded = images.degraded;
    let lists = [mapList, images.list];

    // No confident map pick: try page vectors for the map documents that have them.
    let fallbackUsed = false;
    if (mapDocs.length > 0 && !map.confident) {
      fallbackUsed = true;
      const extra = await locateImages(mapDocs).catch(() => ({ list: [] as Candidate[], degraded: true }));
      degraded ||= extra.degraded;
      lists = [...lists, extra.list];
    }
    if (visualDocs.length > 0 && images.list.length === 0) fallbackUsed = true;
    if (degraded) journal.recordDiagnostic("deferredDegraded", { degraded: true });

    const candidates = interleave(lists.map(list => list.filter(candidate => documentIdsInScope.includes(candidate.documentId))), cap);
    const stats = await deps.materialize({
      orgId: args.orgId, userId: args.userId, workspaceId, sessionId: journal.sessionId,
      candidates, policy, onEvent: args.onEvent, signal: args.signal, startedAt,
      recordDiagnostic: (key, value) => journal.recordDiagnostic(key, value),
    });
    stats.routerUsed = map.routerUsed;
    stats.fallbackUsed = fallbackUsed;
    journal.recordDiagnostic("deferred", stats);
    journal.recordDiagnostic("deferredCandidates", candidates.slice(0, 200));
    if (stats.materializedPages > 0) deps.invalidateVectors(workspaceId);
    if (stats.temperature === "hot" || candidates.length === 0) return { chunks: [], stats, documentIds: documentIdsInScope };

    if (args.signal?.aborted) return { chunks: [], stats, documentIds: documentIdsInScope };
    const documentIds = [...new Set(candidates.map((c) => c.documentId))];
    const restricted: SearchOptions = {
      ...args.options,
      filters: { ...args.options.filters, documentId: undefined, documentIds },
    };
    const [text, vector] = await Promise.all([
      args.search.textSearch({ query: args.textQuery, userId: args.userId, options: restricted }),
      args.queryVector
        ? args.search.vectorSearch({ queryVector: args.queryVector, userId: args.userId, workspaceId, options: restricted })
        : Promise.resolve([] as SearchChunk[]),
    ]);
    const locatorByPage = new Map(candidates.map((c) => [`${c.documentId}:${c.page}`, c.locator]));
    const labelled = (reciprocalRankFusion([text, vector]) ?? []).map((chunk): SearchChunk => {
      const pages = chunk.pageNumbers.length > 0 ? chunk.pageNumbers : chunk.pageNumber != null ? [chunk.pageNumber] : [];
      const locator = pages.map((p) => locatorByPage.get(`${chunk.documentId}:${p}`)).find(Boolean);
      return locator ? { ...chunk, deferredLocator: locator } : chunk;
    });
    const onCandidate = labelled.filter((chunk) => chunk.deferredLocator);
    return { chunks: [...onCandidate, ...labelled.filter((chunk) => !chunk.deferredLocator)], stats, documentIds: documentIdsInScope };
  } catch (error) {
    console.warn(`[deferred-search] degraded to standard retrieval: ${error instanceof Error ? error.message : String(error)}`);
    journal.recordDiagnostic("deferredError", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
