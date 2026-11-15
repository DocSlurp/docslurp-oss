import {
  SUMMARY_TREE_INCLUDE_CONTEXT_SHARE,
  normalizePipelineFeatures,
  summaryTreeDeadlineMs,
  summaryTreeGuideSlots,
  type SummaryTreeSummary,
} from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));

const tree = await import("../search/summary-tree.js");
const adapters = await import("../search/retrieval-adapters.js");
const { reciprocalRankFusion } = await import("../search/rrf.js");
const { collectSearchTimings, searchHitStatementTimeout } = await import("../search/timings.js");
const { estimateTextTokens } = await import("../search/token-estimate.js");
const { clampToSearchMode } = await import("../search/search-mode.js");

type Item = { id: string; file?: string };
const item = (id: string, file?: string): Item => ({ id, ...(file ? { file } : {}) });
const list = (prefix: string, from: number, to: number, file?: string) => Array.from({ length: to - from + 1 }, (_, index) => item(`${prefix}${from + index}`, file));
const idsOf = (items: Item[]) => items.map((entry) => entry.id);

describe("placeGuidedChunks", () => {
  it("keeps a rank-2 supporting chunk that plain rank fusion pushed out of the top ten", () => {
    // The phase-0 trace: the supporting chunk is rank 2 of the chunk leg. The guided list holds chunks that the chunk
    // leg also returned further down, so each of them scores in both lists.
    const chunkLeg = list("c", 1, 50);
    const supporting = chunkLeg[1]!;
    const guided = list("c", 11, 25);
    // Plain reciprocal-rank fusion of the two lists: every dual-listed chunk outranks rank 2.
    const fused = reciprocalRankFusion([chunkLeg, guided]).slice(0, 10);
    expect(idsOf(fused)).not.toContain(supporting.id);

    // The rule: the chunk leg's own top results keep their positions; guided chunks take the last positions only.
    const base = chunkLeg.slice(0, 10);
    const placed = tree.placeGuidedChunks({ base, guided, limit: 10 });
    const slots = summaryTreeGuideSlots(10);
    expect(placed.protectedPrefix).toBe(10 - slots);
    expect(idsOf(placed.results).slice(0, 10 - slots)).toEqual(idsOf(base).slice(0, 10 - slots));
    expect(placed.results[1]).toBe(supporting);
    expect(idsOf(placed.results).slice(10 - slots)).toEqual(["c11", "c12", "c13"]);
    expect(placed.results).toHaveLength(10);
    expect(placed.placed).toBe(slots);
  });

  it("never removes or demotes the protected prefix, whatever the guided list holds", () => {
    let seed = 11;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let round = 0; round < 500; round += 1) {
      const limit = 1 + Math.floor(random() * 25);
      const base = list("b", 1, Math.floor(random() * (limit + 5))).map((entry) => item(entry.id, `f${Math.floor(random() * 3)}`));
      const pool = [...base, ...list("g", 1, 30).map((entry) => item(entry.id, `f${Math.floor(random() * 5)}`))];
      const guided = Array.from({ length: Math.floor(random() * 20) }, () => pool[Math.floor(random() * pool.length)]!);
      const dedupeKey = random() < 0.5 ? (entry: Item) => entry.file : undefined;
      const placed = tree.placeGuidedChunks({ base, guided, limit, dedupeKey });
      const cut = base.slice(0, limit);
      const slots = summaryTreeGuideSlots(limit);
      const protectedCount = Math.min(cut.length, limit - slots);
      // The first limit - slots results of the base list are in the same positions.
      expect(idsOf(placed.results).slice(0, protectedCount)).toEqual(idsOf(cut).slice(0, protectedCount));
      expect(placed.protectedPrefix).toBeGreaterThanOrEqual(protectedCount);
      expect(placed.placed).toBeLessThanOrEqual(slots);
      expect(placed.results.length).toBeLessThanOrEqual(limit);
      expect(new Set(idsOf(placed.results)).size).toBe(placed.results.length);
      // Nothing is lost when there was room: a base list shorter than the protected size keeps every entry.
      if (cut.length <= limit - slots) for (const entry of cut) expect(idsOf(placed.results)).toContain(entry.id);
      // Everything returned is a base result or a guided chunk.
      for (const entry of placed.results) expect(cut.includes(entry) || guided.includes(entry)).toBe(true);
      // A result list is never shorter than the base list was.
      expect(placed.results.length).toBeGreaterThanOrEqual(cut.length);
    }
  });

  it("appends to a short list, moves a tail entry up instead of duplicating it, and adds nothing at limit 1", () => {
    const short = tree.placeGuidedChunks({ base: list("b", 1, 2), guided: list("g", 1, 9), limit: 10 });
    expect(idsOf(short.results)).toEqual(["b1", "b2", "g1", "g2", "g3"]);
    // b9 is in the base tail and is guided: it takes the first guided position, once.
    const promoted = tree.placeGuidedChunks({ base: list("b", 1, 10), guided: [item("b9"), item("g1")], limit: 10 });
    expect(idsOf(promoted.results)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "g1"]);
    // Guided chunks that are already in the protected prefix place nothing and displace nothing.
    const covered = tree.placeGuidedChunks({ base: list("b", 1, 10), guided: list("b", 1, 3), limit: 10 });
    expect(idsOf(covered.results)).toEqual(idsOf(list("b", 1, 10)));
    expect(covered.placed).toBe(0);
    expect(tree.placeGuidedChunks({ base: [item("b1")], guided: list("g", 1, 3), limit: 1 }).results).toEqual([item("b1")]);
    expect(tree.placeGuidedChunks({ base: [], guided: list("g", 1, 3), limit: 1 }).results).toEqual([]);
    expect(tree.placeGuidedChunks({ base: [], guided: list("g", 1, 9), limit: 10 }).results).toHaveLength(3);
  });

  it("with one result per file, never changes whether that control collapses the results", () => {
    const key = (entry: Item) => entry.file;
    const oneFile = list("b", 1, 10, "a.pdf");
    // All results from one file: a chunk from another file would trigger the collapse, so it is not placed.
    const other = tree.placeGuidedChunks({ base: oneFile, guided: list("g", 1, 3, "b.pdf"), limit: 10, dedupeKey: key });
    expect(other.results).toEqual(oneFile);
    // Chunks of the same file are placed as usual.
    const same = tree.placeGuidedChunks({ base: oneFile, guided: list("g", 1, 5, "a.pdf"), limit: 10, dedupeKey: key });
    expect(idsOf(same.results)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "g1", "g2", "g3"]);
    // Results spanning files are collapsed anyway: one chunk per file the prefix does not cover, none for covered files.
    const spanning = [...list("b", 1, 5, "a.pdf"), ...list("c", 1, 5, "b.pdf")];
    const guided = [item("g1", "a.pdf"), item("g2", "c.pdf"), item("g3", "c.pdf"), item("g4", "d.pdf")];
    const placed = tree.placeGuidedChunks({ base: spanning, guided, limit: 10, dedupeKey: key });
    expect(idsOf(placed.results)).toEqual(["b1", "b2", "b3", "b4", "b5", "c1", "c2", "c3", "g2", "g4"]);
  });
});

describe("capIncludedSummaries", () => {
  const summary = (id: string, words: number): SummaryTreeSummary => ({
    kind: "summary", id, documentId: "d", filename: "d.pdf", level: 1, summary: Array.from({ length: words }, () => "growth").join(" "),
    headingPath: [], pageStart: 1, pageEnd: 2, chunkStart: 0, chunkEnd: 7, relevance: 0.5,
  });
  it("keeps summaries, best first, within their share of the returned context", () => {
    const results = Array.from({ length: 10 }, () => Array.from({ length: 60 }, () => "expansion").join(" "));
    const kept = tree.capIncludedSummaries([summary("a", 100), summary("b", 100), summary("c", 100), summary("d", 100)], results);
    const summaryTokens = kept.reduce((sum, entry) => sum + estimateTextTokens(entry.summary), 0);
    const resultTokens = results.reduce((sum, text) => sum + estimateTextTokens(text), 0);
    expect(kept.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(summaryTokens / (summaryTokens + resultTokens)).toBeLessThanOrEqual(SUMMARY_TREE_INCLUDE_CONTEXT_SHARE);
    // The next one would cross the share.
    const next = summaryTokens + estimateTextTokens(summary("c", 100).summary);
    expect(next / (next + resultTokens)).toBeGreaterThan(SUMMARY_TREE_INCLUDE_CONTEXT_SHARE);
  });
  it("returns none without results, never truncates, and stops at the first that does not fit", () => {
    expect(tree.capIncludedSummaries([summary("a", 5)], [])).toEqual([]);
    expect(tree.capIncludedSummaries([summary("a", 5)], [""])).toEqual([]);
    const results = [Array.from({ length: 40 }, () => "expansion").join(" ")];
    const kept = tree.capIncludedSummaries([summary("big", 400), summary("small", 2)], results);
    // The best summary does not fit; a lower-ranked one is not promoted into its place.
    expect(kept).toEqual([]);
    const whole = tree.capIncludedSummaries([summary("small", 2), summary("big", 400)], results);
    expect(whole).toEqual([summary("small", 2)]);
  });
});

describe("planSummaryTreeSearch", () => {
  const on = { DOCSLURP_SUMMARY_TREE_SERVE: "on" };
  const pipeline = normalizePipelineFeatures({ embed: true, indexVectors: true, summaryTree: { enabled: true } } as never);
  const plain = normalizePipelineFeatures({ embed: true, indexVectors: true } as never);
  const base = { explicit: undefined, projectDefault: undefined, pipeline, env: on, searchMode: "deep" as const, native: true, filters: { projectId: "p" }, subSearch: false };

  it("plays no part unless the request or the project default asks", () => {
    expect(tree.planSummaryTreeSearch(base)).toBeNull();
    expect(tree.planSummaryTreeSearch({ ...base, projectDefault: "off" })).toBeNull();
    expect(tree.planSummaryTreeSearch({ ...base, explicit: "off", projectDefault: "include" })).toBeNull();
    // It is never derived "on" from the pipeline.
    expect(tree.planSummaryTreeSearch({ ...base, pipeline })).toBeNull();
  });

  it("runs the request's mode over the project default, in hybrid and deep mode", () => {
    expect(tree.planSummaryTreeSearch({ ...base, projectDefault: "guide" })).toEqual({ requested: "guide", run: "guide" });
    expect(tree.planSummaryTreeSearch({ ...base, explicit: "include", projectDefault: "guide" })).toEqual({ requested: "include", run: "include" });
    expect(tree.planSummaryTreeSearch({ ...base, explicit: "guide", searchMode: "hybrid" })).toEqual({ requested: "guide", run: "guide" });
    // Document-level filters are fine.
    expect(tree.planSummaryTreeSearch({ ...base, explicit: "guide", filters: { projectId: "p", documentIds: ["d"], tags: ["t"] } })?.run).toBe("guide");
  });

  it("is silent for a project default that cannot run, and explicit for a request that cannot", () => {
    const blocked = [
      { searchMode: "keyword" as const },
      { env: {} },
      { env: { DOCSLURP_SUMMARY_TREE_SERVE: "maybe" } },
      { pipeline: plain },
      { pipeline: null },
      { native: false },
      { filters: { projectId: "p", geo: { field: "location", op: "bbox", bbox: [0, 0, 1, 1] } } as never },
      { filters: { projectId: "p", pageRange: { from: 1 } } },
      { filters: { projectId: "p", headingPath: ["Intro"] } },
    ];
    for (const change of blocked) {
      expect(tree.planSummaryTreeSearch({ ...base, ...change, projectDefault: "include" })).toBeNull();
      expect(tree.planSummaryTreeSearch({ ...base, ...change, explicit: "include" })).toEqual({ requested: "include", run: null });
    }
  });

  it("an unreadable value asks for nothing and never falls through to the project default", () => {
    expect(tree.planSummaryTreeSearch({ ...base, explicit: "always" as never, projectDefault: "include" })).toBeNull();
    expect(tree.planSummaryTreeSearch({ ...base, projectDefault: "always" as never })).toBeNull();
  });

  it("sub-searches run guide: a summary never enters the list their parent fuses as chunks", () => {
    expect(tree.planSummaryTreeSearch({ ...base, explicit: "include", subSearch: true })).toEqual({ requested: "include", run: "guide" });
  });

  it("keeps the request's value through the search-mode clamp, and the compatibility routes send off", () => {
    expect(clampToSearchMode({ summaryTree: "guide" } as never, "keyword")).toMatchObject({ summaryTree: "guide", searchMode: "keyword" });
    expect(tree.planSummaryTreeSearch({ ...base, explicit: "off", projectDefault: "guide" })).toBeNull();
  });
});

describe("summary tree outcomes", () => {
  const plan = { requested: "include" as const, run: "include" as const };
  it("reports a leg that never ran as a mode skip", () => {
    expect(tree.summaryTreeOutcome({ requested: "guide", run: null }, null)).toEqual({ requested: "guide", applied: "off", skipped: "mode", ms: 0 });
    expect(tree.summaryTreeOutcome(plan, { applied: "include", ms: 12.6 })).toEqual({ requested: "include", applied: "include", ms: 13 });
    expect(tree.summaryTreeOutcome(plan, { applied: "off", skipped: "deadline", ms: 80 })).toEqual({ requested: "include", applied: "off", skipped: "deadline", ms: 80 });
  });
  it("combines sub-searches: applied only when every one applied, and then as guide", () => {
    const applied = { requested: "guide" as const, applied: "guide" as const, ms: 10 };
    expect(tree.combineSummaryTreeOutcomes(plan, [applied, { ...applied, ms: 30 }])).toEqual({ requested: "include", applied: "guide", ms: 30 });
    expect(tree.combineSummaryTreeOutcomes(plan, [applied, { requested: "guide", applied: "off", skipped: "deadline", ms: 90 }]))
      .toEqual({ requested: "include", applied: "off", skipped: "deadline", ms: 90 });
    expect(tree.combineSummaryTreeOutcomes(plan, [])).toEqual({ requested: "include", applied: "off", skipped: "mode", ms: 0 });
  });
});

describe("runSummaryTreeLegWithDeadline", () => {
  afterEach(() => { tree.observeSummaryTreeLegs(null); vi.useRealTimers(); });
  const result = (applied: "guide" | "off" = "guide") => ({ applied, ms: 0, guided: [], summaries: [], stats: { candidateDocuments: 1, hits: 1, staleDropped: 0, belowFloor: 0, validated: 1 } });
  const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it("the deadline is the larger of the factor and the grace over the vector leg's time", () => {
    expect(summaryTreeDeadlineMs(10)).toBe(60);
    expect(summaryTreeDeadlineMs(400)).toBe(600);
    expect(summaryTreeDeadlineMs(Number.NaN)).toBe(50);
  });

  it("keeps a leg that settles inside the deadline and times it", async () => {
    const { value, timings } = await collectSearchTimings(() => tree.runSummaryTreeLegWithDeadline({
      startedAt: performance.now(), vectorSettled: after(20, 20), run: async () => after(40, result()),
    }));
    expect(value.applied).toBe("guide");
    expect(value.skipped).toBeUndefined();
    expect(value.ms).toBeGreaterThanOrEqual(35);
    expect(timings.summaryTreeMs).toBeGreaterThanOrEqual(35);
    expect(timings.summaryTreeSkipped).toBeUndefined();
  });

  it("a leg that settles before the vector leg is always in time", async () => {
    const value = await tree.runSummaryTreeLegWithDeadline({ startedAt: performance.now(), vectorSettled: after(120, 120), run: async () => after(5, result()) });
    expect(value.applied).toBe("guide");
    expect(value.ms).toBeLessThan(100);
  });

  it("drops a leg that misses the deadline, tells it to stop, and counts the skip", async () => {
    let sawExpired = false;
    const samples: unknown[] = [];
    tree.observeSummaryTreeLegs((sample) => samples.push(sample));
    const started = performance.now();
    const { value, timings } = await collectSearchTimings(() => tree.runSummaryTreeLegWithDeadline({
      startedAt: performance.now(), vectorSettled: after(10, 10),
      run: async (expired) => { await after(300, null); sawExpired = expired(); return result(); },
    }));
    expect(performance.now() - started).toBeLessThan(250);
    expect(value).toMatchObject({ applied: "off", skipped: "deadline", guided: [], summaries: [] });
    expect(timings.summaryTreeSkipped).toBe(1);
    // The counter is not a statement timeout: pollers keep retrying.
    expect(searchHitStatementTimeout({ timings })).toBe(false);
    await vi.waitFor(() => expect(samples).toHaveLength(1));
    expect(sawExpired).toBe(true);
    expect(samples[0]).toMatchObject({ skipped: "deadline" });
  });

  it("never rejects: a throwing leg, and a failed vector leg, are handled", async () => {
    const { value, timings } = await collectSearchTimings(() => tree.runSummaryTreeLegWithDeadline({
      startedAt: performance.now(), vectorSettled: Promise.resolve(1), run: async () => { throw new Error("boom"); },
    }));
    expect(value).toMatchObject({ applied: "off", skipped: "error" });
    expect(timings.summaryTreeSkipped).toBe(1);
    const afterVectorFailure = await tree.runSummaryTreeLegWithDeadline({
      startedAt: performance.now(), vectorSettled: Promise.reject(new Error("vector failed")), run: async () => result(),
    });
    expect(afterVectorFailure.applied).toBe("guide");
  });
});

describe("summary-tree retrieval adapter", () => {
  const chunk = (id: string) => ({ id }) as never;
  const fns = (summaryTreeSearch?: (args: { timing: { startedAt: number; vectorSettled: Promise<number> } }) => Promise<never[]>) => ({
    vectorSearch: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return [chunk("v1")]; },
    textSearch: async () => [chunk("t1")],
    graphNeighborSearch: async () => [],
    communitySummarySearch: async () => [],
    progressivePageSearch: async () => [],
    completedPageSearch: async () => [],
    ...(summaryTreeSearch ? { summaryTreeSearch: summaryTreeSearch as never } : {}),
  });
  const context = { query: "q", textQuery: "q", queryVector: [1, 0], userId: "u", projectId: "p", options: {} };

  it("exists only when the search runs the leg, and is never a fusion list", async () => {
    expect(adapters.createEvidenceRetrievalAdapters(fns()).map((adapter) => adapter.name)).not.toContain("summary-tree");
    const created = adapters.createEvidenceRetrievalAdapters(fns(async () => [chunk("guided")]));
    expect(created.at(-1)!.name).toBe("summary-tree");
    const results = await adapters.retrieveEvidence(created, context, { parallel: true });
    expect(results.find((result) => result.adapter === "summary-tree")!.chunks).toEqual([{ id: "guided" }]);
    expect(adapters.flattenEvidenceResults(results).flat().map((entry) => entry.id)).toEqual(["v1", "t1"]);
  });

  it("is given the vector leg's settle time on the parallel path, and does not run on the sequential one", async () => {
    let vectorMs = -1;
    const search = vi.fn(async (args: { timing: { startedAt: number; vectorSettled: Promise<number> } }) => { vectorMs = await args.timing.vectorSettled; return []; });
    const created = adapters.createEvidenceRetrievalAdapters(fns(search));
    await adapters.retrieveEvidence(created, context, { parallel: true });
    expect(vectorMs).toBeGreaterThanOrEqual(10);
    search.mockClear();
    const sequential = await adapters.retrieveEvidence(created, context);
    expect(search).not.toHaveBeenCalled();
    expect(sequential.find((result) => result.adapter === "summary-tree")!.chunks).toEqual([]);
  });

  it("a rejecting tree leg is an empty leg; the search's other legs still answer", async () => {
    const created = adapters.createEvidenceRetrievalAdapters(fns(async () => { throw new Error("boom"); }));
    const results = await adapters.retrieveEvidence(created, context, { parallel: true });
    expect(results.find((result) => result.adapter === "summary-tree")!.chunks).toEqual([]);
    expect(results.find((result) => result.adapter === "vector")!.chunks).toEqual([{ id: "v1" }]);
  });
});
