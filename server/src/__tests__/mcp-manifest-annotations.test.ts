import { describe, expect, it } from "vitest";
import { mcpManifest } from "../services/mcp-tools.js";

/**
 * Agent-safety hints must be declared in the manifest, not inferred from ids.
 * These assertions read the real manifests (no mocks) so an omitted annotation
 * or a wrong hint fails here instead of only at an agent's decision point.
 */
describe("capability manifest annotations", () => {
  it("declares hints for every exposed MCP tool", () => {
    const manifest = mcpManifest("https://example.test", ["search", "chat", "ingest"]);
    const expected: Record<string, { readOnly: boolean; idempotent: boolean; consequential: boolean }> = {
      getWorkspaceSettings: { readOnly: true, idempotent: true, consequential: false },
      listWorkspaces: { readOnly: true, idempotent: true, consequential: false },
      upload: { readOnly: false, idempotent: false, consequential: true },
      completeUpload: { readOnly: false, idempotent: false, consequential: true },
      search: { readOnly: true, idempotent: true, consequential: false },
      chat: { readOnly: false, idempotent: false, consequential: false },
      getUploadStatus: { readOnly: true, idempotent: true, consequential: false },
      getMediaEvidence: { readOnly: true, idempotent: true, consequential: false },
      suggestQueries: { readOnly: true, idempotent: true, consequential: false },
      // Ingest-scoped keys can price the work they could start, and read background jobs.
      fullIndexEstimate: { readOnly: true, idempotent: true, consequential: false },
      uploadEstimate: { readOnly: true, idempotent: true, consequential: false },
      getJob: { readOnly: true, idempotent: true, consequential: false },
    };
    const managed = mcpManifest("https://example.test", ["search", "workspaces:manage"], "server");
    expect(managed.capabilities.find(tool => tool.id === "proposeWorkspaceSettings")?.annotations).toMatchObject({ readOnly: true, idempotent: true, consequential: false });
    expect(managed.capabilities.some(tool => tool.id === "applySettingsProposal")).toBe(false);
    const tools = manifest.capabilities.filter((capability) => capability.category === "tool");
    expect(new Set(tools.map((tool) => tool.id))).toEqual(new Set(Object.keys(expected)));
    for (const tool of tools) {
      expect(tool.annotations, `missing annotations on ${tool.id}`).toBeDefined();
      expect(tool.annotations, tool.id).toMatchObject(expected[tool.id]!);
    }
  });
});
