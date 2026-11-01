import { beforeEach, describe, expect, it, vi } from "vitest";

const beginMock = vi.fn();
const sqlMock = Object.assign(vi.fn(), {
  unsafe: vi.fn(),
  array: vi.fn((value: unknown) => value),
  begin: beginMock,
});
const queryRewriteMock = vi.hoisted(() => ({
  decomposeQuery: vi.fn(),
  rewriteQuery: vi.fn(),
}));

vi.mock("../db.js", () => ({
  sql: sqlMock,
}));

vi.mock("../search/query-rewrite.js", () => queryRewriteMock);

const { createSearchSessionJournal } = await import("../search/session.js");
const {
  applySearchPostRetrievalProcessing,
  fuseSearchResponses,
  searchResultsToChunks,
} = await import("../search/session-execution.js");
const { planRecursiveSearchMode } = await import(
  "../search/session-planner.js"
);

describe("SearchSessionJournal", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    beginMock.mockReset();
    beginMock.mockImplementation(async (run) => run(sqlMock));
    delete process.env.SEARCH_QUERY_ENCRYPTION_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("keeps root session ids stable and returns usage snapshots", () => {
    const journal = createSearchSessionJournal({ rootSessionId: "root-1" });

    journal.record({
      provider: "openrouter",
      model: "model-1",
      metric: "query-rewrite",
      inputTokens: 12,
      outputTokens: 4,
    });

    const snapshot = journal.usageEvents();
    snapshot.push({
      provider: "openrouter",
      model: "model-2",
      metric: "hyde",
      amount: 2,
      unit: "token",
      costCents: 0,
      inputTokens: 1,
      outputTokens: 1,
      metadata: {},
    });

    expect(journal.sessionId).toBe("root-1");
    expect(journal.usageEvents()).toHaveLength(1);
  });

  it("keeps diagnostics snapshots immutable", () => {
    const journal = createSearchSessionJournal({ rootSessionId: "root-1" });
    journal.recordDiagnostic("retrievalControls", {
      defaultsApplied: ["limit"],
    });

    const snapshot = journal.diagnostics();
    (snapshot.retrievalControls as { defaultsApplied: string[] })
      .defaultsApplied.push("useHyDE");

    expect(journal.diagnostics()).toEqual({
      retrievalControls: {
        defaultsApplied: ["limit"],
      },
    });
  });

  it("persists redacted session metadata and skips zero-token usage events", async () => {
    sqlMock.mockResolvedValue([{ id: "session-1" }]);
    const journal = createSearchSessionJournal({ rootSessionId: "session-1" });
    const rawQuery = "confidential search query";

    journal.record({
      provider: "openrouter",
      model: "model-1",
      metric: "query-rewrite",
      inputTokens: 12,
      outputTokens: 4,
    });
    journal.record({
      provider: "openrouter",
      model: "model-1",
      metric: "noop",
      inputTokens: 0,
      outputTokens: 0,
    });

    await journal.persist({
      userId: "user-1",
      query: rawQuery,
      results: [],
      chunks: [],
      metadata: {
        originalQuery: rawQuery,
        effectiveQuery: "expanded search query",
        filters: { workspaceId: "ws-1" },
        options: {
          filters: { workspaceId: "ws-1" },
          useHyDE: true,
          queryRewrite: true,
        },
        workspaceId: "ws-1",
      },
    });

    const sessionInsert = sqlMock.mock.calls.find(([strings]) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      return text.includes("insert into search_sessions");
    });
    expect(sessionInsert).toBeDefined();
    expect(sessionInsert).not.toContain(rawQuery);
    expect(
      sessionInsert?.some(
        (value) =>
          typeof value === "string" && value.startsWith("redacted:sha256:"),
      ),
    ).toBe(true);

    const metadataJson = sessionInsert?.find(
      (value) => typeof value === "string" && value.includes("queryHash"),
    );
    expect(metadataJson).toBeDefined();
    expect(metadataJson).not.toContain(rawQuery);
    expect(metadataJson).toContain("diagnostics");

    const usageInserts = sqlMock.mock.calls.filter(([strings]) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      return text.includes("insert into usage_events");
    });
    expect(usageInserts).toHaveLength(1);
  });

  it("refreshes one streaming session and persists each retrieval attempt's usage once", async () => {
    let sessionExists = false;
    sqlMock.mockImplementation(async (strings, ...values) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("insert into search_sessions")) {
        if (sessionExists && !text.includes("on conflict")) {
          throw new Error("duplicate key value violates search_sessions_pkey");
        }
        sessionExists = true;
        return [{ id: values[0] }];
      }
      return [];
    });
    const input = {
      userId: "user-1",
      query: "find relevant evidence",
      results: [],
      chunks: [],
      metadata: {
        originalQuery: "find relevant evidence",
        options: {},
        workspaceId: "ws-1",
      },
    };
    const first = createSearchSessionJournal({ rootSessionId: "stream-1" });
    first.record({
      provider: "local",
      model: "embedding-test",
      metric: "embed-query",
      inputTokens: 7,
      outputTokens: 0,
    });
    await first.persist(input);
    const next = createSearchSessionJournal({ rootSessionId: "stream-1" });
    next.record({
      provider: "local",
      model: "embedding-test",
      metric: "embed-query",
      inputTokens: 9,
      outputTokens: 0,
    });
    await Promise.all([next.persist(input), next.persist(input)]);

    const usageInserts = sqlMock.mock.calls.filter(([strings]) =>
      Array.isArray(strings) && strings.join(" ").includes("insert into usage_events"),
    );
    expect(usageInserts).toHaveLength(2);
    expect(usageInserts.map((call) => call[10])).toEqual([7, 9]);
    expect(usageInserts.every((call) => String(call[12]).includes('"sessionId":"stream-1"'))).toBe(true);
  });

  it("retries rolled-back usage without advancing the journal or logging it again", async () => {
    const client = vi.fn();
    let failUsageWrite = true;
    const committedUsage: unknown[][] = [];
    beginMock.mockImplementation(async (run) => {
      const stagedUsage: unknown[][] = [];
      client.mockImplementation(async (strings, ...values) => {
        const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
        if (text.includes("insert into search_sessions")) {
          return [{ id: values[0] }];
        }
        if (text.includes("insert into usage_events")) {
          if (failUsageWrite) throw new Error("usage write failed");
          stagedUsage.push(values);
        }
        return [];
      });
      const result = await run(client);
      committedUsage.push(...stagedUsage);
      return result;
    });
    const journal = createSearchSessionJournal({ rootSessionId: "retry-1" });
    journal.record({
      provider: "local",
      model: "embedding-test",
      metric: "embed-query",
      inputTokens: 13,
    });
    const input = {
      userId: "user-1",
      query: "retrieve evidence",
      results: [],
      chunks: [],
      metadata: { originalQuery: "retrieve evidence", options: {}, workspaceId: "ws-1" },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(journal.persist(input)).rejects.toThrow("usage write failed");
      expect(committedUsage).toEqual([]);
      failUsageWrite = false;
      await journal.persist(input);
      await journal.persist(input);
      expect(committedUsage).toHaveLength(1);
      expect(committedUsage[0]?.[9]).toBe(13);
      expect(sqlMock).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("rejects a root id owned by a different query or scope before rewriting results or usage", async () => {
    sqlMock.mockResolvedValue([]); // PostgreSQL's scoped ON CONFLICT updates no row.
    const journal = createSearchSessionJournal({ rootSessionId: "other-session" });
    journal.record({ provider: "local", model: "embedding-test", metric: "embed-query", inputTokens: 4 });
    await expect(journal.persist({
      userId: "other-user",
      query: "different query",
      results: [],
      chunks: [],
      metadata: { originalQuery: "different query", options: {}, workspaceId: "other-workspace" },
    })).rejects.toThrow("different query or scope");
    expect(sqlMock).toHaveBeenCalledTimes(1);
    const insert = sqlMock.mock.calls[0]?.[0].join(" ");
    expect(insert).toContain("search_sessions.user_id = excluded.user_id");
    expect(insert).toContain("search_sessions.metadata ->> 'workspaceId' = excluded.metadata ->> 'workspaceId'");
    expect(insert).toContain("search_sessions.metadata ->> 'queryHash' = excluded.metadata ->> 'queryHash'");
  });
});

describe("Search Session execution helpers", () => {
  const result = {
    text: "A",
    score: 0.9,
    citation: {
      source: "document" as const,
      documentId: "doc-1",
      filename: "a.txt",
      pageNumber: 1,
      pageNumbers: [1],
      headingPath: ["A"],
      chunkIndex: 2,
      blockIds: [],
      blockTypes: [],
      evidenceType: "paragraph" as const,
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
    },
  };

  it.each([false, true])("preserves the reranker winner through context positioning (MMR=%s)", async (useMmr) => {
    const chunks = searchResultsToChunks([
      { ...result, text: "Routine maintenance checklist for the plant.", score: 1 },
      {
        ...result, text: "General equipment safety procedures.", score: 0.8,
        citation: { ...result.citation, chunkIndex: 3 },
      },
      {
        ...result, text: "The cobalt pump calibration interval is eighteen months.", score: 0.1,
        citation: { ...result.citation, chunkIndex: 4 },
      },
    ]);
    const processed = await applySearchPostRetrievalProcessing({
      query: "cobalt pump calibration interval",
      chunks,
      limit: 3,
      options: { useRerank: true, useMmr, mmrLambda: 1 },
      privacyMode: "standard",
      session: createSearchSessionJournal({ rootSessionId: "ranking-test" }),
    });

    expect(processed[0]?.id).toBe(chunks[2]?.id);
    expect(new Set(processed.map((chunk) => chunk.id))).toEqual(
      new Set(chunks.map((chunk) => chunk.id)),
    );
  });

  it("lets MMR replace a near-duplicate with a different passage", async () => {
    const failover = "The backup region takes traffic after fifteen minutes of checkout errors.";
    const chunks = searchResultsToChunks([
      { ...result, text: failover, score: 1 },
      { ...result, text: `Copy: ${failover}`, score: 0.95, citation: { ...result.citation, chunkIndex: 3 } },
      { ...result, text: "Vendor credits accrue per hour of downtime.", score: 0.9, citation: { ...result.citation, chunkIndex: 4 } },
    ]);
    const run = async (useMmr: boolean) => {
      const session = createSearchSessionJournal({});
      const processed = await applySearchPostRetrievalProcessing({
        query: "when does the backup region take traffic", chunks, limit: 2,
        options: { useMmr, resultOrder: "relevance" }, privacyMode: "standard", session,
      });
      return { ids: processed.map((chunk) => chunk.id), diagnostics: session.diagnostics() };
    };
    expect((await run(false)).ids).toEqual([chunks[0]!.id, chunks[1]!.id]);
    const diversified = await run(true);
    expect(diversified.ids).toEqual([chunks[0]!.id, chunks[2]!.id]);
    expect(diversified.diagnostics.mmr).toMatchObject({ similarity: "lexical", lambda: 0.5, candidates: 3, selected: 2, diversified: 1 });
  });

  it("keeps an explicit candidate window fixed when rerank is toggled", async () => {
    const chunks = searchResultsToChunks(Array.from({ length: 80 }, (_, i) => ({
      ...result, text: i === 49 ? "cobalt calibration" : "routine maintenance",
      score: 1 / (i + 1), citation: { ...result.citation, chunkIndex: i },
    })));
    for (const useRerank of [false, true]) {
      const processed = await applySearchPostRetrievalProcessing({
        query: "cobalt calibration", chunks, limit: 3,
        options: { useRerank, candidateDepth: 50, resultOrder: "relevance" },
        privacyMode: "standard", session: createSearchSessionJournal({}),
      });
      expect(processed).toHaveLength(3);
      expect(processed.every(c => chunks.slice(0, 50).some(x => x.id === c.id))).toBe(true);
      if (useRerank) expect(processed[0]?.id).toBe(chunks[49].id);
      else expect(processed.map(c => c.id)).toEqual(chunks.slice(0, 3).map(c => c.id));
    }
  });

  it("packs only the selected set and preserves relevance order when requested", async () => {
    const chunks = searchResultsToChunks(Array.from({ length: 12 }, (_, i) => ({
      ...result, text: `maintenance ${i}`, score: 1 / (i + 1), citation: { ...result.citation, chunkIndex: i },
    })));
    const run = (resultOrder?: "relevance" | "prompt") => applySearchPostRetrievalProcessing({
      query: "maintenance", chunks, limit: 10, options: { candidateDepth: 12, resultOrder },
      privacyMode: "standard", session: createSearchSessionJournal({}),
    });
    const relevance = await run("relevance"), prompt = await run("prompt"), legacy = await run();
    expect(relevance.map(c => c.id)).toEqual(chunks.slice(0, 10).map(c => c.id));
    expect(prompt[9].id).toBe(relevance[1].id);
    expect(new Set(prompt.map(c => c.id))).toEqual(new Set(relevance.map(c => c.id)));
    expect(legacy.map(c => c.id)).toEqual(prompt.map(c => c.id));
    expect(prompt.map(c => [c.documentId, c.pageNumber, c.chunkIndex])).toEqual(legacy.map(c => [c.documentId, c.pageNumber, c.chunkIndex]));
  });

  it("converts Search Session results back into retrieval chunks", () => {
    expect(searchResultsToChunks([result])).toEqual([
      expect.objectContaining({
        id: "doc-1:2",
        documentId: "doc-1",
        chunkIndex: 2,
        text: "A",
        retrievalStage: "full-index",
      }),
    ]);
  });

  it("fuses recursive Search Session responses behind one Interface", () => {
    const chunks = fuseSearchResponses(
      [
        {
          results: [result],
          sessionId: "session-1",
          availability: null as never,
        },
        {
          results: [{ ...result, text: "B", score: 0.7 }],
          sessionId: "session-2",
          availability: null as never,
        },
      ],
      1,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      documentId: "doc-1",
      score: 1,
    });
  });

  it("plans decomposed recursive Search Session calls behind the planner Interface", async () => {
    queryRewriteMock.decomposeQuery.mockReturnValueOnce(["alpha", "beta"]);
    const journal = createSearchSessionJournal({ rootSessionId: "root-1" });
    const runSearch = vi
      .fn()
      .mockResolvedValueOnce({
        results: [result],
        sessionId: "child-1",
        availability: null,
        usageEvents: [
          {
            provider: "openrouter",
            model: "model-1",
            metric: "query-rewrite",
            amount: 3,
            unit: "token",
            costCents: 0,
            inputTokens: 2,
            outputTokens: 1,
            metadata: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            ...result,
            text: "B",
            score: 0.7,
            citation: {
              ...result.citation,
              documentId: "doc-2",
              filename: "b.txt",
              chunkIndex: 3,
            },
          },
        ],
        sessionId: "child-2",
        availability: null,
        usageEvents: [],
      });

    const plan = await planRecursiveSearchMode({
      query: "alpha and beta",
      userId: "user-1",
      options: { queryDecompose: true, limit: 2 },
      session: journal,
      privacyMode: "standard",
      runSearch,
    });

    expect(runSearch).toHaveBeenNthCalledWith(
      1,
      "alpha",
      "user-1",
      expect.objectContaining({
        queryDecompose: false,
        suppressSessionLog: true,
        rootSessionId: "root-1",
      }),
    );
    expect(runSearch).toHaveBeenNthCalledWith(
      2,
      "beta",
      "user-1",
      expect.objectContaining({
        queryDecompose: false,
        suppressSessionLog: true,
        rootSessionId: "root-1",
      }),
    );
    expect(plan?.effectiveQuery).toBe("alpha and beta");
    expect(plan?.chunks).toHaveLength(2);
    expect(journal.usageEvents()).toEqual([
      expect.objectContaining({ metric: "query-rewrite" }),
    ]);
  });
});
