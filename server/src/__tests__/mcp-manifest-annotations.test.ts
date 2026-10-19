import { describe, expect, it } from "vitest";
import { mcpManifest } from "../services/mcp-tools.js";

/**
 * Agent-safety hints must be declared in the manifest, not inferred from ids.
 * These assertions read the real manifests (no mocks) so an omitted annotation
 * or a wrong hint fails here instead of only at an agent's decision point.
 */
describe("capability manifest annotations", () => {
  it("declares hints for every exposed MCP tool", () => {
    const manifest = mcpManifest("https://example.test", ["search", "ingest"]);
    const expected: Record<string, { readOnly: boolean; idempotent: boolean }> = {
      listWorkspaces: { readOnly: true, idempotent: true },
      upload: { readOnly: false, idempotent: false },
      completeUpload: { readOnly: false, idempotent: false },
      search: { readOnly: true, idempotent: true },
      chat: { readOnly: false, idempotent: false },
      getUploadStatus: { readOnly: true, idempotent: true },
      suggestQueries: { readOnly: true, idempotent: true },
    };
    const tools = manifest.capabilities.filter((capability) => capability.category === "tool");
    expect(new Set(tools.map((tool) => tool.id))).toEqual(new Set(Object.keys(expected)));
    for (const tool of tools) {
      expect(tool.annotations, `missing annotations on ${tool.id}`).toBeDefined();
      expect(tool.annotations, tool.id).toMatchObject(expected[tool.id]!);
    }
  });
});
