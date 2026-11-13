import { resolveEmbeddingRoute } from "@docslurp/shared";

import { embedConfiguredTexts } from "../lib/ai.js";
import { recordUsageEvent } from "../lib/ai-usage.js";
import type { SearchOptions } from "../services/search.js";
import { embeddingCache } from "./embedding-cache.js";
import { searchLanceDbNativeEnabled } from "./eligible-documents.js";
import { METERED_EMBEDDING_PROVIDERS, queryEmbeddingApiKey, queryEmbeddingCacheKey } from "./session-planner.js";
import { loadSearchProjectContext } from "./session-setup.js";
import { resolveProjectRetrievalControls } from "./project-retrieval-session.js";
import { effectiveSearchMode } from "./search-mode.js";
import { currentRequestSearchLimits } from "../lib/request-context.js";

/** Options that make a search embed something other than its query text. */
function embedsQueryText(options: SearchOptions): boolean {
  return !options.queryVector && !options.useHyDE && !options.queryRewrite && !options.queryDecompose
    && !options.stepback && !options.selfQuery && !options.iterativeMultiHop && !options.adaptiveRetrieval;
}

/**
 * Batch search: embed the queries of one batch with one provider request per
 * project and seed the query-embedding cache, so each search of the batch
 * finds its vector there instead of making its own call. Only queries whose
 * search would embed the raw query text are prefetched (after project
 * retrieval defaults, so a project that turns HyDE on is not charged for
 * vectors it would not use), only when the cache may hold them (not
 * strict-privacy), and only for routes with a batch path. The batch call's
 * actual usage is recorded once, scoped to the org and project. Any failure
 * leaves the searches to embed one by one, as before. Only projects on
 * native search (the default; SEARCH_LANCEDB_NATIVE=0 turns it off outside
 * SEARCH_LANCEDB_NATIVE_PROJECTS).
 */
export async function prefetchBatchQueryEmbeddings(
  items: Array<{ query: string; projectId: string; options: SearchOptions }>,
  userId: string,
  signal?: AbortSignal,
): Promise<{ prefetched: number; calls: number }> {
  const byProject = new Map<string, typeof items>();
  // Keyword searches never embed, so their queries are not prefetched. Nor are searches in a mode the key
  // limits: each of those embeds only after its limit admits it, so a key past its limit spends nothing.
  const limited = new Set((currentRequestSearchLimits()?.rules ?? []).map((rule) => rule.mode));
  for (const item of items.filter(item => {
    const mode = effectiveSearchMode(item.options);
    return !item.options.filters?.geo && mode !== "keyword" && !limited.has(mode);
  })) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item]);
  let prefetched = 0;
  let calls = 0;
  await Promise.all([...byProject].map(async ([projectId, group]) => {
    // With native search off for the project, each search embeds its own query.
    if (group.length < 2 || !searchLanceDbNativeEnabled(projectId)) return;
    try {
      const context = await loadSearchProjectContext(projectId, userId);
      const { pipeline } = context.indexing;
      const privacyMode = pipeline.privacyMode;
      const orgId = context.scope.orgId;
      const cache = embeddingCache();
      const texts = new Map<string, string>();
      for (const item of group) {
        const resolved = resolveProjectRetrievalControls({ options: item.options, projectId, settings: context.settings, pipeline }).options;
        if (!embedsQueryText(resolved)) continue;
        const key = queryEmbeddingCacheKey(item.query, pipeline.embedding, privacyMode, orgId);
        if (!key || cache.get(key) || texts.has(key)) continue;
        texts.set(key, item.query);
      }
      if (texts.size < 2) return;
      const route = resolveEmbeddingRoute(pipeline.embedding);
      const apiKey = queryEmbeddingApiKey(route);
      // Unconfigured hosted routes: each search reports it (or degrades) on its own.
      if (!apiKey && route.runtime === "remote" && ["openai", "openrouter", "deepinfra", "perplexity"].includes(route.provider)) return;
      const values = [...texts.values()];
      const result = await embedConfiguredTexts({
        values, runtime: route.runtime, provider: route.provider, model: route.model, dimensions: route.dimensions,
        requestedDimensions: route.requestedDimensions, normalize: route.provider === "deepinfra" ? pipeline.embedding.normalize : true,
        apiKey, baseURL: route.baseUrl ?? process.env.OPENAI_BASE_URL, privacyMode, modelUri: route.modelUri,
        auditScope: { projectId }, signal,
      });
      if (!result || result.embeddings.length !== values.length) return;
      calls += 1;
      await recordUsageEvent({
        userId,
        scope: { orgId, projectId },
        usage: {
          provider: route.provider, model: route.model, metric: "embed-query", inputTokens: result.usage.inputTokens, logOutputTokens: false,
          // The provider's reported charge when it sent one (OpenRouter); otherwise priced from tokens.
          costCents: result.usage.costCents,
          // Every hosted batch path reports actual tokens (OpenAI included); only a zero count is not.
          metadata: { ...result.usage.metadata, usageSource: METERED_EMBEDDING_PROVIDERS.has(route.provider) || (route.runtime === "remote" && result.usage.inputTokens > 0) ? "provider" : "estimate", batchSize: values.length, batch: true },
        },
      });
      [...texts.keys()].forEach((key, index) => cache.set(key, result.embeddings[index]!.slice()));
      prefetched += values.length;
    } catch (error) {
      // Non-fatal: the searches embed one by one and surface provider errors themselves.
      console.warn(`[search] batch query embedding skipped project=${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  return { prefetched, calls };
}
