import type { SearchResponse, SearchResult } from "./index.js";

/**
 * Typed events of `POST /v1/search/stream` (Server-Sent Events). The wire contract is
 * `SEARCH_STREAM_PROTOCOL` 1. Every event carries `searchId`, a 0-based `seq` that strictly increases per stream,
 * and `elapsedMs` since the server accepted the request. Hits are provisional; only `search.results` is the answer.
 */
export type SearchStreamLeg = "lexical" | "vector" | "graph" | "community" | "progressive-page" | "completed-page" | "deferred";
export type SearchStreamPhase = "queue" | "setup" | "plan" | "prepare" | "embed" | "retrieve" | "fuse" | "rerank" | "finalize";

export type SearchStreamStats = { ms: number; candidates?: number; timedOut?: boolean };
export type SearchStreamHit = {
  /** Stable identity across legs and the final list: `searchResultId(result)`. */
  id: string;
  /** 0-based rank within this leg only. */
  legRank: number;
  /**
   * The hit body, sent the first time an id appears on the stream. A later leg or sub-search that finds the same
   * id sends `id` and `legRank` only; keep the earlier body.
   */
  result?: SearchResult;
};

type Envelope = { searchId: string; seq: number; elapsedMs: number };

export type SearchStreamStartedEvent = Envelope & { type: "search.started"; protocol: 1; projectId?: string; cached: boolean };
export type SearchStreamPhaseEvent = Envelope & { type: "search.phase"; phase: SearchStreamPhase; subSearch?: number; stats: SearchStreamStats };
export type SearchStreamHitsEvent = Envelope & {
  type: "search.hits";
  leg: SearchStreamLeg;
  subSearch?: number;
  hits: SearchStreamHit[];
  truncated: boolean;
  stats?: SearchStreamStats;
};
export type SearchStreamResultsEvent = Envelope & { type: "search.results"; ids: string[]; response: SearchResponse };
export type SearchStreamErrorEvent = Envelope & { type: "search.error"; error: { code: string; message: string; status: number } };
export type SearchStreamDoneEvent = Envelope & { type: "search.done"; sessionId: string; resultCount: number; timings?: Record<string, number> };

export type SearchStreamEvent =
  | SearchStreamStartedEvent
  | SearchStreamPhaseEvent
  | SearchStreamHitsEvent
  | SearchStreamResultsEvent
  | SearchStreamErrorEvent
  | SearchStreamDoneEvent;
export type SearchStreamEventType = SearchStreamEvent["type"];

/**
 * The same id the server uses in `search.hits` and `search.results.ids`. Page-stage results (page text, map nodes,
 * page images) number pages where chunk results number chunks, so the stage is part of their id.
 */
export function searchResultId(result: {
  citation: { documentId: string; chunkIndex: number; source?: string | null };
  retrieval?: { stage?: string } | undefined;
}): string {
  const stage = result.retrieval?.stage;
  const prefix = `${result.citation.source ?? "document"}:${result.citation.documentId}`;
  return stage && stage !== "chunk" ? `${prefix}:${stage}:${result.citation.chunkIndex}` : `${prefix}:${result.citation.chunkIndex}`;
}

/** One result in a {@link SearchStreamView}: the legs that found it, and its rank in each. */
export type MergedSearchHit = {
  id: string;
  result: SearchResult;
  /** Legs that found this result, in the order they landed. Empty for a final result no leg reported. */
  legs: SearchStreamLeg[];
  legRanks: Partial<Record<SearchStreamLeg, number>>;
};

export type SearchStreamLegSummary = SearchStreamStats & { hits: number; truncated: boolean };

export type SearchStreamSubSearchView = {
  legs: Partial<Record<SearchStreamLeg, SearchStreamLegSummary>>;
  phases: Partial<Record<SearchStreamPhase, SearchStreamStats>>;
};

/** What a UI needs to render a streaming search; build it with {@link mergeSearchStream}. */
export type SearchStreamView = {
  status: "idle" | "searching" | "complete" | "error";
  searchId?: string;
  cached: boolean;
  elapsedMs: number;
  /** Provisional until `final`: ordered by best rank in any leg, then by how many legs agree. Then the authoritative order. */
  hits: MergedSearchHit[];
  /** True once `search.results` arrived: `hits` is the authoritative list. */
  final: boolean;
  legs: Partial<Record<SearchStreamLeg, SearchStreamLegSummary>>;
  phases: Partial<Record<SearchStreamPhase, SearchStreamStats>>;
  /** Legs and phases of each sub-search (decomposition, stepback, multi-hop), by 0-based index. `legs` and `phases` are the root search. */
  subSearches: Record<number, SearchStreamSubSearchView>;
  response?: SearchResponse;
  error?: SearchStreamErrorEvent["error"];
  /** Whole-search phase timings from `search.done`, when the request set `stats`. */
  timings?: Record<string, number>;
};

export function emptySearchStreamView(): SearchStreamView {
  return { status: "idle", cached: false, elapsedMs: 0, hits: [], final: false, legs: {}, phases: {}, subSearches: {} };
}

type LegMap = SearchStreamView["legs"];
type PhaseMap = SearchStreamView["phases"];

/** Applies `update` to the root search (`subSearch` undefined) or to one sub-search of the view. */
function withScope(view: SearchStreamView, subSearch: number | undefined, update: (scope: SearchStreamSubSearchView) => SearchStreamSubSearchView): SearchStreamView {
  if (subSearch === undefined) {
    const next = update({ legs: view.legs, phases: view.phases });
    return { ...view, legs: next.legs, phases: next.phases };
  }
  const next = update(view.subSearches[subSearch] ?? { legs: {}, phases: {} });
  return { ...view, subSearches: { ...view.subSearches, [subSearch]: next } };
}

/**
 * Folds one event into a view model without mutating the previous one. Hits are deduplicated by `id` across legs
 * (and sub-searches) and keep the legs that found them; `search.results` replaces them with the authoritative order.
 * A hit without a body (a later leg finding an id already sent) adds its leg to the earlier hit and never creates a
 * row of its own. Leg summaries and phases are kept per sub-search. Events after `search.results` or `search.error`
 * change only the bookkeeping, never the hit list. Unknown events are ignored.
 */
export function mergeSearchStream(view: SearchStreamView, event: SearchStreamEvent): SearchStreamView {
  const base = event.searchId === undefined ? view : { ...view, searchId: event.searchId, elapsedMs: Math.max(view.elapsedMs, event.elapsedMs) };
  switch (event.type) {
    case "search.started":
      return { ...base, status: "searching", cached: event.cached === true };
    case "search.phase":
      return withScope(base, event.subSearch, scope => ({ ...scope, phases: { ...scope.phases, [event.phase]: event.stats } as PhaseMap }));
    case "search.hits": {
      const scoped = withScope(base, event.subSearch, scope => ({
        ...scope,
        legs: {
          ...scope.legs,
          [event.leg]: { ...(scope.legs[event.leg] ?? {}), ...(event.stats ?? {}), hits: Math.max(scope.legs[event.leg]?.hits ?? 0, event.hits.length), truncated: event.truncated === true },
        } as LegMap,
      }));
      if (base.final || base.status === "error") return scoped;
      const byId = new Map(base.hits.map(hit => [hit.id, hit]));
      for (const hit of event.hits) {
        const known = byId.get(hit.id);
        if (!known) {
          // A body-less hit for an id never seen cannot be shown; the final list still carries it.
          if (hit.result) byId.set(hit.id, { id: hit.id, result: hit.result, legs: [event.leg], legRanks: { [event.leg]: hit.legRank } });
          continue;
        }
        const seen = known.legs.includes(event.leg);
        const previous = known.legRanks[event.leg];
        byId.set(hit.id, {
          ...known,
          legs: seen ? known.legs : [...known.legs, event.leg],
          legRanks: { ...known.legRanks, [event.leg]: previous === undefined ? hit.legRank : Math.min(previous, hit.legRank) },
        });
      }
      const best = (hit: MergedSearchHit) => Math.min(...Object.values(hit.legRanks).map(Number));
      const hits = [...byId.values()].sort((a, b) => best(a) - best(b) || b.legs.length - a.legs.length);
      return { ...scoped, status: "searching", hits };
    }
    case "search.results": {
      const provisional = new Map(base.hits.map(hit => [hit.id, hit]));
      const results = event.response.results;
      const hits = results.map((result, index): MergedSearchHit => {
        const id = event.ids[index] ?? searchResultId(result);
        const known = provisional.get(id);
        return { id, result, legs: known?.legs ?? [], legRanks: known?.legRanks ?? {} };
      });
      return { ...base, hits, final: true, response: event.response, status: "complete" };
    }
    case "search.error":
      return { ...base, status: "error", error: event.error };
    case "search.done":
      return { ...base, status: base.status === "error" ? "error" : "complete", ...(event.timings ? { timings: event.timings } : {}) };
    default:
      return view;
  }
}

/** Folds a whole list of events; handy for tests and for replaying a recorded stream. */
export function foldSearchStream(events: Iterable<SearchStreamEvent>, from: SearchStreamView = emptySearchStreamView()): SearchStreamView {
  let view = from;
  for (const event of events) view = mergeSearchStream(view, event);
  return view;
}
