import { describe, expect, it, vi } from "vitest";
import type { SearchStreamEventBody } from "@docslurp/shared";

import {
  retrieveEvidence,
  skippedLeg,
  type EvidenceRetrievalAdapter,
  type EvidenceRetrievalContext,
} from "../search/retrieval-adapters.js";
import { createProvisionalHitPolicy, type ProvisionalHitPolicy } from "../search/stream-hits.js";
import { withSearchStreamSink, withSearchStreamSubSearch } from "../search/stream-events.js";
import { collectSearchTimings, timePhase } from "../search/timings.js";
import type { SearchChunk } from "../services/search.js";

function chunk(id: string): SearchChunk {
  return {
    id,
    documentId: `doc-${id}`,
    runId: `run-${id}`,
    chunkIndex: 0,
    text: id,
    headingPath: [],
    pageNumber: null,
    tokenEstimate: 1,
    score: 1,
    filename: `${id}.txt`,
    pageNumbers: [],
    blockIds: [],
    blockTypes: [],
    evidenceType: null,
    canonicalDocumentUri: null,
    tableGranularity: null,
    tableRowIndex: null,
    tableRowCount: null,
    tableColumnNames: [],
    tableColumnTypes: [],
    tableCells: [],
    tableCell: null,
    regionBoxes: [],
    regions: [],
    regionCoordinateSpace: null,
    sourceTrace: null,
    source: "document",
    retrievalStage: "full-index",
  };
}


type Hits = Extract<SearchStreamEventBody, { type: "search.hits" }>;

function sink(opts: { stats?: boolean; hitLimit?: number } = {}) {
  const events: SearchStreamEventBody[] = [];
  return {
    events,
    sink: { stats: opts.stats ?? false, hitLimit: opts.hitLimit ?? 20, emit: (event: SearchStreamEventBody) => void events.push(event) },
    hits: () => events.filter((event): event is Hits => event.type === "search.hits"),
  };
}

function policy(minScore = 0, candidateDepth?: number): ProvisionalHitPolicy {
  return createProvisionalHitPolicy({ query: "q", embeddingPipeline: null, minScore, candidateDepth, filters: undefined });
}

function context(provisional?: ProvisionalHitPolicy): EvidenceRetrievalContext {
  return { query: "q", textQuery: "q", queryVector: null, userId: "u", projectId: "p", options: {} as never, provisional };
}

function adapter(name: EvidenceRetrievalAdapter["name"], run: () => Promise<SearchChunk[]>): EvidenceRetrievalAdapter {
  return { name, retrieve: run };
}

const later = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("streaming leg events", () => {
  it("emits parallel legs in completion order while results keep adapter order", async () => {
    const s = sink();
    const adapters = [
      adapter("lexical", () => later(30, [chunk("lex")])),
      adapter("graph", () => later(5, [chunk("gr")])),
      adapter("vector", () => later(15, [chunk("vec")])),
    ];
    const results = await withSearchStreamSink(s.sink, () => retrieveEvidence(adapters, context(policy()), { parallel: true }));
    expect(s.hits().map((event) => event.leg)).toEqual(["graph", "vector", "lexical"]);
    expect(results.map((result) => result.adapter)).toEqual(["lexical", "graph", "vector"]);
    const first = s.hits()[0]!.hits[0]!;
    expect(first).toMatchObject({ id: "document:doc-gr:0", legRank: 0 });
    expect(first.result.citation.documentId).toBe("doc-gr");
  });

  it("emits sequential legs as each one finishes", async () => {
    const s = sink();
    const adapters = [adapter("lexical", async () => [chunk("a")]), adapter("vector", async () => [chunk("b")])];
    await withSearchStreamSink(s.sink, () => retrieveEvidence(adapters, context(policy())));
    expect(s.hits().map((event) => event.leg)).toEqual(["lexical", "vector"]);
  });

  it("builds nothing without a sink", async () => {
    const select = vi.fn(() => []);
    const adapters = [adapter("lexical", async () => [chunk("a")]), adapter("vector", async () => [chunk("b")])];
    await retrieveEvidence(adapters, context({ select }), { parallel: true });
    await retrieveEvidence(adapters, context({ select }));
    expect(select).not.toHaveBeenCalled();
  });

  it("emits nothing for a failing leg and the error still propagates", async () => {
    for (const parallel of [true, false]) {
      const s = sink();
      const adapters = [
        adapter("lexical", async () => [chunk("a")]),
        adapter("vector", async () => { throw new Error("boom"); }),
      ];
      await expect(withSearchStreamSink(s.sink, () => retrieveEvidence(adapters, context(policy()), { parallel }))).rejects.toThrow("boom");
      expect(s.hits().map((event) => event.leg)).not.toContain("vector");
    }
  });

  it("never fails the search when the sink or the policy throws", async () => {
    const throwing = { stats: false, hitLimit: 5, emit: () => { throw new Error("sink down"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapters = [adapter("lexical", async () => [chunk("a")])];
    const results = await withSearchStreamSink(throwing, () => retrieveEvidence(adapters, context({ select: () => { throw new Error("bad"); } }), { parallel: true }));
    expect(results[0]!.chunks).toHaveLength(1);
    warn.mockRestore();
  });

  it("caps hits at the sink limit and flags truncation", async () => {
    const s = sink({ hitLimit: 2 });
    const adapters = [adapter("lexical", async () => [chunk("a"), chunk("b"), chunk("c"), chunk("d")])];
    await withSearchStreamSink(s.sink, () => retrieveEvidence(adapters, context(policy())));
    const event = s.hits()[0]!;
    expect(event.hits.map((hit) => hit.legRank)).toEqual([0, 1]);
    expect(event.truncated).toBe(true);
    expect(event.stats).toBeUndefined();
  });

  it("reports a leg that ran empty but nothing for a skipped leg", async () => {
    const s = sink({ stats: true });
    const adapters = [adapter("lexical", async () => []), adapter("graph", async () => skippedLeg())];
    await withSearchStreamSink(s.sink, () => retrieveEvidence(adapters, context(policy())));
    expect(s.hits()).toHaveLength(1);
    expect(s.hits()[0]).toMatchObject({ leg: "lexical", hits: [], truncated: false, stats: { candidates: 0 } });
  });

  it("sends no hit bodies when no filter policy was supplied", async () => {
    const s = sink();
    await withSearchStreamSink(s.sink, () => retrieveEvidence([adapter("lexical", async () => [chunk("a")])], context()));
    expect(s.hits()[0]).toMatchObject({ leg: "lexical", hits: [] });
  });

  it("labels events of a sub-search", async () => {
    const s = sink();
    await withSearchStreamSink(s.sink, async () => {
      await withSearchStreamSubSearch(1, () => retrieveEvidence([adapter("lexical", async () => [chunk("a")])], context(policy())));
      await retrieveEvidence([adapter("vector", async () => [chunk("b")])], context(policy()));
    });
    expect(s.hits().map((event) => [event.leg, event.subSearch])).toEqual([["lexical", 1], ["vector", undefined]]);
  });
});

describe("provisional hit filters", () => {
  const scored = (id: string, queryRelevance: number): SearchChunk => ({ ...chunk(id), lexicalMatch: "partial", queryRelevance });

  it("drops lexical chunks the relevance floor would drop", () => {
    const hits = policy(0.5).select("lexical", [scored("keep", 0.9), scored("drop", 0.2)]);
    expect(hits.map((hit) => hit.citation.documentId)).toEqual(["doc-keep"]);
  });

  it("applies the candidate window before the floor like the final path", () => {
    const hits = policy(0, 1).select("lexical", [scored("a", 0.9), scored("b", 0.9)]);
    expect(hits).toHaveLength(1);
  });

  it("qualifies community summaries with the scope like the final response", () => {
    const community = { ...chunk("c"), source: "community_summary" as const };
    const scoped = createProvisionalHitPolicy({ query: "q", embeddingPipeline: null, minScore: 0, filters: { documentIds: ["x"] } as never });
    expect(scoped.select("community", [community])[0]!.text).toContain("Broader project context");
    expect(policy().select("community", [community])[0]!.text).toBe("c");
  });

  it("keeps unmeasured deferred chunks, as the final floor does", () => {
    expect(policy(0.9).select("deferred", [chunk("d")])).toHaveLength(1);
  });
});

describe("streaming phase events", () => {
  it("reports named phases with stats and ignores internal timings", async () => {
    const s = sink({ stats: true });
    await withSearchStreamSink(s.sink, () => collectSearchTimings(async () => {
      await timePhase("plan", async () => undefined);
      await timePhase("vector", async () => undefined);
      await timePhase("text", async () => undefined);
    }));
    expect(s.events.map((event) => event.type === "search.phase" ? event.phase : null)).toEqual(["plan"]);
  });

  it("sends no phase events unless stats were requested", async () => {
    const s = sink({ stats: false });
    await withSearchStreamSink(s.sink, () => collectSearchTimings(() => timePhase("plan", async () => undefined)));
    expect(s.events).toEqual([]);
  });
});
