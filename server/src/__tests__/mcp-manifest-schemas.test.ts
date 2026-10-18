import { describe, expect, it, vi } from "vitest";
import { searchInputSchema, workspaceChatInputSchema } from "../lib/search-input.js";

vi.mock("../db.js", () => ({ sql: vi.fn() }));
import { getAutomationCapabilityManifest } from "../services/automation.js";
import { mcpManifest } from "../services/mcp-tools.js";
import { aiAdvancedToolSchema, aiSimpleToolSchema, toolInputJsonSchema } from "../services/mcp-tool-schemas.js";

type Schema = { properties: Record<string, any>; oneOf?: unknown[]; additionalProperties?: boolean };
const productTool = (id: string) => mcpManifest("http://localhost").capabilities.find((item) => item.id === id)!.inputSchema as unknown as Schema;
const automationTool = (id: string) => getAutomationCapabilityManifest("http://localhost").capabilities.find((item) => item.id === id)!.inputSchema as unknown as Schema;

describe("MCP tool input schemas come from their zod sources", () => {
  it("generates automation tool schemas from the shared request schemas without identity or approval", () => {
    expect(automationTool("ai.simple")).toEqual(toolInputJsonSchema(aiSimpleToolSchema));
    expect(automationTool("ai.advanced")).toEqual(toolInputJsonSchema(aiAdvancedToolSchema));
    expect(JSON.stringify([automationTool("ai.simple"), automationTool("ai.advanced")])).not.toMatch(/approve|userId/i);
    expect(automationTool("ai.advanced").properties).toHaveProperty("outputFormat");
  });

  it("advertises every field the search route accepts, plus batch inputs", () => {
    const search = productTool("search");
    const single = toolInputJsonSchema(searchInputSchema) as Schema;
    expect(Object.keys(search.properties)).toEqual([...Object.keys(single.properties), "queries", "concurrency"]);
    expect(search.properties.queries.items).toEqual(single);
    expect(search.properties.minScore.description).toMatch(/Relevance floor/);
    expect(search.additionalProperties).toBe(false);
    expect(search.oneOf).toHaveLength(2);
  });

  it("generates chat from the chat route's schema", () => {
    expect(productTool("chat")).toEqual(toolInputJsonSchema(workspaceChatInputSchema));
    expect(productTool("chat").properties).toHaveProperty("retrieval");
  });

  it("generates ingest-report and suggest from their zod schemas", () => {
    expect(productTool("getUploadStatus").properties.documentIds).toMatchObject({ type: "array", maxItems: 100 });
    expect(productTool("suggestQueries").properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 25 });
  });
});
