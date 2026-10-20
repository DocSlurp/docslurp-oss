import { describe, expect, it } from "vitest";

import { ESTIMATE_TOOL_NAMES, estimateToolDefinitions, estimateToolUsesWorkspace, planEstimateTool } from "./mcp-estimate-tools.js";
import { mcpManifest } from "./mcp-tools.js";

describe("MCP estimate tools", () => {
  it("defines a tool for every estimate operation", () => {
    expect(estimateToolDefinitions.map((tool) => tool.name)).toEqual([...ESTIMATE_TOOL_NAMES]);
  });

  it("maps input to the estimate route with the mutation body", () => {
    const plan = (name: Parameters<typeof planEstimateTool>[0], input: unknown) => {
      const result = planEstimateTool(name, input, "w1");
      if (!result.ok) throw new Error("invalid");
      return [result.plan.path, result.plan.body];
    };
    expect(plan("updateEstimate", { changes: { apply: "reindex", pipeline: {} } })).toEqual(["/v1/workspaces/w1/estimate", { apply: "reindex", pipeline: {} }]);
    expect(plan("searchSettingsEstimate", { changes: { a: 1 } })).toEqual(["/v1/workspaces/w1/search-settings/estimate", { a: 1 }]);
    expect(plan("reprocessEstimate", { runId: "r/1", stageFrom: "embed" })).toEqual(["/v1/runs/r%2F1/reprocess/estimate", { stageFrom: "embed" }]);
    expect(plan("fullIndexEstimate", { documentId: "d1" })).toEqual(["/v1/documents/d1/full-index/estimate", {}]);
    expect(plan("fullIndexEstimate", { documentIds: ["a"] })).toEqual(["/v1/workspaces/w1/full-index/estimate", { documentIds: ["a"] }]);
    expect(plan("indexingModeEstimate", { mode: "map" })).toEqual(["/v1/workspaces/w1/indexing-mode/estimate", { mode: "map" }]);
    expect(plan("graphRebuildEstimate", {})).toEqual(["/v1/workspaces/w1/graph/jobs/estimate", {}]);
    expect(plan("uploadEstimate", { files: [{ name: "a.pdf", size: 9, pages: 2 }] })).toEqual(["/v1/uploads/estimate", { files: [{ name: "a.pdf", size: 9, pages: 2 }], workspaceId: "w1" }]);
  });

  it("rejects invalid input and skips workspace resolution for run and document targets", () => {
    expect(planEstimateTool("indexingModeEstimate", { mode: "bogus" }, "w1").ok).toBe(false);
    expect(planEstimateTool("uploadEstimate", { files: [] }, "w1").ok).toBe(false);
    expect(estimateToolUsesWorkspace("reprocessEstimate", { runId: "r" })).toBe(false);
    expect(estimateToolUsesWorkspace("fullIndexEstimate", { documentId: "d" })).toBe(false);
    expect(estimateToolUsesWorkspace("fullIndexEstimate", {})).toBe(true);
  });

  it("registers estimate tools and getJob in the manifest, gated by scope", () => {
    const ids = (scopes?: string[], keyType = "server") => mcpManifest("https://x.test", scopes, keyType).capabilities.filter((c) => c.category === "tool").map((c) => c.id);
    const all = ids();
    for (const name of ESTIMATE_TOOL_NAMES) expect(all).toContain(name);
    expect(all).toContain("getJob");
    const searchOnly = ids(["search"]);
    expect(searchOnly).toContain("getJob");
    // A search-only key can read jobs but could not start any estimated operation.
    expect(searchOnly.filter((id) => id.endsWith("Estimate"))).toEqual([]);
    expect(ids(["ingest"])).toContain("uploadEstimate");
    expect(ids(["ingest"])).toContain("fullIndexEstimate");
    expect(ids(["ingest"])).not.toContain("updateEstimate");
    expect(ids(["workspaces:manage"])).toEqual(expect.arrayContaining(["updateEstimate", "indexingModeEstimate", "graphRebuildEstimate"]));
    expect(ids(["workspaces:manage"], "client")).not.toContain("updateEstimate");
    // Session-only estimates are never offered to keys, whatever their scopes.
    expect(ids(["search", "ingest", "workspaces:manage"])).not.toContain("reprocessEstimate");
    expect(ids(["search", "ingest", "workspaces:manage"])).not.toContain("searchSettingsEstimate");
  });
});
