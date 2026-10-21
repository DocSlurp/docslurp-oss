import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Legacy (Postgres) vs SEARCH_LANCEDB_NATIVE search on the synthetic corpus of
 * worker/scripts/search-native-bench-seed.ts. Skipped unless
 * SEARCH_NATIVE_BENCH_DATABASE_URL and SEARCH_NATIVE_BENCH_QRELS are set; never
 * run against production.
 *
 *   SEARCH_NATIVE_BENCH_DATABASE_URL=postgres://… SEARCH_NATIVE_BENCH_QRELS=qrels.json LANCEDB_URI=… \
 *     SEARCH_NATIVE_BENCH_OUT=results.json pnpm --filter @docslurp/server exec vitest run src/__tests__/search-native.bench.test.ts
 *
 * Per mode: recall@10 of the planted target, latency, SQL statements a search
 * issues before it answers (and in total), Postgres blocks read from disk and
 * from cache, sequentially and with SEARCH_NATIVE_BENCH_CONCURRENCY (6) searches
 * in flight. Query vectors come from the qrels file, so no provider is called.
 */
const databaseUrl = process.env.SEARCH_NATIVE_BENCH_DATABASE_URL;
const qrelsPath = process.env.SEARCH_NATIVE_BENCH_QRELS;

vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  resolveOpenRouterApiKey: () => undefined,
  generateOpenRouterText: () => { throw new Error("Unexpected inference"); },
}));

type Query = { q: string; kind: string; informative: boolean; target: { id: string; documentId: string; chunkIndex: number }; vector: number[] };

let sql: postgres.Sql;
let statements = 0;
let reads = 0;
/** Session, result, usage and diagnostics writes (inline on the legacy path, write-behind on native). */
const WRITE = /^\s*(begin|commit|rollback|insert|delete|update|with recorded|savepoint|release)/i;
let search: typeof import("../services/search.js");
let session: typeof import("../search/session.js");
let eligible: typeof import("../search/eligible-documents.js");

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!) : 0;
}

describe.skipIf(!databaseUrl || !qrelsPath)("search native benchmark", () => {
  const qrels = qrelsPath ? JSON.parse(readFileSync(qrelsPath, "utf8")) as { workspaceId: string; userId: string; queries: Query[] } : null;
  beforeAll(async () => {
    sql = postgres(databaseUrl!, { max: 20, prepare: false, onnotice: () => {}, debug: (_connection, query) => { statements += 1; if (!WRITE.test(query)) reads += 1; } });
    vi.doMock("../db.js", () => ({ sql }));
    search = await import("../services/search.js");
    session = await import("../search/session.js");
    eligible = await import("../search/eligible-documents.js");
  }, 60_000);
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  const options = {
    limit: 10, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false, parentRetrieval: false,
    useContextualCompression: false, useHyDE: false, stepback: false, iterativeMultiHop: false,
    enableGraphExpansion: false, enableCommunityExpansion: false, summarySeed: false, queryDecompose: false,
  };

  async function blocks(): Promise<{ read: number; hit: number }> {
    const [row] = await sql<{ read: string; hit: string }[]>`select sum(blks_read)::text as read, sum(blks_hit)::text as hit from pg_stat_database`;
    return { read: Number(row!.read), hit: Number(row!.hit) };
  }

  async function one(query: Query) {
    const before = statements;
    const readsBefore = reads;
    const started = performance.now();
    const response = await search.hybridSearch(query.q, qrels!.userId, { ...options, queryVector: query.vector, filters: { workspaceId: qrels!.workspaceId } });
    const ms = performance.now() - started;
    const onPath = statements - before;
    const readsOnPath = reads - readsBefore;
    await session.drainSearchSessionWrites();
    const rank = response.results.findIndex((result) => result.citation.documentId === query.target.documentId && result.citation.chunkIndex === query.target.chunkIndex);
    return { ms, onPath, readsOnPath, total: statements - before, rank, timings: response.timings ?? {} };
  }

  async function runMode(label: string, env: Record<string, string>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    eligible.resetEligibleDocumentCachesForTests();
    const queries = qrels!.queries;
    for (const query of queries.slice(0, 10)) await one(query);
    const io0 = await blocks();
    const sequential: Array<{ query: Query } & Awaited<ReturnType<typeof one>>> = [];
    for (const query of queries) sequential.push({ query, ...(await one(query)) });
    const io1 = await blocks();
    const concurrency = Number(process.env.SEARCH_NATIVE_BENCH_CONCURRENCY ?? 6);
    let next = 0;
    const concurrent: number[] = [];
    const wallStarted = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < queries.length) {
        const query = queries[next++]!;
        const started = performance.now();
        await search.hybridSearch(query.q, qrels!.userId, { ...options, queryVector: query.vector, filters: { workspaceId: qrels!.workspaceId } });
        concurrent.push(performance.now() - started);
      }
    }));
    const wallMs = performance.now() - wallStarted;
    await session.drainSearchSessionWrites();
    const recall = (filter: (item: typeof sequential[number]) => boolean) => {
      const items = sequential.filter(filter);
      return { n: items.length, recallAt10: Number((items.filter((item) => item.rank >= 0 && item.rank < 10).length / Math.max(1, items.length)).toFixed(3)) };
    };
    const lexicalTimeouts = sequential.filter((item) => (item.timings as Record<string, number>).lexicalTimeout).length;
    vi.unstubAllEnvs();
    return {
      label,
      recall: {
        all: recall(() => true),
        keywordUninformativeVector: recall((item) => item.query.kind === "keyword" && !item.query.informative),
        conversationalUninformativeVector: recall((item) => item.query.kind === "conversational" && !item.query.informative),
        informativeVector: recall((item) => item.query.informative),
      },
      sequential: {
        p50Ms: quantile(sequential.map((item) => item.ms), 0.5), p90Ms: quantile(sequential.map((item) => item.ms), 0.9),
        meanMs: Math.round(sequential.reduce((sum, item) => sum + item.ms, 0) / sequential.length),
        sqlBeforeAnswerMean: Number((sequential.reduce((sum, item) => sum + item.onPath, 0) / sequential.length).toFixed(2)),
        sqlBeforeAnswerP50: quantile(sequential.map((item) => item.onPath), 0.5),
        sqlReadsBeforeAnswerMean: Number((sequential.reduce((sum, item) => sum + item.readsOnPath, 0) / sequential.length).toFixed(2)),
        sqlReadsBeforeAnswerMax: Math.max(...sequential.map((item) => item.readsOnPath)),
        sqlTotalMean: Number((sequential.reduce((sum, item) => sum + item.total, 0) / sequential.length).toFixed(2)),
        pgBlocksReadPerSearch: Math.round((io1.read - io0.read) / sequential.length),
        pgBlocksHitPerSearch: Math.round((io1.hit - io0.hit) / sequential.length),
        lexicalTimeouts,
      },
      concurrent: {
        concurrency, p50Ms: quantile(concurrent, 0.5), p90Ms: quantile(concurrent, 0.9),
        searchesPerSecond: Number((queries.length / (wallMs / 1000)).toFixed(2)),
      },
    };
  }

  it("compares legacy and native search", async () => {
    const legacy = await runMode("legacy (Postgres FTS + doc-list CTE + hydration)", { SEARCH_LANCEDB_NATIVE: "0" });
    const native = await runMode("native (LanceDB BM25 + vector + hydration)", { SEARCH_LANCEDB_NATIVE: "1" });
    const legacyAgain = await runMode("legacy, second run (warmer caches)", { SEARCH_LANCEDB_NATIVE: "0" });
    const exactLexical = await runMode("legacy, SEARCH_LEXICAL_CANDIDATES=100000 (rank every match)", { SEARCH_LANCEDB_NATIVE: "0", SEARCH_LEXICAL_CANDIDATES: "100000" });
    const results = { queries: qrels!.queries.length, runs: [legacy, native, legacyAgain, exactLexical] };
    console.log(JSON.stringify(results, null, 2));
    if (process.env.SEARCH_NATIVE_BENCH_OUT) writeFileSync(process.env.SEARCH_NATIVE_BENCH_OUT, JSON.stringify(results, null, 2));
    expect(native.recall.all.n).toBe(qrels!.queries.length);
  }, 3_600_000);
});
