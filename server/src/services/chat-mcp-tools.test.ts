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
