import { parseSelfQuerySyntax } from "./self-query.js";
import { currentChatSessionId } from "../lib/chat-agent-context.js";
import { reportPublicError } from "../lib/public-errors.js";
import { withObservation } from "@docslurp/shared/observability";
import { resolveEmbeddingRoute, type DeferredSearchStats, type SearchResult } from "@docslurp/shared";

import {
  createEvidenceRetrievalAdapters,
  retrieveEvidence,
} from "./retrieval-adapters.js";
import { annotateEvidenceRelevance, embeddingPipelineId, resolveMinScore } from "./relevance.js";
import type { SearchSetup } from "./session-setup.js";
import {
  executeSearchSessionRetrieval,
  finalizeSearchSessionExecution,
} from "./session-execution.js";
import {
  planRecursiveSearchMode,
  prepareSearchSessionRetrievalPlan,
} from "./session-planner.js";
import { expandGraphTextQuery } from "./graph-expansion.js";
import type {
  SearchAvailability,
  SearchChunk,
  SearchOptions,
  SearchResponse,
} from "../services/search.js";
import { timePhase } from "./timings.js";
import { acquisitionDepth, validateRetrievalControls } from "./retrieval-controls.js";

export interface SearchSessionRunnerAdapters {
  buildAvailability(
    chunks: SearchChunk[],
    options: SearchOptions,
  ): SearchAvailability;
  completedPageSearch(args: {
    query: string;
    workspaceId: string;
    options: SearchOptions;
    shouldSearch: boolean;
  }): Promise<SearchChunk[]>;
  communitySummarySearch(args: {
    query: string;
    workspaceId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  graphNeighborSearch(args: {
    query: string;
    workspaceId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  progressivePageSearch(args: {
    query: string;
    userId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  runSearch(
    query: string,
    userId: string,
    options: SearchOptions,
  ): Promise<SearchResponse>;
  textSearch(args: {
    query: string;
    userId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  vectorSearch(args: {
    queryVector: number[];
    userId: string;
    workspaceId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  wholeCorpusFallback(filters?: SearchOptions["filters"]): Promise<SearchResult[]>;
  /**
   * Deferred (map/visual) documents: locate and materialize candidate pages,
   * then return chunks over them. Absent unless deferred profiles are enabled;
   * null when the scope has no deferred documents.
   */
  deferredPageSearch?(args: {
    query: string;
    textQuery: string;
    queryVector: number[] | null;
    userId: string;
    options: SearchOptions;
  }): Promise<{ chunks: SearchChunk[]; stats: DeferredSearchStats; documentIds: string[] } | null>;
}

function embeddingPipelineOf(setup: SearchSetup): string | null {
  try {
    const embedding = setup.workspacePipeline.embedding;
    const route = resolveEmbeddingRoute(embedding);
    return embeddingPipelineId({
      provider: route.provider,
      model: route.model,
      requestedDimensions: route.requestedDimensions,
      normalize: embedding.normalize,
    });
  } catch {
    return null;
  }
}

export async function runSearchSession(args: {
  query: string;
  userId: string;
  options: SearchOptions;
  setup: SearchSetup;
  adapters: SearchSessionRunnerAdapters;
}): Promise<SearchResponse> {
  validateRetrievalControls(args.options);
  try {
    const response = await executeSearchSession(args);
    // Child searches suppress result-session rows, but their paid usage must
    // survive even when a sibling later fails before the parent can adopt it.
    await args.setup.session.flushUsage(args.userId);
    return response;
  } catch (error) {
    try {
      await args.setup.session.flushUsage(args.userId);
    } catch (persistenceError) {
      reportPublicError(persistenceError, { operation: "search-failed-usage", sessionId: args.setup.session.sessionId });
    }
    throw error;
  }
}

async function executeSearchSession(args: Parameters<typeof runSearchSession>[0]): Promise<SearchResponse> {
  return withObservation(
    {
      name: "api.search",
      type: "retriever",
      input: args.query,
      metadata: {
        userId: args.userId,
        workspaceId: args.setup.normalizedScope.workspaceId,
        sessionId: args.setup.session.sessionId,
        ...(currentChatSessionId() ? { chatSessionId: currentChatSessionId() } : {}),
      },
      result: (result) => ({
        metadata: {
          sessionId: result.sessionId,
          resultCount: result.results.length,
        },
      }),
    },
    async () => {
      const { adapters, query, setup, userId } = args;
      const { session, normalizedScope, workspaceSettings, openRouterApiKey, privacyMode } =
        setup;
      const syntax = args.options.selfQuery ? parseSelfQuerySyntax(query) : { query, tags: [] };
      const retrievalQuery = syntax.query;
      const options: SearchOptions = syntax.tags.length ? {
        ...args.options,
        filters: { ...args.options.filters, tags: args.options.filters?.tags?.length ? args.options.filters.tags : syntax.tags },
      } : args.options;
      let selfQueryReasons: string[] = syntax.tags.length ? ["Applied explicit tag: labels."] : [];
      let effectiveOptions: SearchOptions = {
        ...options,
        filters: {
          ...options.filters,
          workspaceId: normalizedScope.workspaceId,
        },
      };

      const recursivePlan = await timePhase("plan", () => planRecursiveSearchMode({
        query: retrievalQuery,
        userId,
        options,
        session,
        openRouterApiKey,
        privacyMode,
        runSearch: adapters.runSearch,
      }));
      if (recursivePlan) {
        const availability = adapters.buildAvailability(
          recursivePlan.chunks,
          effectiveOptions,
        );
        return finalizeSearchSessionExecution({
          query,
          retrievalQuery,
          userId,
          session,
          options,
          workspaceId: normalizedScope.workspaceId,
          availability,
          chunks: recursivePlan.chunks,
          effectiveQuery: recursivePlan.effectiveQuery,
          filters: effectiveOptions.filters,
          selfQueryReasons,
          variant: options.variant,
          workspaceSettings,
          retrievalChain: recursivePlan.retrievalChain,
          wholeCorpusFallback: adapters.wholeCorpusFallback,
          relevanceFloor: {
            minScore: resolveMinScore(options.minScore),
            dropped: recursivePlan.relevanceFloorDropped,
          },
        });
      }

      const retrievalPlan = await timePhase("prepare", () => prepareSearchSessionRetrievalPlan({
        query: retrievalQuery,
        userId,
        options,
        effectiveOptions,
        workspaceId: normalizedScope.workspaceId,
        orgId: normalizedScope.orgId,
        workspaceSettings,
        embedding: setup.workspacePipeline.embedding,
        openRouterApiKey,
        privacyMode,
        session,
      }));
      effectiveOptions = retrievalPlan.effectiveOptions;
      selfQueryReasons = [...selfQueryReasons, ...retrievalPlan.selfQueryReasons];
      const effectiveQuery = retrievalPlan.effectiveQuery;
      const queryVector = retrievalPlan.queryVector;
      const textQuery = await timePhase("graphQuery", () => expandGraphTextQuery({
        enabled: effectiveOptions.enableGraphExpansion,
        query: retrievalQuery,
        textQuery: retrievalPlan.textQuery,
        filters: effectiveOptions.filters,
        runId: effectiveOptions.runId,
        workspaceId: normalizedScope.workspaceId,
      }));

      let deferred: { stats: DeferredSearchStats; documentIds: string[] } | null = null;
      const response = await executeSearchSessionRetrieval({
        query,
        retrievalQuery,
        userId,
        session,
        options: effectiveOptions,
        workspaceId: normalizedScope.workspaceId,
        limit: options.limit ?? 20,
        retrieveCandidateLists: async () => {
          // Runs alongside normal retrieval, not before it: the hot path adds no
          // latency, and a cold one overlaps materialization with retrieval.
          const deferredPromise = adapters.deferredPageSearch
            ? adapters.deferredPageSearch({
                query,
                textQuery,
                queryVector,
                userId,
                options: { ...effectiveOptions, limit: options.limit ?? 20 },
              }).catch(() => null)
            : Promise.resolve(null);
          const evidenceResults = await timePhase("retrieve", () => retrieveEvidence(
            createEvidenceRetrievalAdapters({
              vectorSearch: adapters.vectorSearch,
              textSearch: adapters.textSearch,
              graphNeighborSearch: adapters.graphNeighborSearch,
              communitySummarySearch: adapters.communitySummarySearch,
              progressivePageSearch: adapters.progressivePageSearch,
              completedPageSearch: adapters.completedPageSearch,
            }),
            {
              query: retrievalQuery,
              textQuery,
              queryVector,
              userId,
              workspaceId: normalizedScope.workspaceId,
              options: { ...effectiveOptions, limit: acquisitionDepth(effectiveOptions, options.limit ?? 20) },
            },
          ));
          const boundedResults = effectiveOptions.candidateDepth === undefined
            ? evidenceResults
            : evidenceResults.map((result) => ({ ...result, chunks: result.chunks.slice(0, effectiveOptions.candidateDepth) }));
          const lists = annotateEvidenceRelevance(boundedResults, {
            query: retrievalQuery,
            embeddingPipeline: embeddingPipelineOf(setup),
          });
          const deferredResult = await deferredPromise;
          deferred = deferredResult ? { stats: deferredResult.stats, documentIds: deferredResult.documentIds } : null;
          // Locator-ranked chunks go first so fusion keeps their stage label.
          return deferredResult && deferredResult.chunks.length > 0 ? [deferredResult.chunks, ...lists] : lists;
        },
        buildAvailability: (chunks) =>
          adapters.buildAvailability(chunks, effectiveOptions),
        effectiveQuery,
        filters: effectiveOptions.filters,
        selfQueryReasons,
        variant: options.variant,
        workspaceSettings,
        wholeCorpusFallback: adapters.wholeCorpusFallback,
        openRouterApiKey,
        rerankApiKey: setup.rerankApiKey,
        rerankScope: normalizedScope,
        privacyMode,
      });
      return deferred ? withDeferredStats(response, deferred as { stats: DeferredSearchStats; documentIds: string[] }) : response;
    },
  );
}

/** Attach deferred stats; only results from deferred-mode documents carry a temperature. */
function withDeferredStats(response: SearchResponse, deferred: { stats: DeferredSearchStats; documentIds: string[] }): SearchResponse {
  const inScope = new Set(deferred.documentIds);
  return {
    ...response,
    deferred: deferred.stats,
    results: response.results.map((result) =>
      inScope.has(result.citation.documentId)
        ? { ...result, retrieval: { stage: result.retrieval?.stage ?? "chunk", temperature: deferred.stats.temperature } }
        : result),
  };
}
