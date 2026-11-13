import { z } from "zod";
import { searchResultSchema, type SearchResult } from "./search.js";

/**
 * Streaming search contract (`GET`/`POST /v1/search/stream`, Server-Sent Events).
 *
 * A search runs several retrieval legs side by side. The stream reports each
 * leg the moment it lands, in whatever order they finish, then one
 * authoritative ranked list. Every event carries the same envelope so a client
 * can order, deduplicate and attribute what it receives:
 *
 * - `searchId`: one per request; identical on every event of the stream.
 * - `seq`: 0-based, strictly increasing per stream. Also sent as the SSE `id:`.
 * - `elapsedMs`: milliseconds since the server accepted the request.
 *
 * Order of events: `search.started` first; then any number of `search.phase`
 * and `search.hits` in completion order (not rank order); then
 * `search.results` (the same body `POST /v1/search` returns) and
 * `search.done`. A failure after the stream opened is one `search.error`
 * followed by nothing. Hits are provisional: only `search.results` is the
 * answer, and it may drop, add or reorder hits. `POST /v1/search` remains the
 * non-streaming fallback and returns the same final body.
 */
export const SEARCH_STREAM_PROTOCOL = 1;

/** The retrieval leg a provisional hit came from. */
export const searchStreamLegSchema = z.enum([
  "lexical",
  "vector",
  "graph",
  "community",
  "progressive-page",
  "completed-page",
  "deferred",
]);
export type SearchStreamLeg = z.infer<typeof searchStreamLegSchema>;

/** Work that is not a retrieval leg but takes measurable time. */
export const searchStreamPhaseSchema = z.enum([
  "queue",
  "setup",
  "plan",
  "prepare",
  "embed",
  "retrieve",
  "fuse",
  "rerank",
  "finalize",
]);
export type SearchStreamPhase = z.infer<typeof searchStreamPhaseSchema>;

const envelope = {
  searchId: z.string(),
  seq: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
};

/** Stable identity of a result across legs and the final list. */
export function searchResultId(citation: Pick<SearchResult["citation"], "documentId" | "chunkIndex" | "source">): string {
  return `${citation.source ?? "document"}:${citation.documentId}:${citation.chunkIndex}`;
}

export const searchStreamHitSchema = z.object({
  /** `searchResultId(result.citation)`; the same id appears in `search.results.ids`. */
  id: z.string(),
  /** 0-based rank within this leg only. */
  legRank: z.number().int().nonnegative(),
  result: searchResultSchema,
});
export type SearchStreamHit = z.infer<typeof searchStreamHitSchema>;

/** Optional per-leg or per-phase numbers, sent when the request sets `stats`. */
export const searchStreamStatsSchema = z.object({
  /** Wall time of this leg or phase. */
  ms: z.number().nonnegative(),
  /** Candidates the leg retrieved before any provisional filtering. */
  candidates: z.number().int().nonnegative().optional(),
  cacheHit: z.boolean().optional(),
  timedOut: z.boolean().optional(),
});
export type SearchStreamStats = z.infer<typeof searchStreamStatsSchema>;

export const searchStreamStartedEventSchema = z.object({
  ...envelope,
  type: z.literal("search.started"),
  protocol: z.literal(SEARCH_STREAM_PROTOCOL),
  projectId: z.string(),
  /** True when a recent identical answer was reused: `search.results` follows at once, with no hits. */
  cached: z.boolean().default(false),
});

export const searchStreamPhaseEventSchema = z.object({
  ...envelope,
  type: z.literal("search.phase"),
  phase: searchStreamPhaseSchema,
  /** Present for a sub-search of decomposition, stepback or multi-hop: 0-based index of that sub-search. */
  subSearch: z.number().int().nonnegative().optional(),
  stats: searchStreamStatsSchema,
});

export const searchStreamHitsEventSchema = z.object({
  ...envelope,
  type: z.literal("search.hits"),
  leg: searchStreamLegSchema,
  /** Present for a sub-search of decomposition, stepback or multi-hop: 0-based index of that sub-search. */
  subSearch: z.number().int().nonnegative().optional(),
  /** Hits this leg found, best first. Empty when the leg found nothing. */
  hits: z.array(searchStreamHitSchema),
  /** More hits than were sent (`hits` is capped at the request's `limit`). */
  truncated: z.boolean().default(false),
  stats: searchStreamStatsSchema.optional(),
});

export const searchStreamResultsEventSchema = z.object({
  ...envelope,
  type: z.literal("search.results"),
  /** `searchResultId` of each entry of `response.results`, in final rank order. */
  ids: z.array(z.string()),
  /** The body `POST /v1/search` returns for the same request. */
  response: z.object({ results: z.array(searchResultSchema), sessionId: z.string() }).passthrough(),
});

export const searchStreamErrorEventSchema = z.object({
  ...envelope,
  type: z.literal("search.error"),
  error: z.object({ code: z.string(), message: z.string(), status: z.number().int() }),
});

export const searchStreamDoneEventSchema = z.object({
  ...envelope,
  type: z.literal("search.done"),
  sessionId: z.string(),
  resultCount: z.number().int().nonnegative(),
  /** Phase timings of the whole search, when the request sets `stats`. */
  timings: z.record(z.string(), z.number()).optional(),
});

export const searchStreamEventSchema = z.discriminatedUnion("type", [
  searchStreamStartedEventSchema,
  searchStreamPhaseEventSchema,
  searchStreamHitsEventSchema,
  searchStreamResultsEventSchema,
  searchStreamErrorEventSchema,
  searchStreamDoneEventSchema,
]);
export type SearchStreamEvent = z.infer<typeof searchStreamEventSchema>;
export type SearchStreamEventType = SearchStreamEvent["type"];
export type SearchStreamStartedEvent = z.infer<typeof searchStreamStartedEventSchema>;
export type SearchStreamPhaseEvent = z.infer<typeof searchStreamPhaseEventSchema>;
export type SearchStreamHitsEvent = z.infer<typeof searchStreamHitsEventSchema>;
export type SearchStreamResultsEvent = z.infer<typeof searchStreamResultsEventSchema>;
export type SearchStreamErrorEvent = z.infer<typeof searchStreamErrorEventSchema>;
export type SearchStreamDoneEvent = z.infer<typeof searchStreamDoneEventSchema>;

/** An event before the stream stamps its envelope (`searchId`, `seq`, `elapsedMs`). */
export type SearchStreamEventBody =
  | Omit<SearchStreamPhaseEvent, keyof typeof envelope>
  | Omit<SearchStreamHitsEvent, keyof typeof envelope>;
