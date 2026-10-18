import { describe, expect, it } from "vitest";
import { getAutomationCapabilityManifest } from "../services/automation.js";
import { mcpManifest } from "../services/mcp-tools.js";

/**
 * Agent-safety hints must be declared in the manifest, not inferred from ids.
 * These assertions read the real manifests (no mocks) so an omitted annotation
 * or a wrong hint fails here instead of only at an agent's decision point.
 */
describe("capability manifest annotations", () => {
  it("declares hints for every automation capability, resource and prompt", () => {
    const manifest = getAutomationCapabilityManifest("https://example.test");
    for (const item of [...manifest.capabilities, ...manifest.resources, ...manifest.prompts]) {
      expect(item.annotations, item.id).toBeDefined();
    }
    const byId = new Map(manifest.capabilities.map((capability) => [capability.id, capability.annotations]));
    expect(byId.get("ai.simple")).toMatchObject({ readOnly: false, openWorld: true });
    expect(byId.get("ai.advanced")).toMatchObject({ readOnly: false, openWorld: true });
    expect(byId.get("workspace.aggregate-rag-search")).toMatchObject({ readOnly: true, idempotent: true });
    expect(manifest.resources.find((resource) => resource.id === "ai.capabilities")?.annotations).toMatchObject({ readOnly: true, idempotent: true });
    expect(manifest.prompts.find((prompt) => prompt.id === "prompt.workspace-grounded-answer")?.annotations).toMatchObject({ readOnly: true, idempotent: true });
  });

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
