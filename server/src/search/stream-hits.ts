import {
  searchResultId,
  type SearchResult,
  type SearchStreamLeg,
} from "@docslurp/shared";

import type { SearchChunk } from "../services/search.js";
import type { EvidenceRetrievalResult } from "./retrieval-adapters.js";
import { annotateEvidenceRelevance, applyRelevanceFloor } from "./relevance.js";
import type { SearchFilters } from "./filters.js";
import { qualifyCommunityResults, searchChunkToResult } from "./search-result.js";
import { currentSearchStreamSink, emitSearchStreamEvent } from "./stream-events.js";

/**
 * Provisional hits for `/v1/search/stream`.
 *
 * A leg's hits are streamed before fusion, so they may show more than the
 * final list in rank, never in content: every step that removes or rewrites
 * content between a leg and the response runs here with the same code the
 * final path uses (the per-leg candidate window, the relevance floor and the
 * community-summary scope qualification). Access, document eligibility and PII
 * blocking are applied inside each leg's query, so a leg result is already
 * scoped. Ranking-only steps (fusion, rerank, MMR, project search controls,
 * parent text) are skipped on purpose.
 */
export interface ProvisionalHitPolicy {
  /** The leg's chunks as the public results the final response would contain for them, best first. */
  select(leg: SearchStreamLeg, chunks: SearchChunk[]): SearchResult[];
}

export function createProvisionalHitPolicy(args: {
  query: string;
  embeddingPipeline: string | null;
  minScore: number;
  candidateDepth?: number;
  filters: SearchFilters | undefined;
  runId?: string;
}): ProvisionalHitPolicy {
  return {
    select(leg, chunks) {
      const window = args.candidateDepth === undefined ? chunks : chunks.slice(0, args.candidateDepth);
      // The deferred leg is not annotated on the final path either; unmeasured chunks pass the floor.
      const annotated = leg === "deferred"
        ? window
        : annotateEvidenceRelevance([{ adapter: leg, chunks: window } as EvidenceRetrievalResult], {
            query: args.query,
            embeddingPipeline: args.embeddingPipeline,
          })[0] ?? [];
      const { kept } = applyRelevanceFloor(annotated, args.minScore);
      return qualifyCommunityResults(kept.map((chunk) => searchChunkToResult(chunk)), args.filters, args.runId);
    },
  };
}

/** Statement-timeout counters the search records per leg (services/search.ts `countSearchEvent`). */
export const LEG_TIMEOUT_EVENTS: Partial<Record<SearchStreamLeg, string>> = {
  lexical: "lexicalTimeout",
  graph: "graphTimeout",
  community: "communityTimeout",
  "progressive-page": "progressiveTimeout",
  "completed-page": "completedPagesTimeout",
};

/**
 * Report a leg that finished. Without a sink nothing is built. Without a policy
 * the leg's content cannot be filtered, so only its (empty) hits and stats go out.
 */
export function emitLegHits(args: {
  leg: SearchStreamLeg;
  chunks: SearchChunk[];
  startedAt: number;
  policy: ProvisionalHitPolicy | undefined;
  timedOut?: () => boolean;
}): void {
  emitSearchStreamEvent((sink) => {
    const results = args.policy ? args.policy.select(args.leg, args.chunks) : [];
    const hits = results.slice(0, sink.hitLimit).map((result, legRank) => ({
      id: searchResultId(result.citation),
      legRank,
      result,
    }));
    const timedOut = args.timedOut?.();
    return {
      type: "search.hits",
      leg: args.leg,
      hits,
      truncated: results.length > hits.length,
      ...(sink.stats
        ? {
            stats: {
              ms: Math.round(performance.now() - args.startedAt),
              candidates: args.chunks.length,
              ...(timedOut === undefined ? {} : { timedOut }),
            },
          }
        : {}),
    };
  });
}

export function searchStreamActive(): boolean {
  return currentSearchStreamSink() !== undefined;
}
