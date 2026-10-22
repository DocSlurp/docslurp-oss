import type { SearchChunk, SearchOptions } from "../services/search.js";

export type EvidenceAdapterName =
  | "vector"
  | "lexical"
  | "graph"
  | "community"
  | "progressive-page"
  | "completed-page";

export interface EvidenceRetrievalContext {
  query: string;
  /** The query actually embedded (after rewrite/HyDE); other index configs embed this same text. */
  effectiveQuery?: string;
  textQuery: string;
  queryVector: number[] | null;
  userId: string;
  workspaceId: string;
  options: SearchOptions;
}

export interface EvidenceRetrievalResult {
  adapter: EvidenceAdapterName;
  chunks: SearchChunk[];
}

export interface EvidenceRetrievalAdapter {
  name: EvidenceAdapterName;
  retrieve(
    context: EvidenceRetrievalContext,
    previousResults: Partial<Record<EvidenceAdapterName, SearchChunk[]>>,
  ): Promise<SearchChunk[]>;
}

export interface EvidenceRetrievalFns {
  vectorSearch(args: {
    queryVector: number[];
    /** The query text, so a previous index can embed it with its own model. */
    query?: string;
    userId: string;
    workspaceId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  textSearch(args: {
    query: string;
    userId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  graphNeighborSearch(args: {
    query: string;
    workspaceId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  communitySummarySearch(args: {
    query: string;
    workspaceId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  progressivePageSearch(args: {
    query: string;
    userId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  completedPageSearch(args: {
    query: string;
    workspaceId: string;
    options: SearchOptions;
    shouldSearch: boolean;
  }): Promise<SearchChunk[]>;
}

export function createEvidenceRetrievalAdapters(
  fns: EvidenceRetrievalFns,
): EvidenceRetrievalAdapter[] {
  return [
    {
      name: "lexical",
      retrieve: (context) =>
        fns.textSearch({
          query: context.textQuery,
          userId: context.userId,
          options: context.options,
        }),
    },
    {
      name: "graph",
      retrieve: (context) =>
        context.options.enableGraphExpansion
          ? fns.graphNeighborSearch({
              query: context.effectiveQuery ?? context.query,
              workspaceId: context.workspaceId,
              options: context.options,
            })
          : Promise.resolve([]),
    },
    {
      name: "community",
      retrieve: (context) =>
        context.options.enableCommunityExpansion
          ? fns.communitySummarySearch({
              query: context.query,
              workspaceId: context.workspaceId,
              options: context.options,
            })
          : Promise.resolve([]),
    },
    {
      name: "progressive-page",
      retrieve: (context) =>
        fns.progressivePageSearch({
          query: context.textQuery,
          userId: context.userId,
          options: context.options,
        }),
    },
    {
      name: "completed-page",
      retrieve: (context, previousResults) =>
        fns.completedPageSearch({
          query: context.textQuery,
          workspaceId: context.workspaceId,
          options: context.options,
          shouldSearch: (previousResults.lexical ?? []).length === 0,
        }),
    },
    {
      name: "vector",
      retrieve: (context) =>
        context.queryVector
          ? fns.vectorSearch({
              queryVector: context.queryVector,
              query: context.query,
              userId: context.userId,
              workspaceId: context.workspaceId,
              options: context.options,
            })
          : Promise.resolve([]),
    },
  ];
}

export async function retrieveEvidence(
  adapters: EvidenceRetrievalAdapter[],
  context: EvidenceRetrievalContext,
  options: { parallel?: boolean } = {},
): Promise<EvidenceRetrievalResult[]> {
  if (options.parallel) return await retrieveEvidenceInParallel(adapters, context);
  const results: EvidenceRetrievalResult[] = [];
  const previousResults: Partial<Record<EvidenceAdapterName, SearchChunk[]>> = {};

  for (const adapter of adapters) {
    const chunks = await adapter.retrieve(context, previousResults);
    previousResults[adapter.name] = chunks;
    results.push({ adapter: adapter.name, chunks });
  }

  return results;
}

/**
 * The adapters run together; only completed-page waits, because it searches
 * only when lexical found nothing. Results keep adapter order.
 */
async function retrieveEvidenceInParallel(
  adapters: EvidenceRetrievalAdapter[],
  context: EvidenceRetrievalContext,
): Promise<EvidenceRetrievalResult[]> {
  const pending = new Map<EvidenceAdapterName, Promise<SearchChunk[]>>();
  const settled: Partial<Record<EvidenceAdapterName, SearchChunk[]>> = {};
  for (const adapter of adapters) {
    const run = adapter.name === "completed-page"
      ? (pending.get("lexical") ?? Promise.resolve([] as SearchChunk[])).then((lexical) =>
          adapter.retrieve(context, { ...settled, lexical }))
      : adapter.retrieve(context, settled);
    // Observe rejections now; Promise.all below still surfaces the first one.
    run.catch(() => undefined);
    pending.set(adapter.name, run);
  }
  const lists = await Promise.all(adapters.map((adapter) => pending.get(adapter.name)!));
  return adapters.map((adapter, index) => ({ adapter: adapter.name, chunks: lists[index]! }));
}

export function flattenEvidenceResults(
  results: EvidenceRetrievalResult[],
): SearchChunk[][] {
  const fusionOrder: EvidenceAdapterName[] = [
    "vector",
    "lexical",
    "graph",
    "community",
    "progressive-page",
    "completed-page",
  ];
  const resultMap = new Map(results.map((result) => [result.adapter, result]));

  return fusionOrder
    .map((adapter) => resultMap.get(adapter))
    .filter((result): result is EvidenceRetrievalResult => Boolean(result))
    .map((result) => result.chunks.map((chunk) => ({ ...chunk })));
}
