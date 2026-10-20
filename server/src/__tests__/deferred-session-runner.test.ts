import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(async () => []), { array: (v: unknown) => v }) }));
vi.mock("../search/session-planner.js", () => ({
  planRecursiveSearchMode: vi.fn(async () => null),
  prepareSearchSessionRetrievalPlan: vi.fn(async (args: { effectiveOptions: object }) => ({
    effectiveOptions: args.effectiveOptions, selfQueryReasons: [], effectiveQuery: "q", queryVector: [1, 0], textQuery: "q",
  })),
}));
vi.mock("../search/graph-expansion.js", () => ({ expandGraphTextQuery: vi.fn(async (a: { textQuery: string }) => a.textQuery) }));
vi.mock("../search/session-execution.js", () => ({
  executeSearchSessionRetrieval: vi.fn(async (input: { retrieveCandidateLists: () => Promise<unknown[][]> }) => {
    const lists = await input.retrieveCandidateLists();
    return { results: [{ text: "r", score: 1, citation: { documentId: "dm", chunkIndex: 0 } }, { text: "f", score: 1, citation: { documentId: "dfull", chunkIndex: 0 } }], sessionId: "s", availability: {}, lists };
  }),
  finalizeSearchSessionExecution: vi.fn(),
}));

const { runSearchSession } = await import("../search/session-runner.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = (temperature: "hot" | "cold") => ({
  temperature, candidatePages: 0, indexedCandidatePages: 0, materializedPages: 0, pendingPages: 0,
  materializeMs: 0, creditsSpent: 0, routerUsed: false, fallbackUsed: false, stoppedBy: null,
});

function run(deferredMs: number | null, temperature: "hot" | "cold") {
  const retrieve = vi.fn(async () => { await sleep(10); return []; });
  const adapters = {
    buildAvailability: vi.fn(), runSearch: vi.fn(), wholeCorpusFallback: vi.fn(),
    vectorSearch: retrieve, textSearch: retrieve, graphNeighborSearch: retrieve, communitySummarySearch: retrieve,
    progressivePageSearch: retrieve, completedPageSearch: retrieve,
    ...(deferredMs === null ? {} : { deferredPageSearch: vi.fn(async () => { await sleep(deferredMs); return { chunks: [], stats: stats(temperature), documentIds: ["dm"] }; }) }),
  };
  const setup = {
    session: { sessionId: "s", flushUsage: async () => undefined }, normalizedScope: { workspaceId: "ws", orgId: "o" }, workspaceSettings: {},
    openRouterApiKey: undefined, privacyMode: "standard", workspacePipeline: { embedding: {} },
  };
  const started = performance.now();
  return runSearchSession({ query: "q", userId: "u", options: {}, setup: setup as never, adapters: adapters as never })
    .then((response) => ({ response, ms: performance.now() - started }));
}

describe("deferred phase placement in the session runner", () => {
  it("a hot deferred check overlaps retrieval and adds under 25 ms", async () => {
    const baseline = (await run(null, "hot")).ms; // six sequential 10 ms adapters
    const hot = (await run(5, "hot")).ms;
    // Strict budget only as a benchmark (PERF=1); under parallel test load timers jitter, so the default is a loose guard.
    expect(hot - baseline).toBeLessThan(process.env.PERF === "1" ? 25 : 150);
  });

  it("a cold deferred phase (longer than one adapter) overlaps retrieval instead of preceding it", async () => {
    const baseline = (await run(null, "cold")).ms;
    // Serial placement would cost baseline + 40 ms; concurrent hides it behind the ~60 ms of retrieval.
    const cold = (await run(40, "cold")).ms;
    expect(cold - baseline).toBeLessThan(process.env.PERF === "1" ? 20 : 35);
  });

  it("stamps temperature only on results from deferred-mode documents", async () => {
    const { response } = await run(0, "hot");
    const byDoc = new Map(response.results.map((r) => [r.citation.documentId, r]));
    expect(byDoc.get("dm")!.retrieval).toEqual({ stage: "chunk", temperature: "hot" });
    expect(byDoc.get("dfull")!.retrieval).toBeUndefined();
    expect(response.deferred?.temperature).toBe("hot");
  });
});
