import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpDispatch } from "../lib/mcp-http.js";
import { createChatMcpTools } from "./chat-mcp-tools.js";

function setup(ids = ["workspace.search"]) {
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
    const t = setup(["workspace.search", "workspace.aggregate-rag-search", "workspace.chat"]);
    await t.execute("workspace_search", { q: "question", workspaceId: "injected" });
    expect(JSON.parse(t.dispatch.mock.calls[0]![1]!.body as string)).toEqual({ q: "question", workspaceId: "selected" });
    await t.execute("workspace_aggregate-rag-search", { q: "all", workspaceIds: ["injected", "other"] });
    expect(JSON.parse(t.dispatch.mock.calls[1]![1]!.body as string).workspaceIds).toEqual(["selected"]);
    await t.execute("workspace_chat", { q: "x", workspaceId: "injected" });
    expect(JSON.parse(t.dispatch.mock.calls[2]![1]!.body as string).workspaceId).toBe("selected");
  });

  it("pins the product search alias to the selected workspace", async () => {
    const t = setup(["search"]);
    await t.execute("search", { queries: [{ q: "a", workspaceId: "foreign" }] });
    expect(JSON.parse(t.dispatch.mock.calls[0]![1]!.body as string).queries[0].workspaceId).toBe("selected");
  });

  it("has no cost approval argument to pass through (schemas define none)", async () => {
    const { aiAdvancedRequestSchema, aiSimpleRequestSchema } = await import("@docslurp/shared");
    for (const schema of [aiSimpleRequestSchema, aiAdvancedRequestSchema]) {
      expect(JSON.stringify(z.toJSONSchema(schema, { io: "input" }))).not.toMatch(/approve/i);
      expect(schema.parse({ workspaceId: "w", goal: "g", approveCostEstimate: true })).not.toHaveProperty("approveCostEstimate");
    }
  });

  it("does not offer automation tools that fetch sourceUrls or start paid work (G-04)", () => {
    const t = setup(["workspace.search", "ai.simple", "ai.advanced", "ai.operation.get", "upload", "completeUpload", "listWorkspaces"]);
    expect(Object.keys(t.tools)).toEqual(["workspace_search"]);
  });

  it("bounds calls and honors cancellation before dispatch", async () => {
    const t = setup();
    for (let i = 0; i < 13; i++) await t.execute("workspace_search", { q: "repeat" }, `${i}`);
    expect(t.dispatch).toHaveBeenCalledTimes(12);
    t.controller.abort();
    await expect(t.execute("workspace_search")).rejects.toThrow();
    expect(t.dispatch).toHaveBeenCalledTimes(12);
  });

  it("returns adapter errors and reports failed activity without claiming success", async () => {
    const t = setup();
    t.dispatch.mockResolvedValueOnce(Response.json({ error: "Workspace not found" }, { status: 404 }));
    await expect(t.execute("workspace_search")).resolves.toMatchObject({ ok: false, status: 404 });
    expect(t.onActivity.mock.calls.map(([event]) => event.status)).toEqual(["loading", "error"]);
  });

  it("deduplicates evidence and gives stable citation numbers across searches", async () => {
    const t = setup();
    const source = { text: "Supported fact", score: 1, citation: { documentId: "doc", filename: "guide.pdf", pageNumber: 1, chunkIndex: 0, headingPath: [] } };
    t.dispatch.mockImplementation(async () => Response.json({ results: [source] }));
    await t.execute("workspace_search");
    const result = await t.execute("workspace_search");
    expect(t.citations).toHaveLength(1);
    expect(result).toMatchObject({ evidence: [{ citationIndex: 1, text: "Supported fact" }] });
  });
});
