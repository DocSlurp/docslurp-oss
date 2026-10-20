import { reportPublicError } from "../lib/public-errors.js";
import { withObservation } from "@docslurp/shared/observability";
import { resolveEmbeddingRoute, type SearchResult } from "@docslurp/shared";

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
      const options = args.options;
      let selfQueryReasons: string[] = [];
      let effectiveOptions: SearchOptions = {
        ...options,
        filters: {
          ...options.filters,
          workspaceId: normalizedScope.workspaceId,
        },
      };

      const recursivePlan = await timePhase("plan", () => planRecursiveSearchMode({
        query,
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
        query,
        userId,
        options,
        effectiveOptions,
        workspaceId: normalizedScope.workspaceId,
        workspaceSettings,
        embedding: setup.workspacePipeline.embedding,
        openRouterApiKey,
        privacyMode,
        session,
      }));
      effectiveOptions = retrievalPlan.effectiveOptions;
      selfQueryReasons = retrievalPlan.selfQueryReasons;
      const effectiveQuery = retrievalPlan.effectiveQuery;
      const queryVector = retrievalPlan.queryVector;
      const textQuery = await timePhase("graphQuery", () => expandGraphTextQuery({
        enabled: effectiveOptions.enableGraphExpansion,
        query,
        textQuery: retrievalPlan.textQuery,
        tags: effectiveOptions.filters?.tags,
        workspaceId: normalizedScope.workspaceId,
      }));

      return executeSearchSessionRetrieval({
        query,
        userId,
        session,
        options: effectiveOptions,
        workspaceId: normalizedScope.workspaceId,
        limit: options.limit ?? 20,
        retrieveCandidateLists: async () => {
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
              query,
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
          return annotateEvidenceRelevance(boundedResults, {
            query,
            embeddingPipeline: embeddingPipelineOf(setup),
          });
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
    },
  );
}
