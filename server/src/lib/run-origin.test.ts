import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { chartExportOverrideSchema } from "@docslurp/shared";

import { chartExportOverrideJsonSchema, ESTIMATE_TOOL_NAMES, estimateToolDefinitions, planEstimateTool } from "../services/mcp-estimate-catalog.js";
import { extractInput, uploadInput } from "../services/mcp-catalog.js";
import { runOriginOf } from "./run-origin.js";

type Setup = { actor?: unknown; apiKey?: unknown; mcp?: boolean };
async function originOf(setup: Setup, body: unknown = {}): Promise<string> {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (setup.actor) c.set("requestActor", setup.actor as never);
    if (setup.apiKey) c.set("apiKey", setup.apiKey as never);
    if (setup.mcp) c.set("runOrigin", "machine");
    await next();
  });
  app.post("/", (c) => c.text(runOriginOf(c)));
  const res = await app.request("/", { method: "POST", headers: { "content-type": "application/json", "x-docslurp-origin": "app" }, body: JSON.stringify(body) });
  return res.text();
}

const session = { type: "session", userId: "u1", sessionId: "s1", user: { id: "u1", email: "a@example.com", name: "A" } };
const key = { keyId: "k1", userId: "u1", orgId: "o1", scopes: ["ingest"], keyType: "server" };

describe("runOriginOf", () => {
  it("is app only for a first-party cookie session", async () => {
    expect(await originOf({ actor: session })).toBe("app");
  });
  it("is machine for API keys, CLI and MCP OAuth tokens, WebMCP session tools and anything unauthenticated", async () => {
    expect(await originOf({ actor: { type: "apiKey", userId: "u1", apiKey: key }, apiKey: key })).toBe("machine");
    const cli = { ...key, oauth: { audience: "api", grantId: "g", clientId: "c", clientName: "CLI" } };
    expect(await originOf({ actor: { type: "apiKey", userId: "u1", apiKey: cli }, apiKey: cli })).toBe("machine");
    const mcp = { ...key, oauth: { audience: "mcp", grantId: "g", clientId: "c", clientName: "Agent" } };
    expect(await originOf({ actor: { type: "apiKey", userId: "u1", apiKey: mcp }, apiKey: mcp })).toBe("machine");
    // Cookie-authenticated MCP tools replay into routes marked machine.
    expect(await originOf({ actor: session, mcp: true })).toBe("machine");
    // A session without a session id is not first-party.
    expect(await originOf({ actor: { ...session, sessionId: "" } })).toBe("machine");
    expect(await originOf({})).toBe("machine");
  });
  it("ignores every client-supplied field and header", async () => {
    const machine = { actor: { type: "apiKey", userId: "u1", apiKey: key }, apiKey: key };
    expect(await originOf(machine, { origin: "app", runOrigin: "app", source: "app" })).toBe("machine");
  });
});

describe("chart export override schemas agree across REST, MCP and estimates", () => {
  it("the MCP JSON Schema is the REST zod schema", () => {
    const fromZod = z.toJSONSchema(chartExportOverrideSchema) as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(chartExportOverrideJsonSchema.properties).toEqual({ tier: { type: "string", enum: ["off", "free", "models"] } });
    expect(fromZod.properties).toEqual(chartExportOverrideJsonSchema.properties);
    expect(fromZod.required).toEqual(chartExportOverrideJsonSchema.required);
    expect(fromZod.additionalProperties).toBe(false);
    // No model selection anywhere in the description either.
    expect(chartExportOverrideJsonSchema.description).not.toMatch(/llm:\/\/|gemini|gpt|claude|qwen/i);
  });
  it("upload, extract and the estimate tools accept the same override and refuse anything else", () => {
    for (const schema of [uploadInput, extractInput]) {
      expect(schema.safeParse({ urls: ["https://example.com/a.pdf"], chartExport: { tier: "free" } }).success).toBe(true);
      expect(schema.safeParse({ urls: ["https://example.com/a.pdf"], chartExport: { tier: "bogus" } }).success).toBe(false);
      expect(schema.safeParse({ urls: ["https://example.com/a.pdf"], chartExport: { tier: "models", generatorModel: "llm://x/y" } }).success).toBe(false);
    }
    expect(ESTIMATE_TOOL_NAMES).toContain("uploadEstimate");
    for (const name of ["uploadEstimate", "reprocessEstimate"] as const) {
      const definition = estimateToolDefinitions.find((tool) => tool.name === name)!;
      expect((definition.inputSchema as { properties: Record<string, unknown> }).properties.chartExport).toBe(chartExportOverrideJsonSchema);
    }
    const upload = planEstimateTool("uploadEstimate", { files: [{ name: "a.pdf", size: 1 }], chartExport: { tier: "models" } }, "p1");
    expect(upload.ok && upload.plan.body.chartExport).toEqual({ tier: "models" });
    const reprocess = planEstimateTool("reprocessEstimate", { runId: "r1", chartExport: { tier: "free" } }, "p1");
    expect(reprocess.ok && reprocess.plan.body).toEqual({ chartExport: { tier: "free" } });
    expect(planEstimateTool("reprocessEstimate", { runId: "r1", chartExport: { tier: "turbo" } }, "p1").ok).toBe(false);
  });
});
