import { describe, expect, it, vi } from "vitest";
import { searchResultId, searchStreamEventSchema, type SearchStreamEventBody } from "@docslurp/shared";

import {
  retrieveEvidence,
  skippedLeg,
  type EvidenceRetrievalAdapter,
  type EvidenceRetrievalContext,
} from "../search/retrieval-adapters.js";
import { createProvisionalHitPolicy, searchChunkId, type ProvisionalHitPolicy } from "../search/stream-hits.js";
import { withSearchStreamSink, withSearchStreamSubSearch } from "../search/stream-events.js";
import { collectSearchTimings, timePhase } from "../search/timings.js";
import type { SearchChunk } from "../services/search.js";
import { searchChunkToResult } from "../search/search-result.js";

function chunk(id: string, chunkIndex = 0, documentId = `doc-${id}`): SearchChunk {
  return {
    id,
    documentId,
    runId: `run-${id}`,
    chunkIndex,
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

const open = (limit = 20, sent: ReadonlySet<string> = new Set(), newBodies = 3 * limit) => ({ limit, sent, newBodies });

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
    expect(first.result!.citation.documentId).toBe("doc-gr");
  });

  it("emits sequential legs as each one finishes", async () => {
    const s = sink();
    const adapters = [adapter("lexical", async () => [chunk("a")]), adapter("vector", async () => [chunk("b")])];
    await withSearchStreamSink(s.sink, () => retrieveEvidence(adapters, context(policy())));
    expect(s.hits().map((event) => event.leg)).toEqual(["lexical", "vector"]);
  });

  it("builds nothing without a sink", async () => {
    const select = vi.fn(() => ({ hits: [], truncated: false }));
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
    const hits = policy(0.5).select("lexical", [scored("keep", 0.9), scored("drop", 0.2)], open()).hits;
    expect(hits.map((hit) => hit.result!.citation.documentId)).toEqual(["doc-keep"]);
  });

  it("applies the candidate window before the floor like the final path", () => {
    const hits = policy(0, 1).select("lexical", [scored("a", 0.9), scored("b", 0.9)], open()).hits;
    expect(hits).toHaveLength(1);
  });

  it("qualifies community summaries with the scope like the final response", () => {
    const community = { ...chunk("c"), source: "community_summary" as const };
    const scoped = createProvisionalHitPolicy({ query: "q", embeddingPipeline: null, minScore: 0, filters: { documentIds: ["x"] } as never });
    expect(scoped.select("community", [community], open()).hits[0]!.result!.text).toContain("Broader project context");
    expect(policy().select("community", [community], open()).hits[0]!.result!.text).toBe("c");
  });

  it("keeps unmeasured deferred chunks, as the final floor does", () => {
    expect(policy(0.9).select("deferred", [chunk("d")], open()).hits).toHaveLength(1);
  });
});

describe("stream hit identity and dedupe", () => {
  const pageChunk = (id: string): SearchChunk => ({ ...chunk(id, 3, "doc-same"), retrievalStage: "page-index" });
  const emitted = (s: ReturnType<typeof sink>) => s.hits();

  it("keeps page-stage and chunk ids apart for the same document and index", () => {
    const page = pageChunk("p");
    const plain = chunk("c", 3, "doc-same");
    expect(searchChunkId(page)).toBe("document:doc-same:page-text:3");
    expect(searchChunkId(plain)).toBe("document:doc-same:3");
    // The cheap id equals the id of the converted result, so provisional and final ids match.
    for (const c of [page, plain, { ...plain, deferredLocator: "map-node" as const }]) {
      expect(searchChunkId(c)).toBe(searchResultId(searchChunkToResult(c)));
    }
  });

  it("sends a body once: a second leg finds the same id and sends id and legRank only", async () => {
    const s = sink();
    const adapters = [adapter("lexical", async () => [chunk("a")]), adapter("vector", async () => [chunk("b"), chunk("a")])];
    await withSearchStreamSink(s.sink, () => retrieveEvidence(adapters, context(policy())));
    const [lex, vec] = emitted(s);
    expect(lex!.hits[0]!.result).toBeDefined();
    expect(vec!.hits[0]!.result).toBeDefined();
    expect(vec!.hits[1]).toEqual({ id: "document:doc-a:0", legRank: 1 });
  });

  it("shares sent ids with sub-searches but not between streams", async () => {
    const a = sink();
    const adapters = [adapter("lexical", async () => [chunk("a")])];
    await withSearchStreamSink(a.sink, async () => {
      await retrieveEvidence(adapters, context(policy()));
      await withSearchStreamSubSearch(0, () => retrieveEvidence(adapters, context(policy())));
    });
    expect(emitted(a)[0]!.hits[0]!.result).toBeDefined();
    expect(emitted(a)[1]!.hits[0]!.result).toBeUndefined();
    const b = sink();
    await withSearchStreamSink(b.sink, () => retrieveEvidence(adapters, context(policy())));
    expect(emitted(b)[0]!.hits[0]!.result).toBeDefined();
  });

  it("caps a stream at three times the limit of distinct bodies and flags truncation", async () => {
    const s = sink({ hitLimit: 2 });
    const leg = (prefix: string) => adapter("lexical", async () => [chunk(`${prefix}1`), chunk(`${prefix}2`)]);
    await withSearchStreamSink(s.sink, async () => {
      for (const prefix of ["x", "y", "z", "w"]) await retrieveEvidence([leg(prefix)], context(policy()));
    });
    const events = emitted(s);
    expect(events.map((event) => event.hits.length)).toEqual([2, 2, 2, 0]);
    expect(events.map((event) => event.truncated)).toEqual([false, false, false, true]);
    expect(events.flatMap((event) => event.hits).filter((hit) => hit.result)).toHaveLength(6);
  });

  it("never references a body the stream-wide cap kept back, even for a later duplicate in the same leg", () => {
    const chunks = [chunk("a"), chunk("a"), chunk("b")];
    // No body budget left: nothing is sent, and the duplicate must not become a body-less reference to an unsent body.
    expect(policy().select("lexical", chunks, open(20, new Set(), 0))).toMatchObject({ hits: [], truncated: true });
    // One body left: `a` gets it, its duplicate references it, `b` is held back.
    const { hits, truncated } = policy().select("lexical", chunks, open(20, new Set(), 1));
    expect(hits.map((hit) => [hit.id, Boolean(hit.result)])).toEqual([[searchChunkId(chunk("a")), true], [searchChunkId(chunk("a")), false]]);
    expect(truncated).toBe(true);
  });

  it("builds no event for a stream that has closed", async () => {
    const select = vi.fn(() => ({ hits: [], truncated: false }));
    const s = sink();
    let closed = false;
    await withSearchStreamSink({ ...s.sink, closed: () => closed }, async () => {
      await retrieveEvidence([adapter("lexical", async () => [chunk("a")])], context({ select }));
      closed = true;
      await retrieveEvidence([adapter("vector", async () => [chunk("b")])], context({ select }));
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(s.events).toHaveLength(1);
  });

  it("converts only the hits it sends", () => {
    const chunks = [chunk("a"), chunk("b"), chunk("c"), chunk("d")];
    const sent = new Set(["document:doc-a:0"]);
    const selection = policy().select("lexical", chunks, open(2, sent));
    expect(selection.hits.map((hit) => [hit.id, hit.result !== undefined])).toEqual([["document:doc-a:0", false], ["document:doc-b:0", true]]);
    expect(selection.truncated).toBe(true);
  });

  it("does not annotate or convert past the limit except to detect truncation", () => {
    const calls: string[] = [];
    const chunks = [1, 2, 3, 4, 5].map((n) => ({ ...chunk(`n${n}`), get text() { calls.push(`n${n}`); return `n${n}`; } }));
    const selection = policy().select("graph", chunks as SearchChunk[], open(2));
    expect(selection.hits).toHaveLength(2);
    expect(selection.truncated).toBe(true);
    expect(new Set(calls).size).toBeLessThan(5);
  });

  it("reports no truncation when nothing more passes the floor", () => {
    const chunks = [{ ...chunk("a"), lexicalMatch: "partial" as const, queryRelevance: 0.9 }, { ...chunk("b"), lexicalMatch: "partial" as const, queryRelevance: 0.1 }];
    expect(policy(0.5).select("lexical", chunks, open(1)).truncated).toBe(false);
  });

  it("emits events that validate against the contract", async () => {
    const s = sink({ stats: true });
    const adapters = [adapter("lexical", async () => [chunk("a")]), adapter("vector", async () => [chunk("a"), chunk("b")])];
    await withSearchStreamSink(s.sink, () => retrieveEvidence(adapters, context(policy())));
    s.events.forEach((event, seq) => {
      expect(() => searchStreamEventSchema.parse({ protocol: 1, searchId: "s1", seq, elapsedMs: 1, ...event })).not.toThrow();
    });
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
