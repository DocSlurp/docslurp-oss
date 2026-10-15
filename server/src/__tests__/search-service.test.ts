import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = Object.assign(vi.fn(), {
  unsafe: vi.fn(),
  array: vi.fn((value: unknown) => value),
  json: vi.fn((value: unknown) => value),
  begin: vi.fn(),
});
const lanceDbVectorSearch = vi.fn();
const generateOpenRouterText = vi.fn();
const compressChunks = vi.fn();

// Spend admission has its own tests (spend-guard.test.ts); allow spend here.
vi.mock("../services/billing/spend-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/billing/spend-guard.js")>()),
  assertCanSpend: vi.fn(async () => undefined),
  canSpend: vi.fn(async () => true),
}));

vi.mock("../db.js", () => ({
  sql: sqlMock,
}));

vi.mock("../lib/ai.js", () => ({
  SEARCH_OPENROUTER_MODEL: "openrouter-test",
  embedConfiguredText: vi.fn(),
  generateOpenRouterText,
  resolveOpenRouterApiKey: vi.fn(() => process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY ?? process.env.ANTHROPIC_API_KEY),
}));

vi.mock("../search/rrf.js", () => ({
  reciprocalRankFusion: vi.fn((rankedLists: unknown[][]) => rankedLists.flat()),
}));

vi.mock("../search/lancedb.js", () => ({
  lanceDbVectorSearch,
}));

vi.mock("../search/contextual-compression.js", () => ({
  compressChunks,
}));

vi.mock("../search/confidence.js", () => ({
  calibrateSearchConfidence: (results: unknown) => results,
}));

vi.mock("../search/hyde.js", () => ({
  hydeExpand: vi.fn(),
}));

vi.mock("../search/query-rewrite.js", () => ({
  decomposeQuery: vi.fn(() => []),
  rewriteQuery: vi.fn(),
}));

vi.mock("../search/self-query.js", () => ({
  deriveSelfQueryFilters: vi.fn(),
}));

vi.mock("../search/stepback.js", () => ({
  stepbackPrompt: vi.fn(),
}));

vi.mock("../search/synonym.js", () => ({
  expandQuery: (query: string) => query,
}));

vi.mock("../services/search-controls.js", () => ({
  applySearchControls: ({ results }: { results: unknown }) => results,
  getWorkspaceSearchSettings: vi.fn(
    async (workspaceId: string, userId: string) => ({
      workspaceId,
      userId,
      typoTolerance: true,
      dedupeByFilename: true,
      rankingRules: {},
      boosts: { byMime: {} },
      pinnedResults: [],
      synonyms: {},
      retrievalDefaults: {
        resultCount: 8,
        useHyDE: false,
        useRerank: true,
        useContextualCompression: false,
        useMmr: false,
        mmrLambda: 0.4,
        queryRewrite: false,
        queryDecompose: false,
        stepback: false,
        parentRetrieval: true,
        summarySeed: false,
        selfQuery: false,
      },
      chat: {
        mode: "retrieval",
        answerStyle: "balanced",
        citations: true,
        searchInstructions: null,
      },
      compatSettings: {},
      rules: [],
      compatMetadata: {},
    }),
  ),
  recordZeroResultDiagnostics: vi.fn(async () => undefined),
}));

const { hybridSearch, MissingWorkspaceScopeError, deriveSearchAvailability } =
  await import("../services/search.js");

describe("hybridSearch", () => {
  beforeEach(() => {
    sqlMock.begin.mockImplementation(async (run) => {
      const client = Object.assign(vi.fn(async (strings, ...values) => {
        const result = await sqlMock(strings, ...values);
        const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
        return text.includes("insert into search_sessions")
          ? [{ id: values[0] }]
          : result;
      }), { array: sqlMock.array });
      return run(client);
    });
    lanceDbVectorSearch.mockReset();
    generateOpenRouterText.mockReset();
    compressChunks.mockReset();
    delete process.env.SEARCH_QUERY_ENCRYPTION_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("rejects unscoped retrieval before any search work starts", async () => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();

    await expect(hybridSearch("test", "user-1")).rejects.toBeInstanceOf(
      MissingWorkspaceScopeError,
    );
    expect(sqlMock).not.toHaveBeenCalled();
    expect(sqlMock.unsafe).not.toHaveBeenCalled();
  });

  it("allows retrieval with an explicit run scope", async () => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    sqlMock.mockImplementation(async (strings) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("select runs.workspace_id")) {
        return [{ workspace_id: "ws-1" }];
      }
      if (text.includes("select pipeline")) {
        return [];
      }
      if (text.includes("with scoped_runs as")) {
        return [
          {
            total_documents: 2,
            indexed_documents: 1,
            page_indexed_documents: 2,
            searchable_documents: 2,
            in_progress_documents: 1,
            total_pages: 9,
            searchable_pages: 5,
            indexed_chunk_count: 4,
            queued_runs: 0,
            processing_runs: 1,
          },
        ];
      }
      return [];
    });
    sqlMock.unsafe.mockResolvedValue([]);

    const onSearchActivity = vi.fn();
    await expect(
      hybridSearch("test", "user-1", { runId: "run-1", onSearchActivity }),
    ).resolves.toEqual({
      timings: expect.objectContaining({ totalMs: expect.any(Number), setupMs: expect.any(Number) }),
      results: [],
      sessionId: expect.any(String),
      availability: {
        status: "partial",
        isPartial: true,
        keywordOnly: false,
        scope: {
          workspaceId: "ws-1",
          runId: "run-1",
        },
        coverage: {
          totalDocuments: 2,
          indexedDocuments: 1,
          pageIndexedDocuments: 2,
          searchableDocuments: 2,
          pageOnlyDocuments: 1,
          keywordOnlyDocuments: 0,
          inProgressDocuments: 1,
          totalPages: 9,
          searchablePages: 5,
          indexedChunkCount: 4,
          queuedRuns: 0,
          processingRuns: 1,
        },
        resultBreakdown: {
          indexedResultCount: 0,
          pageResultCount: 0,
        },
        message:
          "Searching 5 of 9 pages (2 of 2 documents); 1 document still processing.",
      },
      usageEvents: [],
    });
    expect(onSearchActivity).toHaveBeenCalledTimes(2);
    const [started, finished] = onSearchActivity.mock.calls.map(call => call[0]);
    expect(started).toMatchObject({ query: "test", status: "loading" });
    expect(finished).toMatchObject({ id: started.id, groupId: started.groupId, status: "success", resultCount: 0, inputTokens: 0, outputTokens: 0 });
    expect(finished.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects document scopes that cross workspace boundaries", async () => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    sqlMock.mockImplementation(async (strings) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("select distinct d.workspace_id")) {
        return [{ workspace_id: "ws-1" }, { workspace_id: "ws-2" }];
      }
      return [];
    });

    await expect(
      hybridSearch("test", "user-1", {
        filters: { documentIds: ["doc-1", "doc-2"] },
      }),
    ).rejects.toThrow("Search scope must stay within a single workspace");
    expect(sqlMock.unsafe).not.toHaveBeenCalled();
  });

  it("derives a pending availability state when search has not warmed up yet", () => {
    expect(
      deriveSearchAvailability(
        {
          total_documents: 3,
          indexed_documents: 0,
          page_indexed_documents: 1,
          searchable_documents: 0,
          in_progress_documents: 3,
          total_pages: 15,
          searchable_pages: 0,
          indexed_chunk_count: 0,
          queued_runs: 1,
          processing_runs: 1,
        },
        {
          workspaceId: "ws-1",
          runId: "run-1",
        },
      ),
    ).toEqual({
      status: "pending",
      isPartial: true,
      keywordOnly: false,
      scope: {
        workspaceId: "ws-1",
        runId: "run-1",
      },
      coverage: {
        totalDocuments: 3,
        indexedDocuments: 0,
        pageIndexedDocuments: 1,
        searchableDocuments: 0,
        pageOnlyDocuments: 0,
        keywordOnlyDocuments: 0,
        inProgressDocuments: 3,
        totalPages: 15,
        searchablePages: 0,
        indexedChunkCount: 0,
        queuedRuns: 1,
        processingRuns: 1,
      },
      resultBreakdown: {
        indexedResultCount: 0,
        pageResultCount: 0,
      },
      message:
        "Search is still warming up for this scope. 0/3 documents are searchable so far.",
    });
  });

  it("does not report failed-only scopes as still warming up", () => {
    expect(
      deriveSearchAvailability(
        {
          total_documents: 1,
          indexed_documents: 0,
          page_indexed_documents: 0,
          searchable_documents: 0,
          in_progress_documents: 0,
          failed_documents: 1,
          total_pages: 12,
          searchable_pages: 0,
          indexed_chunk_count: 0,
          queued_runs: 0,
          processing_runs: 0,
          failed_runs: 1,
          stalled_runs: 0,
        },
        {
          workspaceId: "ws-1",
          runId: "run-1",
        },
      ),
    ).toEqual({
      status: "empty",
      isPartial: false,
      keywordOnly: false,
      scope: {
        workspaceId: "ws-1",
        runId: "run-1",
      },
      coverage: {
        totalDocuments: 1,
        indexedDocuments: 0,
        pageIndexedDocuments: 0,
        searchableDocuments: 0,
        pageOnlyDocuments: 0,
        keywordOnlyDocuments: 0,
        inProgressDocuments: 0,
        totalPages: 12,
        searchablePages: 0,
        indexedChunkCount: 0,
        queuedRuns: 0,
        processingRuns: 0,
      },
      resultBreakdown: {
        indexedResultCount: 0,
        pageResultCount: 0,
      },
      message:
        "No searchable content is available for this scope because 1 document has failed or stalled during processing. Retry or reprocess the failed run to rebuild the index.",
    });
  });

  it("treats chunk-indexed workspaces as searchable even when page indexing is disabled", () => {
    expect(
      deriveSearchAvailability(
        {
          total_documents: 1,
          indexed_documents: 1,
          page_indexed_documents: 0,
          searchable_documents: 1,
          in_progress_documents: 0,
          total_pages: 50,
          searchable_pages: 0,
          indexed_chunk_count: 276,
          queued_runs: 0,
          processing_runs: 0,
        },
        {
          workspaceId: "ws-1",
        },
      ),
    ).toEqual({
      status: "complete",
      isPartial: false,
      keywordOnly: false,
      scope: {
        workspaceId: "ws-1",
        runId: null,
      },
      coverage: {
        totalDocuments: 1,
        indexedDocuments: 1,
        pageIndexedDocuments: 0,
        searchableDocuments: 1,
        pageOnlyDocuments: 0,
        keywordOnlyDocuments: 0,
        inProgressDocuments: 0,
        totalPages: 50,
        searchablePages: 0,
        indexedChunkCount: 276,
        queuedRuns: 0,
        processingRuns: 0,
      },
      resultBreakdown: {
        indexedResultCount: 0,
        pageResultCount: 0,
      },
      message: null,
    });
  });

  it.each([true, false])("hydrates page context with optional page-index records: %s", async (hasPages) => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    sqlMock.array.mockClear();

    sqlMock.mockImplementation(
      async (strings: unknown) => {
        const text = Array.isArray(strings)
          ? strings.join(" ")
          : String(strings);
        if (text.includes("select runs.workspace_id")) {
          return [{ workspace_id: "ws-1" }];
        }

        if (text.includes("with scoped_runs as")) {
          return [
            {
              total_documents: 1,
              indexed_documents: 1,
              page_indexed_documents: 1,
              searchable_documents: 1,
              in_progress_documents: 0,
              total_pages: 4,
              searchable_pages: 4,
              indexed_chunk_count: 1,
              queued_runs: 0,
              processing_runs: 0,
            },
          ];
        }

        if (
          text.includes("from document_chunks c") &&
          (text.includes("websearch_to_tsquery") || text.includes("plainto_tsquery"))
        ) {
          return [
            {
              id: "chunk-1",
              document_id: "doc-1",
              run_id: "run-1",
              chunk_index: 0,
              text: "Chunk body",
              heading_path: [],
              page_number: 3,
              token_estimate: 42,
              rank: 1,
              filename: "contract.pdf",
              metadata: {},
            },
          ];
        }

        if (text.includes("progressive_pages")) {
          return [];
        }

        if (text.includes("jsonb_to_recordset")) {
          return [{ document_id: "doc-1", chunk_index: 0, text: "Neighboring page text", page_numbers: [3, 4] }];
        }

        if (text.includes("select document_id, page_number, text")) {
          return hasPages ? [
            { document_id: "doc-1", page_number: 3, text: "Parent page text" },
          ] : [];
        }

        return [];
      },
    );

    const response = await hybridSearch("contract", "user-1", {
      runId: "run-1",
      suppressSessionLog: true,
      parentRetrieval: true,
      useRerank: false,
      useMmr: false,
    });

    expect(response.results[0]?.parentText).toBe(hasPages ? "Parent page text" : "Neighboring page text");
    if (!hasPages) expect(response.results[0]?.citation.pageNumbers).toEqual([3, 4]);
    expect(sqlMock.array).toHaveBeenNthCalledWith(1, ["doc-1"], 25);
    expect(sqlMock.array).toHaveBeenNthCalledWith(2, [3], 23);

    const pageLookupCall = sqlMock.mock.calls.find(
      ([strings]) =>
        Array.isArray(strings) &&
        strings.join(" ").includes("select document_id, page_number, text"),
    );
    expect(pageLookupCall).toBeDefined();
    expect(pageLookupCall?.[0].join(" ")).toContain("document_id = any(");
    expect(pageLookupCall?.[0].join(" ")).toContain("page_number = any(");
    expect(pageLookupCall?.[0].join(" ")).not.toContain(
      "where (document_id, page_number) in",
    );
    expect(pageLookupCall?.[1]).toEqual(["doc-1"]);
    expect(pageLookupCall?.[2]).toEqual([3]);
  });

  it("falls back to disjunctive lexical matching for natural-language list queries", async () => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();

    sqlMock.mockImplementation(async (strings, ...values) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("from workspaces w")) {
        return [
          {
            workspace_id: "ws-1",
            org_id: "org-1",
            workspace_owner_user_id: "user-1",
            org_role: "owner",
            workspace_role: null,
          },
        ];
      }
      if (text.includes("select pipeline")) {
        return [];
      }
      if (text.includes("with scoped_runs as")) {
        return [
          {
            total_documents: 1,
            indexed_documents: 1,
            page_indexed_documents: 0,
            searchable_documents: 1,
            in_progress_documents: 0,
            total_pages: 50,
            searchable_pages: 0,
            indexed_chunk_count: 276,
            queued_runs: 0,
            processing_runs: 0,
          },
        ];
      }
      if (text.includes("select id from documents")) {
        return [{ id: "doc-1" }];
      }
      if (
        text.includes("websearch_to_tsquery('english'") &&
        text.includes("from document_chunks c")
      ) {
        return [];
      }

      if (
        text.includes("to_tsquery('english'") &&
        !text.includes("websearch_to_tsquery")
      ) {
        expect(values).toContain("math");
        return [
          {
            id: "chunk-1",
            document_id: "doc-1",
            run_id: "run-1",
            chunk_index: 0,
            text: "MATH 1010 Calculus 1",
            heading_path: ["Mathematics"],
            page_number: 12,
            token_estimate: 4,
            rank: 1,
            filename: "catalog.pdf",
            metadata: {},
          },
        ];
      }

      if (text.includes("progressive_pages")) {
        return [];
      }

      return [];
    });

    const response = await hybridSearch("List of math classes?", "user-1", {
      filters: { workspaceId: "ws-1" },
      useRerank: false,
      useMmr: false,
      parentRetrieval: false,
      suppressSessionLog: true,
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.text).toContain("MATH 1010");
    expect(response.availability.status).toBe("complete");
  });

  it("restricts vector candidates to the requested documents inside an authorized workspace", async () => {
    sqlMock.mockReset();
    sqlMock.mockImplementation(async (strings) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("from workspaces w")) return [{ workspace_id: "ws-1", org_id: "org-1", workspace_owner_user_id: "user-1", org_role: "owner", workspace_role: null }];
      if (text.includes("join vector_indexes")) return [{ id: "doc-1" }, { id: "doc-2" }];
      return [];
    });
    lanceDbVectorSearch.mockResolvedValue([]);
    await hybridSearch("contract", "user-1", {
      filters: { workspaceId: "ws-1", documentIds: ["doc-1"] },
      queryVector: [0.1, 0.2], useRerank: false, useMmr: false,
      parentRetrieval: false, suppressSessionLog: true,
    });
    expect(lanceDbVectorSearch).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1", documentIds: ["doc-1"], legacyDocumentIds: ["doc-1"],
    }));
  });

  it("finds dedup copies through their vector owner and returns the copy's chunk", async () => {
    sqlMock.mockReset();
    sqlMock.mockImplementation(async (strings) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("from workspaces w")) return [{ workspace_id: "ws-1", org_id: "org-1", workspace_owner_user_id: "user-1", org_role: "owner", workspace_role: null }];
      if (text.includes("join vector_indexes")) return [{ id: "copy", owner_id: "owner" }];
      if (text.includes("jsonb_to_recordset")) {
        return [{ id: "copy-chunk-3", document_id: "copy", run_id: "run-2", chunk_index: 3, text: "Copy chunk body", heading_path: [],
          page_number: 1, token_estimate: 10, rank: 0, filename: "doc.html", metadata: {}, hit_id: "owner-chunk-3" }];
      }
      return [];
    });
    lanceDbVectorSearch.mockResolvedValue([{ id: "owner-chunk-3", documentId: "owner", chunkIndex: 3, score: 0.9 }]);
    const response = await hybridSearch("contract", "user-1", {
      filters: { workspaceId: "ws-1" }, queryVector: [0.1, 0.2], useRerank: false, useMmr: false,
      parentRetrieval: false, suppressSessionLog: true,
    });
    expect(lanceDbVectorSearch).toHaveBeenCalledWith(expect.objectContaining({ documentIds: ["copy", "owner"] }));
    expect(response.results.map((result) => result.text)).toContain("Copy chunk body");
  });

  it("checks workspace access again before LanceDB vector search", async () => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    let accessChecks = 0;

    sqlMock.mockImplementation(async (strings) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("from workspaces w")) {
        accessChecks += 1;
        return accessChecks === 1
          ? [
              {
                workspace_id: "ws-1",
                org_id: "org-1",
                workspace_owner_user_id: "user-1",
                org_role: "owner",
                workspace_role: null,
              },
            ]
          : [];
      }

      if (text.includes("with scoped_runs as")) {
        return [
          {
            total_documents: 1,
            indexed_documents: 1,
            page_indexed_documents: 0,
            searchable_documents: 1,
            in_progress_documents: 0,
            total_pages: 1,
            searchable_pages: 0,
            indexed_chunk_count: 1,
            queued_runs: 0,
            processing_runs: 0,
          },
        ];
      }

      return [];
    });

    await hybridSearch("contract", "user-1", {
      filters: { workspaceId: "ws-1" },
      queryVector: [0.1, 0.2],
      useRerank: false,
      useMmr: false,
      parentRetrieval: false,
      suppressSessionLog: true,
    });

    expect(accessChecks).toBe(2);
    expect(lanceDbVectorSearch).not.toHaveBeenCalled();
  });

  it("encrypts stored search queries and records only hashes in metadata", async () => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    process.env.SEARCH_QUERY_ENCRYPTION_KEY = "s".repeat(32);
    const rawQuery = "confidential acquisition terms";

    sqlMock.mockImplementation(async (strings) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("from workspaces w")) {
        return [
          {
            workspace_id: "ws-1",
            org_id: "org-1",
            workspace_owner_user_id: "user-1",
            org_role: "owner",
            workspace_role: null,
          },
        ];
      }
      if (text.includes("with scoped_runs as")) {
        return [
          {
            total_documents: 1,
            indexed_documents: 1,
            page_indexed_documents: 0,
            searchable_documents: 1,
            in_progress_documents: 0,
            total_pages: 1,
            searchable_pages: 0,
            indexed_chunk_count: 1,
            queued_runs: 0,
            processing_runs: 0,
          },
        ];
      }
      if (
        text.includes("from document_chunks c") &&
        text.includes("websearch_to_tsquery")
      ) {
        return [
          {
            id: "chunk-1",
            document_id: "doc-1",
            run_id: "run-1",
            chunk_index: 0,
            text: "Acquisition terms",
            heading_path: [],
            page_number: 1,
            token_estimate: 3,
            rank: 1,
            filename: "ma.pdf",
            metadata: {},
          },
        ];
      }
      return [];
    });

    await hybridSearch(rawQuery, "user-1", {
      filters: { workspaceId: "ws-1" },
      useRerank: false,
      useMmr: false,
      parentRetrieval: false,
    });

    const insertCall = sqlMock.mock.calls.find(([strings]) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      return text.includes("insert into search_sessions");
    });
    expect(insertCall).toBeDefined();
    const encryptionCall = sqlMock.mock.calls.find(([strings]) =>
      Array.isArray(strings) && strings.join(" ").includes("pgp_sym_encrypt"),
    );
    expect(encryptionCall?.[0].join(" ")).toContain("enc:pgp:v1:");
    expect(encryptionCall).toContain(rawQuery);

    const metadataJson = insertCall?.find(
      (value) =>
        typeof value === "string" &&
        value.includes("queryHash") &&
        value.includes("effectiveQueryHash"),
    );
    expect(metadataJson).toBeDefined();
    expect(metadataJson).not.toContain(rawQuery);
  });

  it("iteratively retrieves bridge entities, dedupes chunks, and stores the retrieval chain", async () => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";

    generateOpenRouterText
      .mockResolvedValueOnce({
        text: '{"entities":["Acme Corp","Patent X","Jane Doe"]}',
        usage: { inputTokens: 32, outputTokens: 14 },
      })
      .mockResolvedValueOnce({
        text: '{"entities":[]}',
        usage: { inputTokens: 20, outputTokens: 6 },
      });

    sqlMock.mockImplementation(async (strings, ...values) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);

      if (text.includes("from workspaces w")) {
        return [
          {
            workspace_id: "ws-1",
            org_id: "org-1",
            workspace_owner_user_id: "user-1",
            org_role: "owner",
            workspace_role: null,
          },
        ];
      }

      if (text.includes("with scoped_runs as")) {
        return [
          {
            total_documents: 3,
            indexed_documents: 3,
            page_indexed_documents: 0,
            searchable_documents: 3,
            in_progress_documents: 0,
            total_pages: 12,
            searchable_pages: 0,
            indexed_chunk_count: 9,
            queued_runs: 0,
            processing_runs: 0,
          },
        ];
      }

      if (
        text.includes("from document_chunks c") &&
        text.includes("websearch_to_tsquery")
      ) {
        const queryValue = values.find(
          (value): value is string =>
            typeof value === "string" &&
            (value.includes("market cap") || value.includes("Bridge via:")),
        );

        if (queryValue?.includes("Bridge via:")) {
          return [
            {
              id: "chunk-2",
              document_id: "doc-2",
              run_id: "run-1",
              chunk_index: 1,
              text: "Acme Corp has a market cap of $40B.",
              heading_path: ["Company overview"],
              page_number: 2,
              token_estimate: 18,
              rank: 1,
              filename: "acme-annual-report.pdf",
              metadata: {},
            },
            {
              id: "chunk-1",
              document_id: "doc-1",
              run_id: "run-1",
              chunk_index: 0,
              text: "Patent X lists Jane Doe as the CEO of Acme Corp.",
              heading_path: ["Patent appendix"],
              page_number: 4,
              token_estimate: 16,
              rank: 2,
              filename: "patents.pdf",
              metadata: {},
            },
          ];
        }

        return [
          {
            id: "chunk-1",
            document_id: "doc-1",
            run_id: "run-1",
            chunk_index: 0,
            text: "Patent X lists Jane Doe as the CEO of Acme Corp.",
            heading_path: ["Patent appendix"],
            page_number: 4,
            token_estimate: 16,
            rank: 1,
            filename: "patents.pdf",
            metadata: {},
          },
        ];
      }

      if (text.includes("progressive_pages")) {
        return [];
      }

      return [];
    });

    const response = await hybridSearch(
      "What is the market cap of the company whose CEO wrote patent X?",
      "user-1",
      {
        filters: { workspaceId: "ws-1" },
        iterativeMultiHop: true,
        queryVector: [0.1, 0.2],
        useRerank: false,
        useMmr: false,
        parentRetrieval: false,
      },
    );

    expect(response.results).toHaveLength(2);
    expect(response.results[0]?.citation.filename).toBe("patents.pdf");
    expect(response.results[1]?.citation.filename).toBe(
      "acme-annual-report.pdf",
    );
    expect(generateOpenRouterText).toHaveBeenCalledTimes(2);

    const insertCall = sqlMock.mock.calls.find(([strings]) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      return text.includes("insert into search_sessions");
    });
    expect(insertCall).toBeDefined();

    const metadataJson = insertCall?.find(
      (value) =>
        typeof value === "string" &&
        value.includes('"retrievalChain"') &&
        value.includes("Bridge via: Acme Corp, Patent X, Jane Doe"),
    );
    expect(metadataJson).toBeDefined();
    expect(metadataJson).toContain('"iterativeMultiHop":true');
    expect(metadataJson).toContain('"chunkIds":["doc-1:0"]');
    expect(metadataJson).toContain('"chunkIds":["doc-2:1"');
  });

  it("records contextual compression usage on the search session", async () => {
    sqlMock.mockReset();
    sqlMock.unsafe.mockReset();
    compressChunks.mockImplementation(
      async (
        _query: string,
        _chunks: unknown[],
        _apiKey: string,
        usage: { record(input: Record<string, unknown>): void },
      ) => {
        usage.record({
          provider: "openrouter",
          model: "openrouter-test",
          metric: "contextual-compression",
          inputTokens: 33,
          outputTokens: 7,
        });
        return [
          {
            id: "chunk-1",
            text: "Compressed acquisition terms.",
            score: 1,
          },
        ];
      },
    );

    sqlMock.mockImplementation(async (strings) => {
      const text = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (text.includes("from workspaces w")) {
        return [
          {
            workspace_id: "ws-1",
            org_id: "org-1",
            workspace_owner_user_id: "user-1",
            org_role: "owner",
            workspace_role: null,
          },
        ];
      }
      if (text.includes("with scoped_runs as")) {
        return [
          {
            total_documents: 1,
            indexed_documents: 1,
            page_indexed_documents: 0,
            searchable_documents: 1,
            in_progress_documents: 0,
            total_pages: 1,
            searchable_pages: 0,
            indexed_chunk_count: 1,
            queued_runs: 0,
            processing_runs: 0,
          },
        ];
      }
      if (
        text.includes("from document_chunks c") &&
        text.includes("websearch_to_tsquery")
      ) {
        return [
          {
            id: "chunk-1",
            document_id: "doc-1",
            run_id: "run-1",
            chunk_index: 0,
            text: "Acquisition terms with a lot of surrounding context.",
            heading_path: [],
            page_number: 1,
            token_estimate: 12,
            rank: 1,
            filename: "ma.pdf",
            metadata: {},
          },
        ];
      }
      if (text.includes("progressive_pages")) {
        return [];
      }
      return [];
    });

    const response = await hybridSearch("acquisition terms", "user-1", {
      filters: { workspaceId: "ws-1" },
      useRerank: false,
      useMmr: false,
      useContextualCompression: true,
      parentRetrieval: false,
      suppressSessionLog: true,
    });

    expect(response.results[0]?.text).toBe("Compressed acquisition terms.");
    expect(response.usageEvents).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        model: "openrouter-test",
        metric: "contextual-compression",
        inputTokens: 33,
        outputTokens: 7,
      }),
    ]);
  });
});
