import { describe, expect, it, vi } from "vitest";
import type { McpDispatch } from "../lib/mcp-http.js";
import { asSchema } from "ai";
import { createChatMcpTools, evidencePages, TOOL_DEADLINE_RESULT } from "./chat-mcp-tools.js";
import { mcpManifest } from "./mcp-catalog.js";
import { currentSearchSignal } from "../search/query-bounds.js";
import { currentChatAgentSignal } from "../lib/chat-agent-context.js";

function setup(ids = ["search"], options: { toolBudgetMs?: () => number } = {}) {
  const dispatch = vi.fn<McpDispatch>(async () => Response.json({ results: [] }));
  const onActivity = vi.fn();
  const controller = new AbortController();
  const context = createChatMcpTools({ manifest: { capabilities: ids.map(id => ({ id, title: id, category: "tool", description: id, inputSchema: { type: "object" } })) },
    dispatch, workspaceId: "selected", signal: controller.signal, onActivity, ...options });
  const execute = (name: string, input: unknown = {}, id = "call") => context.tools[name]!.execute!(input, { toolCallId: id, messages: [], context: {} });
  return { ...context, execute, dispatch, onActivity, controller };
}

describe("chat MCP tools", () => {
  it("pins every tool to the selected workspace, overriding model-supplied scope (G-04)", async () => {
    const t = setup(["search", "chat"]);
    await t.execute("search", { q: "question", workspaceId: "injected" });
    expect(JSON.parse(t.dispatch.mock.calls[0]![1]!.body as string)).toEqual({ q: "question", workspaceId: "selected" });
    await t.execute("chat", { q: "x", workspaceId: "injected" });
    expect(JSON.parse(t.dispatch.mock.calls[1]![1]!.body as string).workspaceId).toBe("selected");
  });

  it("pins every batch query to the selected workspace", async () => {
    const t = setup(["search"]);
    await t.execute("search", { queries: [{ q: "a", workspaceId: "foreign" }] });
    expect(JSON.parse(t.dispatch.mock.calls[0]![1]!.body as string).queries[0].workspaceId).toBe("selected");
  });

  it("does not offer ingestion tools that fetch URLs or start paid work (G-04)", () => {
    const t = setup(["search", "upload", "completeUpload", "listWorkspaces"]);
    expect(Object.keys(t.tools)).toEqual(["search"]);
  });

  it("bounds calls and honors cancellation before dispatch", async () => {
    const t = setup();
    for (let i = 0; i < 13; i++) await t.execute("search", { q: "repeat" }, `${i}`);
    expect(t.dispatch).toHaveBeenCalledTimes(12);
    t.controller.abort();
    await expect(t.execute("search")).rejects.toThrow();
    expect(t.dispatch).toHaveBeenCalledTimes(12);
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
    t.dispatch.mockRejectedValueOnce(new Error("boom"));
    await t.execute("search", { q: "boom" }, "c");
    const [first, second, third] = [...t.details.values()];
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
    expect(JSON.parse(dispatch.mock.calls[0]![1]!.body as string)).toMatchObject({ workspaceId: "selected", limit: 4, hyde: false, rerank: false, mmr: true, resultOrder: "relevance" });
    await execute("search", { queries: [{ q: "a", hyde: true, limit: 100 }, { q: "b" }] });
    for (const query of JSON.parse(dispatch.mock.calls[1]![1]!.body as string).queries) expect(query).toMatchObject({ workspaceId: "selected", limit: 4, hyde: false, mmr: true });
    await execute("chat", { q: "a", retrieval: { useHyDE: true } });
    expect(JSON.parse(dispatch.mock.calls[2]![1]!.body as string)).toMatchObject({ workspaceId: "selected", retrieval: { resultCount: 4, useHyDE: false, useMmr: true, resultOrder: "relevance" } });
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
    await expect(t.execute("search", { q: "late" })).resolves.toEqual(TOOL_DEADLINE_RESULT);
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
