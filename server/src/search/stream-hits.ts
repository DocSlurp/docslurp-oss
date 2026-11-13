import {
  searchResultId,
  type SearchStreamHit,
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
export interface ProvisionalSelection {
  /** Hits in leg order. `result` is absent for an id already sent on this stream. */
  hits: SearchStreamHit[];
  /** More candidates remained that would have passed, or hits were withheld by the stream-wide body cap. */
  truncated: boolean;
}

export interface ProvisionalHitPolicy {
  /**
   * Walk the leg's candidate window in order and keep the first `limit` hits
   * that pass the floor. Only kept hits whose id is not in `sent` (and while
   * `newBodies` last) are converted to public results; nothing else is built.
   */
  select(
    leg: SearchStreamLeg,
    chunks: SearchChunk[],
    budget: { limit: number; sent: ReadonlySet<string>; newBodies: number },
  ): ProvisionalSelection;
}

/** The id `searchResultId` gives the result `searchChunkToResult(chunk)` builds, without building it. */
export function searchChunkId(chunk: SearchChunk): string {
  const stage = chunk.deferredLocator ?? (chunk.retrievalStage === "page-index" ? "page-text" : "chunk");
  return searchResultId({
    citation: { source: chunk.source, documentId: chunk.documentId, chunkIndex: chunk.chunkIndex },
    retrieval: { stage },
  });
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
    select(leg, chunks, budget) {
      const windowSize = args.candidateDepth === undefined ? chunks.length : Math.min(chunks.length, args.candidateDepth);
      const hits: SearchStreamHit[] = [];
      const seen = new Set<string>();
      let newBodies = budget.newBodies;
      let truncated = false;
      for (let index = 0; index < windowSize; index++) {
        // Relevance is per chunk (no list-relative step), so annotating one at a
        // time gives the values the whole-list pass would. The deferred leg is not
        // annotated on the final path either; unmeasured chunks pass the floor.
        const annotated = leg === "deferred"
          ? chunks[index]!
          : annotateEvidenceRelevance([{ adapter: leg, chunks: [chunks[index]!] } as EvidenceRetrievalResult], {
              query: args.query,
              embeddingPipeline: args.embeddingPipeline,
            })[0]?.[0];
        if (!annotated || applyRelevanceFloor([annotated], args.minScore).kept.length === 0) continue;
        if (hits.length >= budget.limit) {
          truncated = true; // a further candidate passes the floor
          break;
        }
        const id = searchChunkId(annotated);
        const legRank = hits.length;
        if (budget.sent.has(id) || seen.has(id)) {
          hits.push({ id, legRank });
        } else if (newBodies > 0) {
          const result = qualifyCommunityResults([searchChunkToResult(annotated)], args.filters, args.runId)[0]!;
          hits.push({ id: searchResultId(result), legRank, result });
          newBodies--;
        } else {
          truncated = true; // stream-wide body cap reached: omit the hit
        }
        seen.add(id);
      }
      return { hits, truncated };
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
    const selection = args.policy
      ? args.policy.select(args.leg, args.chunks, {
          limit: sink.hitLimit,
          sent: sink.sentIds,
          // One stream sends at most three times `limit` distinct bodies.
          newBodies: Math.max(0, 3 * sink.hitLimit - sink.sentIds.size),
        })
      : { hits: [], truncated: false };
    for (const hit of selection.hits) if (hit.result) sink.sentIds.add(hit.id);
    const { hits } = selection;
    const timedOut = args.timedOut?.();
    return {
      type: "search.hits",
      leg: args.leg,
      hits,
      truncated: selection.truncated,
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
