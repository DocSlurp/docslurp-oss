import { describe, expect, it, vi } from "vitest";
import { apiKeyCanUseWebTools } from "./web-tool-access.js";
import { mcpManifest } from "../services/mcp-catalog.js";

vi.mock("../services/web/service.js", () => ({ webCapabilityAvailable: () => true }));

describe("apiKeyCanUseWebTools", () => {
  it("preserves explicit web scope for CLI OAuth catalogs alongside app-only filtering", () => {
    const ids = (scopes: string[]) => mcpManifest("https://example.test", scopes, "server", { audience: "api", firstPartyApp: true }).capabilities.map(tool => tool.id);
    expect(ids(["search"])).not.toContain("webSearch");
    expect(ids(["search", "web"])).toContain("webSearch");
    expect(ids(["search", "web", "workspaces:manage"])).not.toContain("getWorkspaceSettings");
  });
  it("keeps web tools for server keys with search, and website ingestion with ingest", () => {
    expect(apiKeyCanUseWebTools({ keyType: "server", scopes: ["search"] })).toBe(true);
    expect(apiKeyCanUseWebTools({ scopes: ["search"] })).toBe(true);
    expect(apiKeyCanUseWebTools({ keyType: "server", scopes: ["search"] }, true)).toBe(false);
    expect(apiKeyCanUseWebTools({ keyType: "server", scopes: ["ingest"] }, true)).toBe(true);
  });

  it("denies public client keys unless they hold the web scope", () => {
    expect(apiKeyCanUseWebTools({ keyType: "client", scopes: ["search", "chat"] })).toBe(false);
    expect(apiKeyCanUseWebTools({ keyType: "client", scopes: ["web"] })).toBe(false);
    expect(apiKeyCanUseWebTools({ keyType: "client", scopes: ["search", "web"] })).toBe(true);
    expect(apiKeyCanUseWebTools({ keyType: "client", scopes: ["search", "web"] }, true)).toBe(false);
    expect(apiKeyCanUseWebTools({ keyType: "client", scopes: ["ingest", "web"] }, true)).toBe(true);
  });

  it("hides web and chat tools from a default client key's MCP catalog", () => {
    const ids = (scopes: string[], keyType: string) => mcpManifest("http://mcp.internal", scopes, keyType).capabilities.map(tool => tool.id);
    const client = ids(["search"], "client");
    expect(client).toContain("search");
    expect(client.some(id => id.startsWith("web") || id === "ingestWebsite" || id === "chat")).toBe(false);
    expect(ids(["search", "chat"], "client")).toContain("chat");
  });
});
