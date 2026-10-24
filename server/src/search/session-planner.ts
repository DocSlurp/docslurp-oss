import type { PrivacyMode } from "@docslurp/shared";
import { resolveEmbeddingRoute, type EmbeddingConfig } from "@docslurp/shared";
import {
  embedConfiguredText,
  generateOpenRouterText,
  SEARCH_OPENROUTER_MODEL,
} from "../lib/ai.js";
import type { UsageRecorder } from "../lib/ai-usage.js";
import { startDependencySpan } from "@docslurp/shared/observability";
import { embeddingCache, embeddingCacheKey } from "./embedding-cache.js";
import { lanceDbVectorSearch } from "./lancedb.js";
import { hydeExpand } from "./hyde.js";
import { decomposeQuery, rewriteQuery } from "./query-rewrite.js";
import { deriveSelfQueryFilters } from "./self-query.js";
import { expandQuery } from "./synonym.js";
import { stepbackPrompt } from "./stepback.js";
import type {
  SearchChunk,
  SearchOptions,
  SearchResponse,
} from "../services/search.js";
import { getWorkspaceAccess } from "../services/organizations.js";
import {
  fuseSearchChunkLists,
  fuseSearchResponses,
  searchResultsToChunks,
} from "./session-execution.js";
import type { SearchSessionJournal } from "./session.js";
import { withWorkspaceScope } from "./workspace-retrieval-session.js";
import { countSearchEvent, timePhase } from "./timings.js";

export type RetrievalChainStep = {
  hop: number;
  query: string;
  extractedEntities: string[];
  nextQuery: string | null;
  resultCount: number;
  chunkIds: string[];
};

export interface RecursiveSearchModePlan {
  chunks: SearchChunk[];
  effectiveQuery: string;
  retrievalChain?: RetrievalChainStep[];
  /** Candidates the relevance floor rejected across all sub-searches. */
  relevanceFloorDropped: number;
}

/** Sub-searches run without a session log or whole-corpus fallback; their floor rejections must still reach the final response. */
function totalFloorDropped(responses: SearchResponse[]): number {
  return responses.reduce((sum, response) => sum + (response.relevanceFloor?.dropped ?? 0), 0);
}

export interface SearchSessionRetrievalPlan {
  effectiveQuery: string;
  effectiveOptions: SearchOptions;
  /** Resolves with the query embedding; already started, so non-vector legs can run while it is in flight. */
  queryVector: Promise<number[] | null>;
  textQuery: string;
  selfQueryReasons: string[];
}

type SearchSessionRunAdapter = (
  query: string,
  userId: string,
  options: SearchOptions,
) => Promise<SearchResponse>;

export async function planRecursiveSearchMode(args: {
  query: string;
  userId: string;
  options: SearchOptions;
  session: SearchSessionJournal;
  openRouterApiKey?: string;
  privacyMode: PrivacyMode;
  runSearch: SearchSessionRunAdapter;
}): Promise<RecursiveSearchModePlan | null> {
  const { query, userId, options, session, openRouterApiKey, privacyMode, runSearch } = args;

  // Search Session Planner is the Module seam for query-mode orchestration.
  // The Adapter keeps recursive calls local while hybridSearch keeps leverage.
  if (options.queryDecompose) {
    const subQueries = decomposeQuery(query);
    if (subQueries.length > 1) {
      const subResults = await Promise.all(
        subQueries.map((sq) =>
          runSearch(sq, userId, {
            ...options,
            queryDecompose: false,
            suppressSessionLog: true,
            rootSessionId: session.sessionId,
          }),
        ),
      );
      session.adoptUsage(
        subResults.flatMap((result) => result.usageEvents ?? []),
      );
      return {
        chunks: fuseSearchResponses(subResults, options.limit ?? 20),
        effectiveQuery: query,
        relevanceFloorDropped: totalFloorDropped(subResults),
      };
    }
  }

  if (options.stepback && openRouterApiKey) {
    const { query: generalizedQuery } = await stepbackPrompt(
      query,
      openRouterApiKey,
      session,
      privacyMode,
    );

    if (generalizedQuery !== query) {
      const [originalResult, stepbackResult] = await Promise.all([
        runSearch(query, userId, {
          ...options,
          stepback: false,
          suppressSessionLog: true,
          rootSessionId: session.sessionId,
        }),
        runSearch(generalizedQuery, userId, {
          ...options,
          stepback: false,
          suppressSessionLog: true,
          rootSessionId: session.sessionId,
        }),
      ]);
      session.adoptUsage([
        ...(originalResult.usageEvents ?? []),
        ...(stepbackResult.usageEvents ?? []),
      ]);
      return {
        chunks: fuseSearchResponses(
          [originalResult, stepbackResult],
          options.limit ?? 20,
        ),
        effectiveQuery: generalizedQuery,
        relevanceFloorDropped: totalFloorDropped([originalResult, stepbackResult]),
      };
    }
  }

  if (options.iterativeMultiHop) {
    return planIterativeMultiHop({
      query,
      userId,
      options,
      session,
      openRouterApiKey,
      privacyMode,
      runSearch,
    });
  }

  return null;
}

export async function prepareSearchSessionRetrievalPlan(args: {
  query: string;
  userId: string;
  options: SearchOptions;
  effectiveOptions: SearchOptions;
  workspaceId: string;
  /** Owning organization of the workspace; scopes the query-embedding cache. */
  orgId: string;
  workspaceSettings: { synonyms?: Record<string, string[]> };
  embedding: EmbeddingConfig;
  openRouterApiKey?: string;
  privacyMode: PrivacyMode;
  session: SearchSessionJournal;
}): Promise<SearchSessionRetrievalPlan> {
  const {
    query,
    userId,
    options,
    workspaceId,
    orgId,
    workspaceSettings,
    embedding,
    openRouterApiKey,
    privacyMode,
    session,
  } = args;
  let effectiveQuery = query;
  let effectiveOptions = args.effectiveOptions;
  let selfQueryReasons: string[] = [];

  if (options.selfQuery) {
    const derived = await deriveSelfQueryFilters({
      query,
      baseFilters: options.filters,
      openRouterApiKey,
      privacyMode,
      usage: session,
    });
    effectiveOptions = {
      ...options,
      filters: withWorkspaceScope(derived.filters, workspaceId),
    };
    selfQueryReasons = derived.reasons;
  }

  if (options.queryRewrite && openRouterApiKey) {
    const { query: rewritten } = await rewriteQuery(
      query,
      openRouterApiKey,
      session,
      privacyMode,
    );
    effectiveQuery = rewritten;
  }

  if (options.useHyDE && openRouterApiKey) {
    const { expandedQuery } = await hydeExpand(
      effectiveQuery,
      openRouterApiKey,
      session,
      privacyMode,
    );
    effectiveQuery = expandedQuery || effectiveQuery;
  }

  // Started now, awaited only by the vector leg: lexical and page legs overlap the (remote) embedding call.
  const queryVector: Promise<number[] | null> = options.queryVector
    ? Promise.resolve(options.queryVector)
    : timePhase("embed", () => embedQuery(effectiveQuery, embedding, session, privacyMode, workspaceId, orgId));
  queryVector.catch(() => undefined);

  // An explicit document selection already defines the retrieval scope. Summary
  // seeds must never replace it with unrelated documents.
  const hasDocumentSelection = Boolean(
    effectiveOptions.filters?.documentId || effectiveOptions.filters?.documentIds?.length,
  );
  const seedVector = effectiveOptions.summarySeed && !hasDocumentSelection ? await queryVector : null;
  if (seedVector) {
    const access = await getWorkspaceAccess(workspaceId, userId);
    if (access) {
      // Seeds come from this workspace's own database only.
      const seedHits = await lanceDbVectorSearch({
        orgId: access.orgId,
        workspaceId,
        embeddingModel: resolveEmbeddingRoute(embedding).model,
        queryVector: seedVector,
        limit: 50,
        privacyMode,
      });
      if (seedHits.length > 0) {
        const docScores = new Map<string, number>();
        for (const hit of seedHits) {
          docScores.set(
            hit.documentId,
            (docScores.get(hit.documentId) ?? 0) + hit.score,
          );
        }
        const topDocIds = [...docScores.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([id]) => id);
        if (topDocIds.length > 0) {
          effectiveOptions = {
            ...effectiveOptions,
            filters: {
              ...effectiveOptions.filters,
              documentIds: topDocIds,
            },
          };
        }
      }
    }
  }

  const mergedGlossary = {
    ...(workspaceSettings.synonyms ?? {}),
    ...(options.glossary ?? {}),
  };
  const textQuery =
    Object.keys(mergedGlossary).length > 0
      ? expandQuery(query, mergedGlossary)
      : query;

  return {
    effectiveQuery,
    effectiveOptions,
    queryVector,
    textQuery,
    selfQueryReasons,
  };
}

async function planIterativeMultiHop(args: {
  query: string;
  userId: string;
  options: SearchOptions;
  session: SearchSessionJournal;
  openRouterApiKey?: string;
  privacyMode: PrivacyMode;
  runSearch: SearchSessionRunAdapter;
}): Promise<RecursiveSearchModePlan> {
  const { query, userId, options, session, openRouterApiKey, privacyMode, runSearch } = args;
  const hopLists: SearchChunk[][] = [];
  let relevanceFloorDropped = 0;
  const retrievalChain: RetrievalChainStep[] = [];
  const seenQueries = new Set<string>();
  let hopQuery = query;

  for (let hop = 0; hop < 3; hop += 1) {
    const normalizedHopQuery = hopQuery.trim().toLowerCase();
    if (!normalizedHopQuery || seenQueries.has(normalizedHopQuery)) {
      break;
    }
    seenQueries.add(normalizedHopQuery);

    const hopResult = await runSearch(hopQuery, userId, {
      ...options,
      iterativeMultiHop: false,
      suppressSessionLog: true,
      rootSessionId: session.sessionId,
    });
    session.adoptUsage(hopResult.usageEvents ?? []);
    relevanceFloorDropped += hopResult.relevanceFloor?.dropped ?? 0;

    const hopChunks = searchResultsToChunks(hopResult.results);
    hopLists.push(hopChunks);

    const chainStep: RetrievalChainStep = {
      hop: hop + 1,
      query: hopQuery,
      extractedEntities: [],
      nextQuery: null,
      resultCount: hopChunks.length,
      chunkIds: uniqueStrings(hopChunks.map((chunk) => chunkIdentity(chunk))),
    };
    retrievalChain.push(chainStep);

    if (hop >= 2 || hopChunks.length === 0) {
      break;
    }

    const bridgingEntities = await extractBridgingEntities({
      baseQuery: query,
      currentQuery: hopQuery,
      chunks: hopChunks,
      apiKey: openRouterApiKey,
      privacyMode,
      usage: session,
    });
    chainStep.extractedEntities = bridgingEntities;

    const nextQuery = buildRetrievalChainQuery(query, bridgingEntities);
    chainStep.nextQuery = nextQuery;
    if (!nextQuery) {
      break;
    }
    hopQuery = nextQuery;
  }

  const fusedChunks = fuseSearchChunkLists(hopLists, options.limit ?? 20);
  const dedupedFinalChunks: SearchChunk[] = [];
  const seenChunkIds = new Set<string>();
  for (const chunk of fusedChunks) {
    const identity = chunkIdentity(chunk);
    if (seenChunkIds.has(identity)) {
      continue;
    }
    seenChunkIds.add(identity);
    dedupedFinalChunks.push(chunk);
  }

  const finalChunks = dedupedFinalChunks.map((chunk, index) => ({
    ...chunk,
    score: 1 / (1 + index),
  }));
  const finalChainStep =
    retrievalChain.length > 0
      ? retrievalChain[retrievalChain.length - 1]
      : null;

  return {
    chunks: finalChunks,
    effectiveQuery: finalChainStep?.nextQuery ?? finalChainStep?.query ?? query,
    retrievalChain,
    relevanceFloorDropped,
  };
}

/** Why a query embedding must skip the cache, or null when it may use it. */
export function embeddingCacheBypassReason(privacyMode: PrivacyMode, orgId: string | undefined): "strict-privacy" | "no-org" | null {
  if (privacyMode === "strict-privacy") return "strict-privacy";
  if (!orgId) return "no-org";
  return null;
}

/** Hosted providers that report actual usage and fail loudly instead of degrading to text-only search. */
export const METERED_EMBEDDING_PROVIDERS = new Set(["openrouter", "perplexity", "deepinfra"]);

/** The embedding-cache key embedQuery uses for this query, or null when it would bypass the cache. */
export function queryEmbeddingCacheKey(query: string, embedding: EmbeddingConfig, privacyMode: PrivacyMode, orgId: string | undefined): string | null {
  const route = resolveEmbeddingRoute(embedding);
  const normalize = route.provider === "deepinfra" ? embedding.normalize : true;
  if (!embeddingCache().enabled || embeddingCacheBypassReason(privacyMode, orgId) || !orgId) return null;
  return embeddingCacheKey({ orgId, provider: route.provider, runtime: route.runtime, model: route.model, modelUri: route.modelUri,
    baseUrl: route.baseUrl, dimensions: route.dimensions, requestedDimensions: route.requestedDimensions, normalize: Boolean(normalize) }, query);
}

/** Provider API key for a query-embedding route (undefined for local and keyless routes). */
export function queryEmbeddingApiKey(route: { runtime: string; provider: string }): string | undefined {
  return route.runtime === "remote" && route.provider === "openai"
    ? process.env.OPENAI_API_KEY
    : route.provider === "openrouter" ? process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY
      : route.provider === "perplexity" ? process.env.PERPLEXITY_API_KEY ?? process.env.PERPLEXITYAI_API_KEY
        : route.provider === "deepinfra" ? process.env.DEEPINFRA_API_KEY : undefined;
}

export async function embedQuery(
  query: string,
  embedding: EmbeddingConfig,
  usage: SearchSessionJournal,
  privacyMode: PrivacyMode,
  /** Strict-privacy audit attribution for private embedding routes. */
  auditWorkspaceId?: string | null,
  orgId?: string,
): Promise<number[] | null> {
  const route = resolveEmbeddingRoute(embedding);
  const { model, provider, runtime, dimensions, requestedDimensions, baseUrl } = route;
  const isPrivate = provider === "private";
  const normalize = provider === "deepinfra" ? embedding.normalize : true;

  // Cache hits make no provider call, so they record no usage event: usage_events and
  // [ai-usage] keep meaning "provider calls actually made", and billing/budgets stay
  // exact. Hits are counted in search timings, the search session diagnostics and a span.
  // strict-privacy always calls through: it audits every private embedding call, and a
  // hit would skip that audit row. Without an org there is no safe cache scope.
  const cache = embeddingCache();
  const bypassReason = embeddingCacheBypassReason(privacyMode, orgId);
  const cacheKey = queryEmbeddingCacheKey(query, embedding, privacyMode, orgId);
  if (cache.enabled) {
    const cached = cacheKey ? cache.get(cacheKey) : undefined;
    startDependencySpan("embed.cache", {
      "docslurp.dependency.type": "cache", "docslurp.dependency.provider": "memory",
      "docslurp.dependency.operation": "embedding_cache", "docslurp.dependency.phase": "adapter",
      "docslurp.cache.hit": cached !== undefined, "docslurp.cache.bypassed": bypassReason !== null,
      ...(bypassReason ? { "docslurp.cache.bypass_reason": bypassReason } : {}),
      "docslurp.privacy.mode": privacyMode, "gen_ai.request.model": model,
    }).end();
    if (bypassReason) {
      countSearchEvent("embedCacheBypass");
      usage.recordDiagnostic("embeddingCache", { hit: false, bypassed: true, bypassReason, privacyMode });
    } else {
      countSearchEvent(cached ? "embedCacheHit" : "embedCacheMiss");
      usage.recordDiagnostic("embeddingCache", { hit: cached !== undefined, hits: cache.hits, misses: cache.misses, entries: cache.size, privacyMode });
    }
    if (cached) {
      console.info(`[search-cache] embedding hit model=${model} privacy=${privacyMode} entries=${cache.size}`);
      return cached.slice();
    }
  }
  const apiKey = queryEmbeddingApiKey(route);
  if (runtime === "remote" && provider === "openai" && !apiKey) {
    return null;
  }

  let usageRecorded = false;
  try {
    const result = await embedConfiguredText({
      value: query,
      runtime,
      provider,
      model,
      dimensions,
      requestedDimensions,
      normalize,
      apiKey,
      baseURL: baseUrl ?? process.env.OPENAI_BASE_URL,
      privacyMode,
      modelUri: route.modelUri,
      auditScope: { workspaceId: auditWorkspaceId ?? null },
      ...(METERED_EMBEDDING_PROVIDERS.has(provider) ? { onUsage: (actual: { inputTokens: number }) => {
        usage.record({ provider, model, metric: "embed-query", inputTokens: actual.inputTokens, logOutputTokens: false, metadata: { usageSource: "provider" } });
        usageRecorded = true;
      } } : {}),
    });

    if (!usageRecorded) usage.record({
      provider,
      model,
      metric: "embed-query",
      costCents: runtime === "local" ? 0 : isPrivate ? result.usage.costCents ?? 0 : undefined,
      metadata: isPrivate
        ? { ...result.usage.metadata, usageSource: "provider" }
        : { costSource: runtime === "local" ? "local-no-api-charge" : "estimate", usageSource: runtime === "local" ? "estimated" : "provider" },
      inputTokens: result.usage.inputTokens,
      logOutputTokens: false,
    });
    if (cacheKey) cache.set(cacheKey, result.embedding.slice());
    return result.embedding;
  } catch (error) {
    if (METERED_EMBEDDING_PROVIDERS.has(provider)) throw error;
    return null;
  }
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

function chunkIdentity(
  chunk: Pick<SearchChunk, "id" | "documentId" | "chunkIndex" | "retrievalStage">,
): string {
  if (chunk.id) {
    return chunk.id;
  }
  return `${chunk.documentId}:${chunk.chunkIndex}:${chunk.retrievalStage}`;
}

function buildRetrievalChainQuery(
  baseQuery: string,
  entities: string[],
): string | null {
  const normalizedEntities = uniqueStrings(entities).slice(0, 6);
  if (normalizedEntities.length === 0) {
    return null;
  }

  return `${baseQuery}\nBridge via: ${normalizedEntities.join(", ")}`;
}

function parseBridgingEntityResponse(text: string): string[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { entities?: unknown };
    if (!Array.isArray(parsed.entities)) {
      return [];
    }
    return uniqueStrings(
      parsed.entities
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.replace(/\s+/g, " ").trim()),
    ).slice(0, 6);
  } catch {
    return [];
  }
}

async function extractBridgingEntities(args: {
  baseQuery: string;
  currentQuery: string;
  chunks: SearchChunk[];
  apiKey: string | undefined;
  privacyMode: PrivacyMode;
  usage: UsageRecorder;
  signal?: AbortSignal;
}): Promise<string[]> {
  const evidence = args.chunks
    .slice(0, 6)
    .map((chunk, index) =>
      [
        `Chunk ${index + 1}`,
        `Filename: ${chunk.filename || "unknown"}`,
        `Chunk ID: ${chunkIdentity(chunk)}`,
        `Pages: ${chunk.pageNumbers.join(", ") || (chunk.pageNumber ? String(chunk.pageNumber) : "n/a")}`,
        chunk.text.slice(0, 1_200),
      ].join("\n"),
    )
    .join("\n\n---\n\n");

  if (!evidence) {
    return [];
  }

  if (!args.apiKey) {
    return uniqueStrings(
      args.chunks.flatMap((chunk) => chunk.headingPath).slice(0, 4),
    );
  }

  const prompt = [
    "You are extracting bridge entities for a multi-hop retrieval system.",
    `Original user query: ${args.baseQuery}`,
    `Current retrieval query: ${args.currentQuery}`,
    "Read the evidence chunks and identify up to 6 specific bridge entities, products, organizations, people, documents, patents, or concepts that should be used to search for the next hop.",
    "Only return entities that are explicitly supported by the evidence and likely to connect to a different document or chunk than the current evidence.",
    'Return strict JSON: {"entities":["..."]}',
    "",
    "Evidence:",
    evidence,
  ].join("\n");

  try {
    const result = await generateOpenRouterText({
      operation: "api.search.bridging-entities",
      apiKey: args.apiKey,
      privacyMode: args.privacyMode,
      prompt,
      model: SEARCH_OPENROUTER_MODEL,
      maxOutputTokens: 220,
      signal: args.signal,
    });
    args.usage.record({
      provider: "openrouter",
      model: SEARCH_OPENROUTER_MODEL,
      metric: "iterative-bridge-extract",
      ...result.usage,
    });
    return parseBridgingEntityResponse(result.text);
  } catch {
    return [];
  }
}
