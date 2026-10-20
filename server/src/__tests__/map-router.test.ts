import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: unknown[] = [];
const sqlMock = Object.assign(
  vi.fn(async () => rows),
  { array: (values: unknown[]) => values },
);
vi.mock("../db.js", () => ({ sql: sqlMock }));
vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: vi.fn(), SEARCH_OPENROUTER_MODEL: "test/model" }));

const { locateMapCandidates, ROUTER_AUTO_MARGIN } = await import("../search/deferred/map-locator.js");
const { parseRouterNodeIds, createMapRouterCall } = await import("../search/deferred/map-router.js");
const ai = await import("../lib/ai.js");

function node(id: string, title: string, start: number, end: number, parentId: string | null = null) {
  return { id, title, level: parentId ? 2 : 1, parentId, physicalStart: start, physicalEnd: end, source: "toc", confidence: 1 };
}

beforeEach(() => {
  rows.length = 0;
  sqlMock.mockClear();
  rows.push({
    document_id: "doc-1",
    rank: 1,
    nodes: [
      node("n1", "Introduction", 1, 5),
      node("n2", "Warranty and liability limits", 20, 24),
      node("n3", "Shipping policy", 30, 31),
    ],
    terms: [{ term: "indemnification", physicalPages: [22, 40] }],
  });
});

describe("locateMapCandidates", () => {
  it("ranks the node whose title matches the query terms first", async () => {
    const result = await locateMapCandidates({ query: "warranty liability", documentIds: ["doc-1"], maxPages: 6, router: "off" });
    expect(result.pages[0]).toMatchObject({ documentId: "doc-1", nodeTitle: "Warranty and liability limits" });
    expect(result.pages.map((p) => p.page).every((page) => page >= 20 && page <= 24)).toBe(true);
    expect(result.pages).toHaveLength(5);
    expect(result.routerUsed).toBe(false);
    expect(result.confident).toBe(true);
  });

  it("uses glossary terms to reach pages with no title match", async () => {
    const result = await locateMapCandidates({ query: "indemnification", documentIds: ["doc-1"], maxPages: 6, router: "off" });
    expect(result.pages.map((p) => p.page).sort((a, b) => a - b)).toEqual([22, 40]);
  });

  it("caps pages at maxPages", async () => {
    const result = await locateMapCandidates({ query: "warranty liability", documentIds: ["doc-1"], maxPages: 2, router: "off" });
    expect(result.pages).toHaveLength(2);
  });

  it("'always' calls the router once and restricts pages to the returned node ids", async () => {
    const routerCall = vi.fn(async (_input: Parameters<import("../search/deferred/map-locator.js").MapRouterCall>[0]) => ["doc-1:n3"]);
    const result = await locateMapCandidates({ query: "warranty liability", documentIds: ["doc-1"], maxPages: 10, router: "always", routerCall });
    expect(routerCall).toHaveBeenCalledTimes(1);
    expect(routerCall.mock.calls[0]![0].nodes.map((n: { id: string }) => n.id)).toContain("doc-1:n3");
    expect(result.pages.map((p) => p.page)).toEqual([30, 31]);
    expect(result.routerUsed).toBe(true);
    expect(result.confident).toBe(true);
  });

  it("'auto' skips the router when the top-score margin is at least the threshold", async () => {
    const routerCall = vi.fn(async () => ["doc-1:n1"]);
    const result = await locateMapCandidates({ query: "warranty liability", documentIds: ["doc-1"], maxPages: 10, router: "auto", routerCall });
    expect(ROUTER_AUTO_MARGIN).toBe(0.15);
    expect(routerCall).not.toHaveBeenCalled();
    expect(result.routerUsed).toBe(false);
  });

  it("'auto' calls the router when nothing matches or the margin is thin", async () => {
    const empty = vi.fn(async () => ["doc-1:n2"]);
    const none = await locateMapCandidates({ query: "zebra crossing", documentIds: ["doc-1"], maxPages: 10, router: "auto", routerCall: empty });
    expect(empty).toHaveBeenCalledTimes(1);
    expect(none.pages[0]?.page).toBe(20);

    rows[0] = { ...(rows[0] as object), nodes: [node("a", "Pricing terms", 1, 2), node("b", "Pricing terms", 8, 9)] };
    const tie = vi.fn(async () => ["doc-1:b"]);
    const thin = await locateMapCandidates({ query: "pricing", documentIds: ["doc-1"], maxPages: 10, router: "auto", routerCall: tie });
    expect(tie).toHaveBeenCalledTimes(1);
    expect(thin.pages.map((p) => p.page)).toEqual([8, 9]);
  });

  it("never blocks search when the router fails", async () => {
    const routerCall = vi.fn(async () => { throw new Error("llm down"); });
    const result = await locateMapCandidates({ query: "warranty liability", documentIds: ["doc-1"], maxPages: 10, router: "always", routerCall });
    expect(result.routerUsed).toBe(false);
    expect(result.pages.length).toBeGreaterThan(0);
  });

  it("returns nothing without documents or query terms", async () => {
    expect(await locateMapCandidates({ query: "the", documentIds: ["doc-1"], maxPages: 5, router: "off" })).toEqual({ pages: [], routerUsed: false, confident: false });
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe("map locator recall is bounded in SQL", () => {
  it("queries with @@ + limit, then falls back to a few recent maps when nothing matches", async () => {
    sqlMock.mockClear();
    sqlMock.mockResolvedValueOnce([] as never);
    await locateMapCandidates({ query: "warranty", documentIds: ["doc-1"], maxPages: 5, router: "off" });
    expect(sqlMock).toHaveBeenCalledTimes(2);
    const first = (sqlMock.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]])[0].join("?");
    expect(first).toContain("search_text @@ to_tsquery");
    expect(first).toMatch(/limit/i);
    const second = (sqlMock.mock.calls[1] as unknown as [TemplateStringsArray, ...unknown[]])[0].join("?");
    expect(second).toMatch(/order by updated_at desc\s+limit/i);
  });
});

describe("map router call", () => {
  it("parses node ids defensively", () => {
    expect(parseRouterNodeIds('{"nodeIds":["a","b"]}')).toEqual(["a", "b"]);
    expect(parseRouterNodeIds('Sure! ```json\n{"nodeIds": ["x", 3, "y"]}\n```')).toEqual(["x", "y"]);
    expect(parseRouterNodeIds('["p","q"]')).toEqual(["p", "q"]);
    expect(parseRouterNodeIds("no json here")).toEqual([]);
    expect(parseRouterNodeIds("{broken")).toEqual([]);
  });

  it("records usage as metric map-router with a 200 token cap", async () => {
    vi.mocked(ai.generateOpenRouterText).mockResolvedValueOnce({
      text: '{"nodeIds":["doc-1:n2"]}',
      usage: { inputTokens: 120, outputTokens: 12, costCents: 0.01 },
    } as never);
    const journal = { record: vi.fn() };
    const call = createMapRouterCall({ apiKey: "k", privacyMode: "standard", journal });
    const ids = await call({ query: "warranty", nodes: [{ id: "doc-1:n2", title: "Warranty", path: "Warranty", pages: "20-24" }] });
    expect(ids).toEqual(["doc-1:n2"]);
    expect(vi.mocked(ai.generateOpenRouterText).mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 200 });
    expect(journal.record).toHaveBeenCalledWith(expect.objectContaining({ metric: "map-router", inputTokens: 120, outputTokens: 12 }));
  });
});

describe("embedPageQuery", () => {
  it("sends Gemini text with no task prefix and degrades to null on failure", async () => {
    const { embedPageQuery } = await import("../search/deferred/page-query-embedder.js");
    const journal = { record: vi.fn() };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ embeddings: [{ values: [3, 4] }], usageMetadata: { promptTokenCount: 7 } }))) as unknown as typeof fetch;
    const vector = await embedPageQuery({ model: "gemini-embedding-2", query: "find the chart", journal, privacyMode: "standard" }, { fetchImpl, geminiApiKey: "k" });
    expect(Array.from(vector!)).toEqual([0.6000000238418579, 0.800000011920929]);
    const body = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.requests[0].content.parts[0].text).toBe("find the chart");
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toContain(":batchEmbedContents");
    // Actual provider token usage, not a length estimate.
    expect(journal.record).toHaveBeenCalledWith(expect.objectContaining({
      metric: "page-query-embedding", model: "gemini-embedding-2", inputTokens: 7, metadata: expect.objectContaining({ usageSource: "provider" }),
    }));

    const failing = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await embedPageQuery({ model: "gemini-embedding-2", query: "q", journal, privacyMode: "standard" }, { fetchImpl: failing, geminiApiKey: "k" })).toBeNull();
    expect(await embedPageQuery({ model: "gemini-embedding-2", query: "q", journal, privacyMode: "local-only" }, { fetchImpl, geminiApiKey: "k" })).toBeNull();
    expect(await embedPageQuery({ model: "unknown-model", query: "q", journal, privacyMode: "standard" })).toBeNull();
  });
});
