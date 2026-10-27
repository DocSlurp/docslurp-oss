import { describe, expect, it } from "vitest";
import { env } from "../config.js";
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
      listWorkspaces: { readOnly: true, idempotent: true, consequential: false },
      upload: { readOnly: false, idempotent: false, consequential: true },
      extract: { readOnly: false, idempotent: false, consequential: true },
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
    // Settings proposals are first-party-app only: no API key sees them, whatever its scopes.
    const managed = mcpManifest("https://example.test", ["search", "workspaces:manage"], "server");
    expect(managed.capabilities.some(tool => tool.id === "proposeWorkspaceSettings" || tool.id === "getWorkspaceSettings")).toBe(false);
    const app = mcpManifest("https://example.test", undefined, undefined, { firstPartyApp: true });
    expect(app.capabilities.find(tool => tool.id === "getWorkspaceSettings")?.annotations).toMatchObject({ readOnly: true, idempotent: true, consequential: false });
    expect(app.capabilities.find(tool => tool.id === "proposeWorkspaceSettings")?.annotations).toMatchObject({ readOnly: true, idempotent: true, consequential: false });
    expect(app.capabilities.some(tool => tool.id === "applySettingsProposal")).toBe(false);
    const tools = manifest.capabilities.filter((capability) => capability.category === "tool");
    expect(new Set(tools.map((tool) => tool.id))).toEqual(new Set(Object.keys(expected)));
    for (const tool of tools) {
      expect(tool.annotations, `missing annotations on ${tool.id}`).toBeDefined();
      expect(tool.annotations, tool.id).toMatchObject(expected[tool.id]!);
    }
  });

  it("offers openUploader only when the MCP Apps flag is on, read-only and ingest-scoped", () => {
    const ids = (scopes: string[]) => mcpManifest("https://example.test", scopes).capabilities.map(tool => tool.id);
    expect(ids(["ingest"])).not.toContain("openUploader");
    env.mcpAppsUiEnabled = true;
    try {
      const tool = mcpManifest("https://example.test", ["ingest"]).capabilities.find(item => item.id === "openUploader");
      expect(tool?.annotations).toMatchObject({ readOnly: true, idempotent: true, consequential: false });
      expect(ids(["search"])).not.toContain("openUploader");
    } finally { env.mcpAppsUiEnabled = false; }
  });

  it("lists tools in product order with consistent sentence-case titles", () => {
    const tools = mcpManifest("https://example.test").capabilities.filter((capability) => capability.category === "tool");
    expect(tools.slice(0, 5).map((tool) => tool.id)).toEqual(["listWorkspaces", "upload", "getUploadStatus", "search", "chat"]);
    expect(tools.at(-1)?.id).toBe("completeUpload");
    for (const tool of tools) {
      // Clients such as Claude.ai re-sort by id and show titles side by side, so no Title Case drift.
      expect(tool.title, tool.id).toMatch(/^[A-Z][a-z]+ /);
      expect(tool.title.split(" ").slice(1).filter((word) => /^[A-Z][a-z]/.test(word)), tool.title).toEqual([]);
      if (tool.id.endsWith("Estimate")) expect(tool.title, tool.id).toMatch(/^Estimate .+ cost$/);
    }
  });
});
