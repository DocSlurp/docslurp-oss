import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getProjectMock = vi.fn();
const hybridSearchMock = vi.fn();
const getProjectSearchSettingsMock = vi.fn();
const upsertProjectSearchSettingsMock = vi.fn();
const userCanEditProjectSettingsMock = vi.fn();
const sqlMock = vi.fn();

// Scopes carried by the mocked API key; individual tests narrow this to prove the
// compatibility admin surface requires `projects:manage` (SEC-2026-10-01).
let keyScopes: string[] = ["search:deep", "projects:manage"];

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    json: (value: unknown) => value
  })
}));

vi.mock("../middleware/api-key-auth.js", () => ({
  apiKeyAuth: (async (c: any, next: any) => {
    c.set("apiKey", {
      userId: "demo-user",
      keyId: "key-1",
      orgId: "org-1",
      keyType: "server",
      allowedDomains: [],
      scopes: keyScopes,
      rateLimitRpm: 60,
      rateLimitPpd: 10_000
    });
    await next();
  }) as any,
}));

vi.mock("../services/projects.js", () => ({ resolveProjectRef: vi.fn(async () => null), findProjectForInput: vi.fn(async (ref: { id?: string; slug?: string }) => ({ id: (ref.id ?? ref.slug)!, orgId: "org-1" })),
  getProject: getProjectMock
}));

vi.mock("../services/search.js", () => ({
  hybridSearch: hybridSearchMock
}));

// An in-memory stand-in for the tenant-scoped response cache, off unless a test turns it on.
const responseCache = { on: false, store: new Map<string, unknown>(), tickets: [] as Array<Record<string, unknown>> };
vi.mock("../search/response-cache.js", () => ({
  cacheableApiKeyId: (id: string | null | undefined) => id,
  searchResponseCacheTtlMs: () => (responseCache.on ? 30_000 : 0),
  responseCacheTicket: async (args: Record<string, unknown>) => {
    responseCache.tickets.push(args);
    return { key: JSON.stringify([args.userId, args.apiKeyId, args.projectIds, args.request]) };
  },
  readCachedResponse: (ticket: { key: string }) => responseCache.store.get(ticket.key),
  storeResponse: async (ticket: { key: string }, data: unknown) => { responseCache.store.set(ticket.key, data); },
}));

vi.mock("../services/search-controls.js", () => ({
  getProjectSearchSettings: getProjectSearchSettingsMock,
  mutateProjectSearchSettingsForUser: async (args: { projectId: string; userId: string; mutate: (current: unknown) => unknown }) => {
    const current = await getProjectSearchSettingsMock(args.projectId, args.userId);
    const next = args.mutate(current);
    await upsertProjectSearchSettingsMock(next);
    return next;
  },
  userCanEditProjectSettings: userCanEditProjectSettingsMock
}));

const { algoliaCompatRoutes } = await import("../routes/algolia-compat.js");

function makeResult(index: number, filename = `doc-${index}.pdf`) {
  return {
    text: `alpha ${index}`,
    score: 1 - index * 0.01,
    citation: {
      documentId: `doc-${index}`,
      filename,
      pageNumber: index + 1,
      pageNumbers: [index + 1],
      headingPath: [`H${index}`],
      chunkIndex: index,
      blockIds: [],
      blockTypes: ["paragraph"],
      evidenceType: "text",
      canonicalDocumentUri: null,
      regionBoxes: [],
      regionCoordinateSpace: null
    }
  };
}

function buildApp() {
  const app = new Hono();
  app.route("/compat/algolia", algoliaCompatRoutes);
  return app;
}

describe("algolia compat", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    keyScopes = ["search:deep", "projects:manage"];
    getProjectMock.mockReset();
    hybridSearchMock.mockReset();
    getProjectSearchSettingsMock.mockReset();
    upsertProjectSearchSettingsMock.mockReset();
    userCanEditProjectSettingsMock.mockReset();
    sqlMock.mockReset();

    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Demo" });
    userCanEditProjectSettingsMock.mockResolvedValue(true);
    getProjectSearchSettingsMock.mockResolvedValue({
      projectId: "ws-1",
      userId: "demo-user",
      typoTolerance: true,
      dedupeByFilename: true,
      rankingRules: {},
      boosts: { byMime: {} },
      pinnedResults: [],
      synonyms: { invoice: ["bill"] },
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
        selfQuery: false
      },
      chat: {
        mode: "retrieval",
        answerStyle: "balanced",
        citations: true,
        searchInstructions: null
      },
      compatSettings: { hitsPerPage: 12, attributesForFaceting: ["filterOnly(filename)"] },
      rules: [{ objectID: "rule-1", condition: { pattern: "invoice" } }],
      compatMetadata: {}
    });
    hybridSearchMock.mockResolvedValue({
      sessionId: "session-1",
      results: [
        makeResult(0, "a.pdf")
      ]
    });
  });

  it.each([null, { query: {} }, { query: "alpha", page: -1 }, { query: "alpha", hitsPerPage: 1.5 }])("rejects malformed queries before invoking search: %j", async (payload) => {
    const response = await app.request("/compat/algolia/1/indexes/ws-1/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
    expect(hybridSearchMock).not.toHaveBeenCalled();
  });

  it.each([null, { requests: [null] }, { requests: [{ indexName: "ws-1", query: {} }] }, { requests: Array.from({ length: 11 }, () => ({ indexName: "ws-1", query: "alpha" })) }])("rejects malformed batches before invoking search: %j", async (payload) => {
    const response = await app.request("/compat/algolia/1/indexes/*/queries", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
    expect(hybridSearchMock).not.toHaveBeenCalled();
  });

  it("reports observed search time and keeps batch retrieval free of optional AI helpers", async () => {
    hybridSearchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { sessionId: "session-1", results: [makeResult(0)] };
    });
    const response = await app.request("/compat/algolia/1/indexes/*/queries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ indexName: "ws-1", query: "alpha" }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].processingTimeMS).toBeGreaterThan(0);
    expect(hybridSearchMock).toHaveBeenCalledWith("alpha", "demo-user", expect.objectContaining({
      useHyDE: false, useRerank: false, queryRewrite: false, queryDecompose: false,
      useContextualCompression: false, stepback: false,
    }), expect.objectContaining({ orgId: expect.any(String) }));
  });

  it("conceals projects outside the API key organization across search and settings", async () => {
    getProjectMock.mockResolvedValue({ id: "foreign", orgId: "org-other", name: "Private" });
    const search = await app.request("/compat/algolia/1/indexes/foreign/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "alpha" }),
    });
    const settings = await app.request("/compat/algolia/1/indexes/foreign/settings");
    expect(search.status).toBe(404);
    expect(settings.status).toBe(404);
    expect(hybridSearchMock).not.toHaveBeenCalled();
    expect(getProjectSearchSettingsMock).not.toHaveBeenCalled();
  });

  it("maps a basic search request to hybridSearch and shapes Algolia-like response", async () => {
    const res = await app.request("/compat/algolia/1/indexes/ws-1/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test"
      },
      body: JSON.stringify({ query: "alpha", hitsPerPage: 5, page: 0, facets: ["filename"] })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits.length).toBe(1);
    expect(body.hits[0].objectID).toBe("doc-0:0");
    expect(body.nbHits).toBe(1);
    expect(body.page).toBe(0);
    expect(body.hitsPerPage).toBe(5);
    expect(body.queryID).toBe("session-1");
    expect(body.facets.filename["a.pdf"]).toBe(1);
  });

  it("highlights the words the query matched, not a placeholder", async () => {
    hybridSearchMock.mockResolvedValue({
      sessionId: "session-1",
      results: [{ ...makeResult(0, "Müller-Report.pdf"), text: "The Müller fee schedule: fees for Gebühren." }],
    });
    const res = await app.request("/compat/algolia/1/indexes/ws-1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ query: "muller fee", highlightPreTag: "<em>", highlightPostTag: "</em>" }),
    });
    const body = await res.json();
    expect(body.hits[0]._highlightResult.text).toEqual({
      value: "The <em>Müller</em> <em>fee</em> schedule: fees for Gebühren.",
      matchLevel: "full",
      matchedWords: ["muller", "fee"],
      fullyHighlighted: false,
    });
    expect(body.hits[0]._highlightResult.filename.value).toBe("<em>Müller</em>-Report.pdf");
  });

  it("serves the next pages of a result list from one search instead of re-running it", async () => {
    responseCache.on = true;
    responseCache.store.clear();
    responseCache.tickets.length = 0;
    hybridSearchMock.mockReset();
    hybridSearchMock.mockResolvedValue({
      sessionId: "session-1",
      availability: { status: "complete" },
      results: Array.from({ length: 30 }, (_, index) => makeResult(index)),
    });
    try {
      const page = async (n: number, query = "alpha") => (await app.request("/compat/algolia/1/indexes/ws-1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ query, hitsPerPage: 10, page: n }),
      })).json();
      const first = await page(0);
      const second = await page(1);
      const third = await page(2);
      expect(hybridSearchMock).toHaveBeenCalledTimes(1);
      expect([first, second, third].map((body) => body.hits[0].objectID)).toEqual(["doc-0:0", "doc-10:10", "doc-20:20"]);
      // The cache key carries the caller, the key and the project: a different query is a different search.
      await page(0, "beta");
      expect(hybridSearchMock).toHaveBeenCalledTimes(2);
      expect(responseCache.tickets[0]).toMatchObject({ userId: "demo-user", apiKeyId: "key-1", projectIds: ["ws-1"] });
    } finally {
      responseCache.on = false;
    }
  });

  it("retrieves a 100-passage window, reports the passages found in it and trims attributes on single-index search", async () => {
    hybridSearchMock.mockResolvedValue({
      sessionId: "session-1",
      results: [makeResult(0), makeResult(1), makeResult(2), makeResult(3), makeResult(4)]
    });

    const res = await app.request("/compat/algolia/1/indexes/ws-1/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test"
      },
      body: JSON.stringify({
        query: "alpha",
        hitsPerPage: 2,
        page: 1,
        attributesToRetrieve: ["filename", "pageNumber"],
        facetFilters: [["tag:finance"], "mime_type:application/pdf"],
        numericFilters: ["pageNumber>=3"],
        facets: ["filename"]
      })
    });

    expect(res.status).toBe(200);
    expect(hybridSearchMock).toHaveBeenCalledWith("alpha", "demo-user", expect.objectContaining({
      limit: 100,
      filters: expect.objectContaining({
        projectId: "ws-1",
        tags: ["finance"],
        mimeTypes: ["application/pdf"],
        pageRange: { from: 3, to: undefined }
      })
    }), expect.objectContaining({ orgId: expect.any(String) }));

    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.hits).toHaveLength(2);
    expect(body.hits[0]).toEqual({
      objectID: "doc-2:2",
      filename: "doc-2.pdf",
      pageNumber: 3,
      _highlightResult: undefined
    });
    // Five passages came back from a window of 100, so the window was not full: that is the whole result set.
    expect(body.nbHits).toBe(5);
    expect(body.nbPages).toBe(3);
    expect(body.exhaustiveNbHits).toBe(true);
    expect(body.facets.filename["doc-0.pdf"]).toBe(1);
  });

  it("reports a full window as a floor, never inventing one more hit", async () => {
    hybridSearchMock.mockResolvedValue({
      sessionId: "session-1",
      results: Array.from({ length: 100 }, (_, index) => makeResult(index))
    });
    const res = await app.request("/compat/algolia/1/indexes/ws-1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ query: "alpha", hitsPerPage: 10, page: 0 })
    });
    const body = await res.json();
    expect(body.hits).toHaveLength(10);
    expect(body.nbHits).toBe(100);
    expect(body.nbPages).toBe(10);
    expect(body.exhaustiveNbHits).toBe(false);
    // A deeper page widens the window instead of reading past it: 201 passages are needed, fetched as the next
    // stable bucket (400) so later pages share the same cached search.
    await app.request("/compat/algolia/1/indexes/ws-1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ query: "alpha", hitsPerPage: 50, page: 3 })
    });
    expect(hybridSearchMock).toHaveBeenLastCalledWith("alpha", "demo-user", expect.objectContaining({ limit: 400 }), expect.objectContaining({ orgId: expect.any(String) }));
  });

  it.each([null, { query: {} }, { facetQuery: 1 }, { maxFacetHits: -1 }])("rejects invalid facet requests before retrieval: %j", async (payload) => {
    const response = await app.request("/compat/algolia/1/indexes/ws-1/facets/filename/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
    expect(hybridSearchMock).not.toHaveBeenCalled();
  });

  it("supports facet value search for filename", async () => {
    hybridSearchMock.mockResolvedValue({
      sessionId: "session-1",
      results: [
        makeResult(0, "alpha-report.pdf"),
        makeResult(1, "alpha-report.pdf"),
        makeResult(2, "beta-notes.pdf")
      ]
    });

    const res = await app.request("/compat/algolia/1/indexes/ws-1/facets/filename/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test"
      },
      body: JSON.stringify({
        facetQuery: "alpha",
        query: "invoice",
        maxFacetHits: 5
      })
    });

    expect(res.status).toBe(200);
    expect(hybridSearchMock).toHaveBeenCalledWith("invoice", "demo-user", expect.objectContaining({
      limit: 50
    }), expect.objectContaining({ orgId: expect.any(String) }));
    const body = await res.json();
    expect(body.exhaustiveFacetsCount).toBe(true);
    expect(body.facetHits).toEqual([
      {
        value: "alpha-report.pdf",
        highlighted: "alpha-report.pdf",
        count: 2
      }
    ]);
  });

  it("does not apply the relevance floor to the facet wildcard query, but keeps it for a typed query", async () => {
    hybridSearchMock.mockResolvedValue({ sessionId: "session-1", results: [makeResult(0, "alpha-report.pdf")] });
    const post = (payload: Record<string, unknown>) => app.request("/compat/algolia/1/indexes/ws-1/facets/filename/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify(payload),
    });
    await post({ facetQuery: "alpha" });
    await post({});
    expect(hybridSearchMock).toHaveBeenNthCalledWith(1, "alpha", "demo-user", expect.objectContaining({ minScore: 0 }), expect.objectContaining({ orgId: expect.any(String) }));
    expect(hybridSearchMock).toHaveBeenNthCalledWith(2, "*", "demo-user", expect.objectContaining({ minScore: 0 }), expect.objectContaining({ orgId: expect.any(String) }));
    await post({ facetQuery: "alpha", query: "invoice" });
    expect(hybridSearchMock.mock.calls[2]![2]).not.toHaveProperty("minScore");
  });

  it("applies page semantics in multiple queries responses", async () => {
    hybridSearchMock.mockResolvedValue({
      sessionId: "session-1",
      results: [makeResult(0), makeResult(1), makeResult(2), makeResult(3)]
    });

    const res = await app.request("/compat/algolia/1/indexes/*/queries", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test"
      },
      body: JSON.stringify({
        requests: [
          {
            indexName: "ws-1",
            query: "alpha",
            page: 1,
            hitsPerPage: 2,
            attributesToRetrieve: ["filename"]
          }
        ]
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].hits).toEqual([
      { objectID: "doc-2:2", filename: "doc-2.pdf", _highlightResult: undefined },
      { objectID: "doc-3:3", filename: "doc-3.pdf", _highlightResult: undefined }
    ]);
    expect(body.results[0].nbHits).toBe(4);
    expect(body.results[0].nbPages).toBe(2);
  });

  it("returns persisted compatibility settings", async () => {
    const res = await app.request("/compat/algolia/1/indexes/ws-1/settings", {
      headers: {
        Authorization: "Bearer test"
      }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hitsPerPage).toBe(12);
    expect(body.attributesForFaceting).toContain("filterOnly(filename)");
  });

  it("updates synonyms through the batch endpoint", async () => {
    const res = await app.request("/compat/algolia/1/indexes/ws-1/synonyms/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test"
      },
      body: JSON.stringify({
        synonyms: [
          { objectID: "syn-1", type: "synonym", synonyms: ["invoice", "bill"] },
          { objectID: "syn-2", type: "oneWaySynonym", input: "po", synonyms: ["purchase order"] }
        ]
      })
    });

    expect(res.status).toBe(200);
    expect(upsertProjectSearchSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
      synonyms: {
        invoice: ["bill"],
        bill: ["invoice"],
        po: ["purchase order"]
      }
    }));
  });

  it("denies settings/synonyms/rules/import mutations to a key without the projects:manage scope", async () => {
    keyScopes = ["search:deep"];
    const auth = { "Content-Type": "application/json", Authorization: "Bearer test" };
    const settings = await app.request("/compat/algolia/1/indexes/ws-1/settings", { method: "PUT", headers: auth, body: JSON.stringify({ hitsPerPage: 20 }) });
    const synonyms = await app.request("/compat/algolia/1/indexes/ws-1/synonyms/batch", { method: "POST", headers: auth, body: JSON.stringify({ synonyms: [{ objectID: "s", type: "synonym", synonyms: ["a", "b"] }] }) });
    const rules = await app.request("/compat/algolia/1/indexes/ws-1/rules/batch", { method: "POST", headers: auth, body: JSON.stringify({ rules: [] }) });
    const imported = await app.request("/compat/algolia/1/import", { method: "POST", headers: auth, body: JSON.stringify({ projectId: "ws-1" }) });
    expect([settings.status, synonyms.status, rules.status, imported.status]).toEqual([403, 403, 403, 403]);
    expect(upsertProjectSearchSettingsMock).not.toHaveBeenCalled();
  });

  it("denies mutations when the key owner cannot edit the project (viewer regression, SEC-2026-10-01)", async () => {
    userCanEditProjectSettingsMock.mockResolvedValue(false);
    const auth = { "Content-Type": "application/json", Authorization: "Bearer test" };
    const settings = await app.request("/compat/algolia/1/indexes/ws-1/settings", { method: "PUT", headers: auth, body: JSON.stringify({ hitsPerPage: 20 }) });
    const synonyms = await app.request("/compat/algolia/1/indexes/ws-1/synonyms/batch", { method: "POST", headers: auth, body: JSON.stringify({ synonyms: [{ objectID: "s", type: "synonym", synonyms: ["a", "b"] }] }) });
    expect([settings.status, synonyms.status]).toEqual([403, 403]);
    expect(upsertProjectSearchSettingsMock).not.toHaveBeenCalled();
    expect(userCanEditProjectSettingsMock).toHaveBeenCalledWith("ws-1", "demo-user");
  });

  it("imports migration payloads into project search settings", async () => {
    const res = await app.request("/compat/algolia/1/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test"
      },
      body: JSON.stringify({
        source: "elastic",
        project: "ws-1",
        settings: {
          searchableAttributes: ["body", "title"]
        },
        schema: {
          properties: {
            body: { type: "text" },
            title: { type: "text" }
          }
        },
        metadata: {
          alias: "legal-search"
        }
      })
    });

    expect(res.status).toBe(201);
    expect(upsertProjectSearchSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
      compatSettings: expect.objectContaining({
        searchableAttributes: ["body", "title"]
      }),
      compatMetadata: expect.objectContaining({
        source: "elastic",
        schema: {
          properties: {
            body: { type: "text" },
            title: { type: "text" }
          }
        },
        metadata: {
          alias: "legal-search"
        }
      })
    }));
    const body = await res.json();
    expect(body.imported.schemaFields).toBe(2);
  });

  it("counts only search sessions that belong to the requested project in analytics", async () => {
    sqlMock.mockResolvedValue([{ queries: 3, zero_results: 1, clicks: 2, conversions: 0 }]);
    const res = await app.request("/compat/algolia/1/indexes/ws-1/analytics/summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queries: 3, zeroResults: 1, clicks: 2, conversions: 0 });

    expect(sqlMock).toHaveBeenCalledTimes(1);
    const [strings, ...values] = sqlMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = strings.join("$").replace(/\s+/g, " ");
    // Sessions without a projectId must not fall through into every project's totals.
    expect(text).not.toMatch(/coalesce\(\s*s\.metadata/);
    expect(text).toContain("where s.project_id = $");
    expect(text).toContain("a.resource_type = 'project'");
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value === "ws-1")).toBe(true);
  });

  it("conceals analytics for projects outside the API key organization", async () => {
    getProjectMock.mockResolvedValue({ id: "foreign", orgId: "org-other", name: "Private" });
    const res = await app.request("/compat/algolia/1/indexes/foreign/analytics/summary");
    expect(res.status).toBe(404);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  describe("strict filter translation", () => {
    const search = (body: Record<string, unknown>) => app.request("/compat/algolia/1/indexes/ws-1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ query: "alpha", ...body })
    });

    it.each([
      [{ filters: "tags:finance" }, { tags: ["finance"] }],
      [{ filters: "tag:finance AND mime_type:application/pdf" }, { tags: ["finance"], mimeTypes: ["application/pdf"] }],
      [{ filters: "mimeType:text/plain" }, { mimeTypes: ["text/plain"] }],
      [{ filters: 'filename:"Q3 AND Q4 report.pdf"' }, { filenameEquals: "Q3 AND Q4 report.pdf" }],
      [{ filters: "filenameContains:report" }, { filenameContains: "report" }],
      [{ facetFilters: ["filename:%"] }, { filenameEquals: "%" }],
      [{ facetFilters: ["filenameContains:report_1", "filename:report_1.pdf"] }, { filenameContains: "report_1", filenameEquals: "report_1.pdf" }],
      [{ numericFilters: ["page<=2147483647", "page>=-2147483647"] }, { pageRange: { from: -2147483647, to: 2147483647 } }],
      [{ tagFilters: [[]], ruleContexts: [], enableRules: false }, {}],
      [{ tagFilters: [""] }, {}],
      [{ type: "default" }, {}],
      [{ typoTolerance: true, allowTyposOnNumericTokens: true, decompoundQuery: true, minWordSizefor1Typo: 3, minWordSizefor2Typos: 8 }, {}],
      [{ ignorePlurals: true, removeStopWords: ["en"], queryLanguages: ["en"], naturalLanguages: ["en"], keepDiacriticsOnCharacters: "" }, {}],
      [{ facetFilters: ["filename:" + "a".repeat(255)] }, { filenameEquals: "a".repeat(255) }],
      [{ tagFilters: [[""]] }, {}],
      [{ facetFilters: ["tags:a" + " ".repeat(900) + "b"] }, { tags: ["a" + " ".repeat(900) + "b"] }],
      [{ filters: "language:en and heading:Intro/Scope" }, { language: "en", headingPath: ["Intro", "Scope"] }],
      [{ filters: "documentId:doc-1 AND runId:run-1" }, { documentId: "doc-1", runId: "run-1" }],
      [{ filters: "(tags:a OR tags:b) AND language:en" }, { tags: ["a", "b"], language: "en" }],
      [{ filters: "tags:a OR tags:b" }, { tags: ["a", "b"] }],
      [{ filters: 'tags:"a,b"' }, { tags: ["a,b"] }],
      [{ filters: "page > 2 AND page:1 TO 10" }, { pageRange: { from: 3, to: 10 } }],
      [{ filters: "" }, {}],
      [{ facetFilters: [["tags:a", "tags:b"], "language:en"] }, { tags: ["a", "b"], language: "en" }],
      [{ facetFilters: ["tags:\\-draft"] }, { tags: ["-draft"] }],
      [{ facetFilters: "documentId:doc-9" }, { documentId: "doc-9" }],
      [{ facetFilters: ["tags:a"], filters: "tags:a" }, { tags: ["a"] }],
      [{ numericFilters: ["page>=2", "page<5"] }, { pageRange: { from: 2, to: 4 } }],
      [{ numericFilters: [["page_number=7"]] }, { pageRange: { from: 7, to: 7 } }],
      [{ numericFilters: "pageNumber <= 3" }, { pageRange: { from: undefined, to: 3 } }],
      [{ tagFilters: [], aroundLatLngViaIP: false, optionalFilters: ["tags:x"] }, {}]
    ])("applies supported filters %j", async (body, expected) => {
      const res = await search(body);
      expect(res.status).toBe(200);
      const filters = hybridSearchMock.mock.calls[0]![2].filters;
      expect(filters).toEqual({ projectId: "ws-1", ...expected });
    });

    it.each([
      [{ filters: "brand:acme" }, /Unsupported filter attribute "brand"/],
      [{ facetFilters: ["owner:user-1"] }, /Unsupported filter attribute "owner"/],
      [{ filters: "constructor:x" }, /Unsupported filter attribute "constructor"/],
      [{ facetFilters: ["__proto__:x"] }, /Unsupported filter attribute "__proto__"/],
      [{ facetFilters: [["tags:a", "language:en"]] }, /OR is only supported between values of one tags or mime_type/],
      [{ filters: "language:en OR language:fr" }, /OR is only supported/],
      [{ filters: "tags:a AND tags:b" }, /tags may appear in only one AND clause/],
      [{ facetFilters: ["documentId:a", "documentId:b"] }, /documentId may only be filtered by one value/],
      [{ filters: "language:en AND tags:a OR tags:b" }, /combine AND and OR with parentheses/],
      [{ filters: "NOT tags:secret" }, /NOT/],
      [{ filters: "tags:a AND NOT documentId:x" }, /NOT/],
      [{ facetFilters: ["tags:-secret"] }, /negation is not supported/],
      [{ filters: "(tags:a AND tags:b)" }, /AND inside parentheses/],
      [{ filters: "((tags:a))" }, /expected a clause/],
      [{ filters: "tags:a tags:b" }, /quote values that contain spaces/],
      [{ filters: 'tags:"unterminated' }, /unterminated quote/],
      [{ filters: "tags:" }, /empty value/],
      [{ filters: "tags:a AND" }, /expected a clause/],
      [{ filters: "tags:a)" }, /unexpected/],
      [{ filters: "secret" }, /expected attribute:value/],
      [{ numericFilters: ["price>10"] }, /Unsupported numeric filter attribute "price"/],
      [{ filters: "price > 10" }, /Unsupported numeric filter attribute "price"/],
      [{ numericFilters: ["page!=3"] }, /Unsupported numeric operator "!="/],
      [{ numericFilters: [["page=1", "page=3"]] }, /cannot be combined with OR/],
      [{ numericFilters: ["page>=x"] }, /must be integers/],
      [{ numericFilters: ["tags:a"] }, /Only page supports numeric filters/],
      [{ facetFilters: [123] }, /every clause must be a string/],
      [{ facetFilters: { tags: "a" } }, /expected an array/],
      [{ facetFilters: [[]] }, /must not be empty/],
      [{ facetFilters: "tags:a,tags:b" }, /legacy comma syntax/],
      [{ tagFilters: ["finance"] }, /tagFilters is not supported/],
      [{ aroundLatLng: "40.7,-74" }, /aroundLatLng is not supported/],
      [{ insideBoundingBox: [[1, 2, 3, 4]] }, /insideBoundingBox is not supported/],
      [{ restrictSearchableAttributes: ["filename"] }, /restrictSearchableAttributes is not supported/],
      [{ params: "filters=tags%3Aa" }, /params string is not supported/],
      [{ tagFilters: [["finance"]] }, /tagFilters is not supported/],
      [{ ruleContexts: ["vip"] }, /ruleContexts is not supported/],
      [{ filters: 5 }, /expected a string/],
      [{ filters: ["tags:a"] }, /expected a string/],
      [{ numericFilters: ["page>2147483647"] }, /out of range/],
      [{ numericFilters: ["page=2147483648"] }, /out of range/],
      [{ filters: "page < -2147483647" }, /out of range/],
      [{ numericFilters: ["page>=99999999999999999999"] }, /must be integers/],
      [{ facetfilters: ["tags:a"] }, /Unsupported search parameter "facetfilters"/],
      [{ Filters: "tags:a" }, /Unsupported search parameter "Filters"/],
      [{ filter: "tags:a" }, /Unsupported search parameter "filter"/],
      [{ numericfilter: ["page>1"] }, /Unsupported search parameter "numericfilter"/],
      [{ advancedSyntax: true }, /Unsupported search parameter "advancedSyntax"/],
      [{ offset: 0, length: 5 }, /Unsupported search parameter "offset"/],
      [{ similarQuery: "alpha" }, /Unsupported search parameter "similarQuery"/],
      [{ distinct: true }, /Unsupported search parameter "distinct"/],
      [{ ["x".repeat(5000)]: 1 }, /Unsupported search parameter "x{200}…"/],
      [{ facetFilters: ["o".repeat(5000) + ":v"] }, /exceeds 1024 characters/],
      [{ filters: "o".repeat(900) + ":v" }, /Unsupported filter attribute "o{200}…"/],
      [{ filters: "tags:a AND ".repeat(1000) + "tags:a" }, /exceeds 8192 bytes/],
      [{ filters: Array.from({ length: 101 }, () => "tags:a").join(" AND ") }, /at most 100 clauses/],
      [{ facetFilters: Array.from({ length: 101 }, () => "tags:a") }, /at most 100 entries/],
      [{ facetFilters: [Array.from({ length: 60 }, () => "tags:a"), Array.from({ length: 60 }, () => "tags:a")] }, /at most 100 clauses/],
      [{ type: "facet" }, /Unsupported request type "facet"/],
      [{ tagFilters: [[["finance"]]] }, /tagFilters: arrays nest at most 2 levels/],
      [{ facetFilters: ["filename:" + "a".repeat(256)] }, /filename values are at most 255 characters/],
      [{ filters: "filenameContains:" + "a".repeat(256) }, /filenameContains values are at most 255 characters/],
      [{ typoTolerance: false }, /typoTolerance=.*restricts which results match/],
      [{ typoTolerance: "strict" }, /typoTolerance=/],
      [{ typoTolerance: "min" }, /typoTolerance=/],
      [{ allowTyposOnNumericTokens: false }, /allowTyposOnNumericTokens=/],
      [{ decompoundQuery: false }, /decompoundQuery=/],
      [{ minWordSizefor1Typo: 5 }, /minWordSizefor1Typo=/],
      [{ minWordSizefor2Typos: 9 }, /minWordSizefor2Typos=/],
      [{ ignorePlurals: "yes" }, /ignorePlurals=/],
      [{ keepDiacriticsOnCharacters: "éø" }, /keepDiacriticsOnCharacters is not supported/]
    ])("rejects %j with 400 before retrieval", async (body, message) => {
      const res = await search(body);
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload).toMatchObject({ code: "UNSUPPORTED_SEARCH_OPTION", status: 400 });
      expect(payload.message).toMatch(message);
      expect(payload.error).toBe(payload.message);
      expect(hybridSearchMock).not.toHaveBeenCalled();
      expect(getProjectSearchSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects the whole batch when any request has an unsupported filter", async () => {
      const res = await app.request("/compat/algolia/1/indexes/*/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ requests: [
          { indexName: "ws-1", query: "alpha", filters: "tags:finance" },
          { indexName: "ws-1", query: "beta", filters: "NOT tags:secret" }
        ] })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.code).toBe("UNSUPPORTED_SEARCH_OPTION");
      expect(payload.message).toMatch(/^requests\[1\]: .*NOT/);
      expect(hybridSearchMock).not.toHaveBeenCalled();
    });

    it("applies each request's filters in a valid batch", async () => {
      const res = await app.request("/compat/algolia/1/indexes/*/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ requests: [
          { indexName: "ws-1", query: "alpha", filters: "tags:finance" },
          { indexName: "ws-1", query: "beta", numericFilters: ["page<=2"] }
        ] })
      });
      expect(res.status).toBe(200);
      expect(hybridSearchMock.mock.calls[0]![2].filters).toEqual({ projectId: "ws-1", tags: ["finance"] });
      expect(hybridSearchMock.mock.calls[1]![2].filters).toEqual({ projectId: "ws-1", pageRange: { from: undefined, to: 2 } });
    });

    it("rejects unsupported filters on facet value search before retrieval", async () => {
      const res = await app.request("/compat/algolia/1/indexes/ws-1/facets/filename/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ facetQuery: "a", facetFilters: ["owner:user-1"], tagFilters: ["x"] })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("UNSUPPORTED_SEARCH_OPTION");
      expect(hybridSearchMock).not.toHaveBeenCalled();
    });

    it("rejects whitespace-padded clauses in linear time (regex backtracking regression)", async () => {
      const { parseAlgoliaCompatFilters } = await import("../search/algolia-compat-filters.js");
      const padding = " ".repeat(200_000);
      const cases: Record<string, unknown>[] = [
        { facetFilters: [`tags:a${padding}b`] },
        { facetFilters: [`page:${padding}1`] },
        { numericFilters: [`page${padding}>${padding}1`] },
        { filters: `filename:"a${padding}b"` },
        { filters: `tags:a${padding}AND${padding}tags:b` },
      ];
      for (const body of cases) {
        const started = performance.now();
        expect(() => parseAlgoliaCompatFilters(body)).toThrow(/exceeds/);
        expect(performance.now() - started).toBeLessThan(50);
      }
      // Under the caps, a long whitespace run still parses quickly.
      const started = performance.now();
      for (let i = 0; i < 100; i++) parseAlgoliaCompatFilters({ facetFilters: [`tags:a${" ".repeat(1000)}`, `page:${" ".repeat(1000)}1`] });
      expect(performance.now() - started).toBeLessThan(50);

      const res = await search({ facetFilters: [`tags:a${padding}b`] });
      expect(res.status).toBe(400);
      expect(hybridSearchMock).not.toHaveBeenCalled();
    });

    it("rejects request bodies over 1 MB before parsing", async () => {
      const res = await search({ facetFilters: ["tags:" + "a".repeat(1024 * 1024)] });
      expect(res.status).toBe(413);
      expect(hybridSearchMock).not.toHaveBeenCalled();
    });

    // What react-instantsearch (v7) / instantsearch.js (v4) send for a search box, refinement list and pagination.
    const instantSearchParams = {
      query: "alpha",
      facets: ["tags"],
      tagFilters: "",
      facetFilters: [["tags:finance", "tags:legal"]],
      highlightPreTag: "__ais-highlight__",
      highlightPostTag: "__/ais-highlight__",
      hitsPerPage: 20,
      page: 0,
      maxValuesPerFacet: 10,
      analytics: true,
      analyticsTags: ["web"],
      clickAnalytics: true,
      userToken: "anonymous-1",
      getRankingInfo: false,
      attributesToSnippet: ["text:20"],
      snippetEllipsisText: "…",
      attributesToHighlight: ["text"],
      responseFields: ["*"],
      enableRules: false,
      aroundLatLngViaIP: false
    };

    it("accepts a realistic InstantSearch request on single and batch routes", async () => {
      const single = await search(instantSearchParams);
      expect(single.status).toBe(200);
      const batch = await app.request("/compat/algolia/1/indexes/*/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ requests: [
          { indexName: "ws-1", type: "default", ...instantSearchParams },
          { indexName: "ws-1", ...instantSearchParams, facetFilters: [], facets: [], hitsPerPage: 0 + 1, analytics: false }
        ] })
      });
      expect(batch.status).toBe(200);
      for (const call of hybridSearchMock.mock.calls.slice(0, 2)) expect(call[2].filters).toEqual({ projectId: "ws-1", tags: ["finance", "legal"] });
      expect(hybridSearchMock.mock.calls[2]![2].filters).toEqual({ projectId: "ws-1" });
    });

    it.each([
      [{ tagFilters: ["finance"] }, /requests\[1\]: tagFilters is not supported/],
      [{ aroundLatLng: "40.7,-74" }, /requests\[1\]: aroundLatLng is not supported/],
      [{ facetfilters: ["tags:a"] }, /requests\[1\]: Unsupported search parameter "facetfilters"/],
      [{ type: "facet" }, /requests\[1\]: Unsupported request type "facet"/]
    ])("rejects a batch whose second request has %j", async (extra, message) => {
      const res = await app.request("/compat/algolia/1/indexes/*/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ requests: [
          { indexName: "ws-1", query: "alpha", facetFilters: [["tags:a", "tags:b"]] },
          { indexName: "ws-1", query: "beta", ...extra }
        ] })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload).toMatchObject({ code: "UNSUPPORTED_SEARCH_OPTION", status: 400 });
      expect(payload.message).toMatch(message);
      expect(hybridSearchMock).not.toHaveBeenCalled();
    });

    it("rejects unknown keys and non-string filters on facet value search with the unified envelope", async () => {
      for (const body of [{ facetQuery: "a", facetfilters: ["tags:a"] }, { facetQuery: "a", filters: 5 }]) {
        const res = await app.request("/compat/algolia/1/indexes/ws-1/facets/filename/query", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
          body: JSON.stringify(body)
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: "UNSUPPORTED_SEARCH_OPTION", status: 400 });
      }
      expect(hybridSearchMock).not.toHaveBeenCalled();
    });

    it("rejects deeply nested arrays with a 400 instead of overflowing the stack", async () => {
      const { parseAlgoliaCompatFilters } = await import("../search/algolia-compat-filters.js");
      let nested: unknown = [];
      for (let i = 0; i < 400_000; i++) nested = [nested];
      const started = performance.now();
      expect(() => parseAlgoliaCompatFilters({ tagFilters: nested })).toThrow(/nest at most 2 levels/);
      expect(performance.now() - started).toBeLessThan(50);

      const deepJson = `{"query":"alpha","tagFilters":${"[".repeat(400_000)}${"]".repeat(400_000)}}`;
      const res = await app.request("/compat/algolia/1/indexes/ws-1/query", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test" }, body: deepJson
      });
      expect(res.status).toBe(400);
      expect(hybridSearchMock).not.toHaveBeenCalled();
    });

    it("accepts type default on the single, facet and batch routes", async () => {
      const headers = { "Content-Type": "application/json", Authorization: "Bearer test" };
      expect((await search({ type: "default" })).status).toBe(200);
      expect((await app.request("/compat/algolia/1/indexes/ws-1/facets/filename/query", { method: "POST", headers, body: JSON.stringify({ facetQuery: "a", type: "default" }) })).status).toBe(200);
      expect((await app.request("/compat/algolia/1/indexes/*/queries", { method: "POST", headers, body: JSON.stringify({ requests: [{ indexName: "ws-1", query: "alpha", type: "default" }] }) })).status).toBe(200);
      const facet = await app.request("/compat/algolia/1/indexes/ws-1/facets/filename/query", { method: "POST", headers, body: JSON.stringify({ facetQuery: "a", type: "facet" }) });
      expect(facet.status).toBe(400);
    });
  });
});
