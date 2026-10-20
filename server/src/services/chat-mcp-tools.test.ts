import { describe, expect, it, vi } from "vitest";
import type { McpDispatch } from "../lib/mcp-http.js";
import { createChatMcpTools } from "./chat-mcp-tools.js";

function setup(ids = ["search"]) {
  const dispatch = vi.fn<McpDispatch>(async () => Response.json({ results: [] }));
  const onActivity = vi.fn();
  const controller = new AbortController();
  const context = createChatMcpTools({ manifest: { capabilities: ids.map(id => ({ id, title: id, category: "tool", description: id, inputSchema: { type: "object" } })) },
    dispatch, workspaceId: "selected", signal: controller.signal, onActivity });
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
