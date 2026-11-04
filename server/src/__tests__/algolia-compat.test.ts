import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getWorkspaceMock = vi.fn();
const hybridSearchMock = vi.fn();
const getWorkspaceSearchSettingsMock = vi.fn();
const upsertWorkspaceSearchSettingsMock = vi.fn();
const userCanEditWorkspaceSettingsMock = vi.fn();
const sqlMock = vi.fn();

// Scopes carried by the mocked API key; individual tests narrow this to prove the
// compatibility admin surface requires `workspaces:manage` (SEC-2026-10-01).
let keyScopes: string[] = ["search", "workspaces:manage"];

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

vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => null), findWorkspaceForInput: vi.fn(async (ref: { id?: string; slug?: string }) => ({ id: (ref.id ?? ref.slug)!, orgId: "org-1" })),
  getWorkspace: getWorkspaceMock
}));

vi.mock("../services/search.js", () => ({
  hybridSearch: hybridSearchMock
}));

vi.mock("../services/search-controls.js", () => ({
  getWorkspaceSearchSettings: getWorkspaceSearchSettingsMock,
  mutateWorkspaceSearchSettingsForUser: async (args: { workspaceId: string; userId: string; mutate: (current: unknown) => unknown }) => {
    const current = await getWorkspaceSearchSettingsMock(args.workspaceId, args.userId);
    const next = args.mutate(current);
    await upsertWorkspaceSearchSettingsMock(next);
    return next;
  },
  userCanEditWorkspaceSettings: userCanEditWorkspaceSettingsMock
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
    keyScopes = ["search", "workspaces:manage"];
    getWorkspaceMock.mockReset();
    hybridSearchMock.mockReset();
    getWorkspaceSearchSettingsMock.mockReset();
    upsertWorkspaceSearchSettingsMock.mockReset();
    userCanEditWorkspaceSettingsMock.mockReset();
    sqlMock.mockReset();

    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Demo" });
    userCanEditWorkspaceSettingsMock.mockResolvedValue(true);
    getWorkspaceSearchSettingsMock.mockResolvedValue({
      workspaceId: "ws-1",
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
    }));
  });

  it("conceals workspaces outside the API key organization across search and settings", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "foreign", orgId: "org-other", name: "Private" });
    const search = await app.request("/compat/algolia/1/indexes/foreign/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "alpha" }),
    });
    const settings = await app.request("/compat/algolia/1/indexes/foreign/settings");
    expect(search.status).toBe(404);
    expect(settings.status).toBe(404);
    expect(hybridSearchMock).not.toHaveBeenCalled();
    expect(getWorkspaceSearchSettingsMock).not.toHaveBeenCalled();
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

  it("uses page-aware overfetching and trims attributes on single-index search", async () => {
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
      limit: 5,
      filters: expect.objectContaining({
        workspaceId: "ws-1",
        tags: ["finance"],
        mimeTypes: ["application/pdf"],
        pageRange: { from: 3, to: undefined }
      })
    }));

    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.hits).toHaveLength(2);
    expect(body.hits[0]).toEqual({
      objectID: "doc-2:2",
      filename: "doc-2.pdf",
      pageNumber: 3,
      _highlightResult: undefined
    });
    expect(body.nbHits).toBe(5);
    expect(body.nbPages).toBe(3);
    expect(body.exhaustiveNbHits).toBe(false);
    expect(body.facets.filename["doc-0.pdf"]).toBe(1);
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
    }));
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
    expect(hybridSearchMock).toHaveBeenNthCalledWith(1, "alpha", "demo-user", expect.objectContaining({ minScore: 0 }));
    expect(hybridSearchMock).toHaveBeenNthCalledWith(2, "*", "demo-user", expect.objectContaining({ minScore: 0 }));
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
    expect(upsertWorkspaceSearchSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
      synonyms: {
        invoice: ["bill"],
        bill: ["invoice"],
        po: ["purchase order"]
      }
    }));
  });

  it("denies settings/synonyms/rules/import mutations to a key without the workspaces:manage scope", async () => {
    keyScopes = ["search"];
    const auth = { "Content-Type": "application/json", Authorization: "Bearer test" };
    const settings = await app.request("/compat/algolia/1/indexes/ws-1/settings", { method: "PUT", headers: auth, body: JSON.stringify({ hitsPerPage: 20 }) });
    const synonyms = await app.request("/compat/algolia/1/indexes/ws-1/synonyms/batch", { method: "POST", headers: auth, body: JSON.stringify({ synonyms: [{ objectID: "s", type: "synonym", synonyms: ["a", "b"] }] }) });
    const rules = await app.request("/compat/algolia/1/indexes/ws-1/rules/batch", { method: "POST", headers: auth, body: JSON.stringify({ rules: [] }) });
    const imported = await app.request("/compat/algolia/1/import", { method: "POST", headers: auth, body: JSON.stringify({ workspaceId: "ws-1" }) });
    expect([settings.status, synonyms.status, rules.status, imported.status]).toEqual([403, 403, 403, 403]);
    expect(upsertWorkspaceSearchSettingsMock).not.toHaveBeenCalled();
  });

  it("denies mutations when the key owner cannot edit the workspace (viewer regression, SEC-2026-10-01)", async () => {
    userCanEditWorkspaceSettingsMock.mockResolvedValue(false);
    const auth = { "Content-Type": "application/json", Authorization: "Bearer test" };
    const settings = await app.request("/compat/algolia/1/indexes/ws-1/settings", { method: "PUT", headers: auth, body: JSON.stringify({ hitsPerPage: 20 }) });
    const synonyms = await app.request("/compat/algolia/1/indexes/ws-1/synonyms/batch", { method: "POST", headers: auth, body: JSON.stringify({ synonyms: [{ objectID: "s", type: "synonym", synonyms: ["a", "b"] }] }) });
    expect([settings.status, synonyms.status]).toEqual([403, 403]);
    expect(upsertWorkspaceSearchSettingsMock).not.toHaveBeenCalled();
    expect(userCanEditWorkspaceSettingsMock).toHaveBeenCalledWith("ws-1", "demo-user");
  });

  it("imports migration payloads into workspace search settings", async () => {
    const res = await app.request("/compat/algolia/1/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test"
      },
      body: JSON.stringify({
        source: "elastic",
        workspace: "ws-1",
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
    expect(upsertWorkspaceSearchSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
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

  it("counts only search sessions that belong to the requested workspace in analytics", async () => {
    sqlMock.mockResolvedValue([{ queries: 3, zero_results: 1, clicks: 2, conversions: 0 }]);
    const res = await app.request("/compat/algolia/1/indexes/ws-1/analytics/summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queries: 3, zeroResults: 1, clicks: 2, conversions: 0 });

    expect(sqlMock).toHaveBeenCalledTimes(1);
    const [strings, ...values] = sqlMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = strings.join("$").replace(/\s+/g, " ");
    // Sessions without a workspaceId must not fall through into every workspace's totals.
    expect(text).not.toMatch(/coalesce\(\s*s\.metadata/);
    expect(text).toContain("where s.metadata->>'workspaceId' = $");
    expect(text).toContain("a.resource_type = 'workspace'");
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value === "ws-1")).toBe(true);
  });

  it("conceals analytics for workspaces outside the API key organization", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "foreign", orgId: "org-other", name: "Private" });
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
      [{ filters: 'filename:"Q3 AND Q4 report.pdf"' }, { filenameContains: "Q3 AND Q4 report.pdf" }],
      [{ filters: "filenameContains:report" }, { filenameContains: "report" }],
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
      expect(filters).toEqual({ workspaceId: "ws-1", ...expected });
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
      [{ params: "filters=tags%3Aa" }, /params string is not supported/]
    ])("rejects %j with 400 before retrieval", async (body, message) => {
      const res = await search(body);
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload).toMatchObject({ code: "UNSUPPORTED_SEARCH_OPTION", status: 400 });
      expect(payload.message).toMatch(message);
      expect(payload.error).toBe(payload.message);
      expect(hybridSearchMock).not.toHaveBeenCalled();
      expect(getWorkspaceSearchSettingsMock).not.toHaveBeenCalled();
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
      expect(hybridSearchMock.mock.calls[0]![2].filters).toEqual({ workspaceId: "ws-1", tags: ["finance"] });
      expect(hybridSearchMock.mock.calls[1]![2].filters).toEqual({ workspaceId: "ws-1", pageRange: { from: undefined, to: 2 } });
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
  });
});
