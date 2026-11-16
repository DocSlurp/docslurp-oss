import type { SearchChunk, SearchOptions } from "../services/search.js";
import { LEG_TIMEOUT_EVENTS, emitLegHits, type ProvisionalHitPolicy } from "./stream-hits.js";
import { searchEventCount } from "./timings.js";
import { currentSearchStreamSink } from "./stream-events.js";

export type EvidenceAdapterName =
  | "vector"
  | "lexical"
  | "graph"
  | "community"
  | "progressive-page"
  | "completed-page"
  /** The summary tree (search/summary-tree.ts). Its chunks are placed after fusion; they are never a fusion list. */
  | "summary-tree";

/** What the parallel path tells a leg about its peers. */
export interface EvidenceLegTiming {
  /** `performance.now()` when the legs started. */
  startedAt: number;
  /** The chunk vector leg's elapsed ms since `startedAt`, once it settles (resolved or rejected). */
  vectorSettled: Promise<number>;
}

export interface EvidenceRetrievalContext {
  query: string;
  /** The query actually embedded (after rewrite/HyDE); other index configs embed this same text. */
  effectiveQuery?: string;
  textQuery: string;
  /** May still be in flight: only the vector leg waits for it. */
  queryVector: number[] | null | Promise<number[] | null>;
  userId: string;
  projectId: string;
  options: SearchOptions;
  /** Filters for provisional stream hits; without it a streaming search reports legs with no hit bodies. */
  provisional?: ProvisionalHitPolicy;
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
    timing?: EvidenceLegTiming,
  ): Promise<SearchChunk[]>;
}

export interface EvidenceRetrievalFns {
  vectorSearch(args: {
    queryVector: number[];
    /** The query text, so a previous index can embed it with its own model. */
    query?: string;
    userId: string;
    projectId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  textSearch(args: {
    query: string;
    userId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  graphNeighborSearch(args: {
    query: string;
    projectId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  communitySummarySearch(args: {
    query: string;
    projectId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  progressivePageSearch(args: {
    query: string;
    userId: string;
    options: SearchOptions;
  }): Promise<SearchChunk[]>;
  completedPageSearch(args: {
    query: string;
    projectId: string;
    options: SearchOptions;
    shouldSearch: boolean;
  }): Promise<SearchChunk[]>;
  /**
   * The summary-tree leg, present only when this search runs it (parallel path only). It settles within its
   * deadline of the vector leg and never rejects; its result is read with `summaryTreeLegResultOf`.
   */
  summaryTreeSearch?(args: {
    query: string;
    queryVector: number[] | null;
    projectId: string;
    options: SearchOptions;
    timing: EvidenceLegTiming;
  }): Promise<SearchChunk[]>;
}

const skippedLegs = new WeakSet<SearchChunk[]>();

/**
 * The empty result of a leg that did not run (disabled for the search mode,
 * nothing to search). Streaming searches report no event for it, unlike a leg
 * that ran and found nothing.
 */
export function skippedLeg(): SearchChunk[] {
  const chunks: SearchChunk[] = [];
  skippedLegs.add(chunks);
  return chunks;
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
              projectId: context.projectId,
              options: context.options,
            })
          : Promise.resolve(skippedLeg()),
    },
    {
      name: "community",
      retrieve: (context) =>
        context.options.enableCommunityExpansion
          ? fns.communitySummarySearch({
              query: context.query,
              projectId: context.projectId,
              options: context.options,
            })
          : Promise.resolve(skippedLeg()),
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
          projectId: context.projectId,
          options: context.options,
          shouldSearch: (previousResults.lexical ?? []).length === 0,
        }),
    },
    {
      name: "vector",
      retrieve: async (context) => {
        const queryVector = await context.queryVector;
        return queryVector
          ? fns.vectorSearch({
              queryVector,
              query: context.query,
              userId: context.userId,
              projectId: context.projectId,
              options: context.options,
            })
          : skippedLeg();
      },
    },
    // Last, so the vector leg has started by the time this one is given its settle time.
    ...(fns.summaryTreeSearch ? [{
      name: "summary-tree" as const,
      retrieve: async (context: EvidenceRetrievalContext, _previous: Partial<Record<EvidenceAdapterName, SearchChunk[]>>, timing?: EvidenceLegTiming) =>
        // Without peer timing (the sequential path) there is no deadline to hold the leg to: it does not run.
        timing
          ? fns.summaryTreeSearch!({
              query: context.query,
              queryVector: await context.queryVector,
              projectId: context.projectId,
              options: context.options,
              timing,
            })
          : skippedLeg(),
    }] : []),
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
  const streaming = currentSearchStreamSink() !== undefined;

  for (const adapter of adapters) {
    const startedAt = performance.now();
    const chunks = adapter.name === "summary-tree" ? skippedLeg() : await adapter.retrieve(context, previousResults);
    if (streaming) await reportLeg(adapter.name, chunks, startedAt, context);
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
  const streaming = currentSearchStreamSink() !== undefined;
  const reports: Promise<void>[] = [];
  const startedAt = performance.now();
  for (const adapter of adapters) {
    const elapsed = () => performance.now() - startedAt;
    const run = adapter.name === "completed-page"
      ? (pending.get("lexical") ?? Promise.resolve([] as SearchChunk[])).then((lexical) =>
          adapter.retrieve(context, { ...settled, lexical }))
      : adapter.name === "summary-tree"
      // The tree never fails a search: a rejection here is an empty leg.
      ? adapter.retrieve(context, settled, {
          startedAt,
          vectorSettled: (pending.get("vector") ?? Promise.resolve([] as SearchChunk[])).then(elapsed, elapsed),
        }).catch(() => skippedLeg())
      : adapter.retrieve(context, settled);
    // Observe rejections now; Promise.all below still surfaces the first one.
    run.catch(() => undefined);
    // Report each leg the moment it lands (completion order). A rejected leg reports nothing.
    // Reporting reads the hits' PII withholding first; the search waits for every report before it returns, so no
    // provisional hit is sent after the final results, but no leg waits on another leg's report.
    if (streaming) reports.push(run.then((chunks) => reportLeg(adapter.name, chunks, startedAt, context), () => undefined));
    pending.set(adapter.name, run);
  }
  const lists = await Promise.all(adapters.map((adapter) => pending.get(adapter.name)!));
  await Promise.all(reports);
  return adapters.map((adapter, index) => ({ adapter: adapter.name, chunks: lists[index]! }));
}

/** Side effect only: never throws, never changes what the leg returns. Disabled legs are skipped by the callers' own empty results. */
async function reportLeg(
  leg: EvidenceAdapterName,
  chunks: SearchChunk[],
  startedAt: number,
  context: EvidenceRetrievalContext,
): Promise<void> {
  // The tree leg is not a stream leg: its chunks reach the client only in the final results.
  if (leg === "summary-tree" || skippedLegs.has(chunks)) return;
  try {
    const timeoutEvent = LEG_TIMEOUT_EVENTS[leg];
    await emitLegHits({
      leg,
      chunks,
      startedAt,
      policy: context.provisional,
      timedOut: timeoutEvent ? () => searchEventCount(timeoutEvent) > 0 : undefined,
    });
  } catch {
    // Streaming is best effort.
  }
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
