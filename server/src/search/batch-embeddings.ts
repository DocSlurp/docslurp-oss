import { resolveEmbeddingRoute } from "@docslurp/shared";

import { embedConfiguredTexts } from "../lib/ai.js";
import { recordUsageEvent } from "../lib/ai-usage.js";
import type { SearchOptions } from "../services/search.js";
import { embeddingCache } from "./embedding-cache.js";
import { METERED_EMBEDDING_PROVIDERS, queryEmbeddingApiKey, queryEmbeddingCacheKey } from "./session-planner.js";
import { loadSearchWorkspaceContext } from "./session-setup.js";
import { resolveWorkspaceRetrievalControls } from "./workspace-retrieval-session.js";

/** Options that make a search embed something other than its query text. */
function embedsQueryText(options: SearchOptions): boolean {
  return !options.queryVector && !options.useHyDE && !options.queryRewrite && !options.queryDecompose
    && !options.stepback && !options.selfQuery && !options.iterativeMultiHop && !options.adaptiveRetrieval;
}

/**
 * Batch search: embed the queries of one batch with one provider request per
 * workspace and seed the query-embedding cache, so each search of the batch
 * finds its vector there instead of making its own call. Only queries whose
 * search would embed the raw query text are prefetched (after workspace
 * retrieval defaults, so a workspace that turns HyDE on is not charged for
 * vectors it would not use), only when the cache may hold them (not
 * strict-privacy), and only for routes with a batch path. The batch call's
 * actual usage is recorded once, scoped to the org and workspace. Any failure
 * leaves the searches to embed one by one, as before.
 */
export async function prefetchBatchQueryEmbeddings(
  items: Array<{ query: string; workspaceId: string; options: SearchOptions }>,
  userId: string,
): Promise<{ prefetched: number; calls: number }> {
  const byWorkspace = new Map<string, typeof items>();
  for (const item of items) byWorkspace.set(item.workspaceId, [...(byWorkspace.get(item.workspaceId) ?? []), item]);
  let prefetched = 0;
  let calls = 0;
  await Promise.all([...byWorkspace].map(async ([workspaceId, group]) => {
    if (group.length < 2) return;
    try {
      const context = await loadSearchWorkspaceContext(workspaceId, userId);
      const { pipeline } = context.indexing;
      const privacyMode = pipeline.privacyMode;
      const orgId = context.scope.orgId;
      const cache = embeddingCache();
      const texts = new Map<string, string>();
      for (const item of group) {
        const resolved = resolveWorkspaceRetrievalControls({ options: item.options, workspaceId, settings: context.settings, pipeline }).options;
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
        auditScope: { workspaceId },
      });
      if (!result || result.embeddings.length !== values.length) return;
      calls += 1;
      await recordUsageEvent({
        userId,
        scope: { orgId, workspaceId },
        usage: {
          provider: route.provider, model: route.model, metric: "embed-query", inputTokens: result.usage.inputTokens, logOutputTokens: false,
          metadata: { usageSource: METERED_EMBEDDING_PROVIDERS.has(route.provider) ? "provider" : "estimate", batchSize: values.length, batch: true },
        },
      });
      [...texts.keys()].forEach((key, index) => cache.set(key, result.embeddings[index]!.slice()));
      prefetched += values.length;
    } catch (error) {
      // Non-fatal: the searches embed one by one and surface provider errors themselves.
      console.warn(`[search] batch query embedding skipped workspace=${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  return { prefetched, calls };
}
