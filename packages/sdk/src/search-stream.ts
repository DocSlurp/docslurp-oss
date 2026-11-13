import type { SearchResponse, SearchResult } from "./index.js";

/**
 * Typed events of `POST /v1/search/stream` (Server-Sent Events). The wire contract is
 * `SEARCH_STREAM_PROTOCOL` 1. Every event carries `searchId`, a 0-based `seq` that strictly increases per stream,
 * and `elapsedMs` since the server accepted the request. Hits are provisional; only `search.results` is the answer.
 */
export type SearchStreamLeg = "lexical" | "vector" | "graph" | "community" | "progressive-page" | "completed-page" | "deferred";
export type SearchStreamPhase = "queue" | "setup" | "plan" | "prepare" | "embed" | "retrieve" | "fuse" | "rerank" | "finalize";

export type SearchStreamStats = { ms: number; candidates?: number; cacheHit?: boolean; timedOut?: boolean };
export type SearchStreamHit = {
  /** Stable identity across legs and the final list: `searchResultId(result.citation)`. */
  id: string;
  /** 0-based rank within this leg only. */
  legRank: number;
  result: SearchResult;
};

type Envelope = { searchId: string; seq: number; elapsedMs: number };

export type SearchStreamStartedEvent = Envelope & { type: "search.started"; protocol: 1; projectId: string; cached: boolean };
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

/** The same id the server uses in `search.hits` and `search.results.ids`. */
export function searchResultId(citation: { documentId: string; chunkIndex: number; source?: string | null }): string {
  return `${citation.source ?? "document"}:${citation.documentId}:${citation.chunkIndex}`;
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
  response?: SearchResponse;
  error?: SearchStreamErrorEvent["error"];
  /** Whole-search phase timings from `search.done`, when the request set `stats`. */
  timings?: Record<string, number>;
};

export function emptySearchStreamView(): SearchStreamView {
  return { status: "idle", cached: false, elapsedMs: 0, hits: [], final: false, legs: {}, phases: {} };
}

/**
 * Folds one event into a view model without mutating the previous one. Hits are deduplicated by `id` across legs
 * (and sub-searches) and keep the legs that found them; `search.results` replaces them with the authoritative order.
 * Events after `search.results` or `search.error` change only the bookkeeping, never the hit list. Unknown events
 * are ignored.
 */
export function mergeSearchStream(view: SearchStreamView, event: SearchStreamEvent): SearchStreamView {
  const base = event.searchId === undefined ? view : { ...view, searchId: event.searchId, elapsedMs: Math.max(view.elapsedMs, event.elapsedMs) };
  switch (event.type) {
    case "search.started":
      return { ...base, status: "searching", cached: event.cached === true };
    case "search.phase":
      return { ...base, phases: { ...base.phases, [event.phase]: event.stats } };
    case "search.hits": {
      const legs = {
        ...base.legs,
        [event.leg]: { ...(base.legs[event.leg] ?? {}), ...(event.stats ?? {}), hits: Math.max(base.legs[event.leg]?.hits ?? 0, event.hits.length), truncated: event.truncated === true },
      } as SearchStreamView["legs"];
      if (base.final || base.status === "error") return { ...base, legs };
      const byId = new Map(base.hits.map(hit => [hit.id, hit]));
      for (const hit of event.hits) {
        const known = byId.get(hit.id);
        if (!known) {
          byId.set(hit.id, { id: hit.id, result: hit.result, legs: [event.leg], legRanks: { [event.leg]: hit.legRank } });
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
      return { ...base, status: "searching", legs, hits };
    }
    case "search.results": {
      const provisional = new Map(base.hits.map(hit => [hit.id, hit]));
      const results = event.response.results;
      const hits = results.map((result, index): MergedSearchHit => {
        const id = event.ids[index] ?? searchResultId(result.citation);
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
