import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedKey } from "../services/api-keys.js";

vi.mock("../services/api-keys.js", () => ({
  validateApiKey: vi.fn()
}));

vi.mock("../services/automation.js", () => ({
  approveAutomationOperation: vi.fn(),
  getAutomationCapabilityManifest: vi.fn(),
  getAutomationOperation: vi.fn(),
  getAutomationOperationEvents: vi.fn(),
  getAutomationUsage: vi.fn()
}));

const { validateApiKey } = await import("../services/api-keys.js");
const automation = await import("../services/automation.js");
const { aiRoutes } = await import("../routes/ai.js");

const validatedKey: ValidatedKey = {
  keyId: "key-1",
  userId: "user-1",
  orgId: "org-1",
  keyType: "server",
  allowedDomains: [],
  scopes: ["search", "ingest"],
  rateLimitRpm: 60,
  rateLimitPpd: 10_000,
  rateLimits: [], workspaceIds: [],
};

function buildApp() {
  const app = new Hono();
  app.route("/ai", aiRoutes);
  return app;
}

describe("aiRoutes", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(automation.getAutomationOperation).mockReset();
    vi.mocked(automation.getAutomationOperationEvents).mockReset();
    vi.mocked(validateApiKey).mockReset();
    vi.mocked(validateApiKey).mockResolvedValue(validatedKey);
    vi.mocked(automation.getAutomationCapabilityManifest).mockReturnValue({
      server: {
        id: "docslurp-mcp",
        title: "DocSlurp MCP",
        version: "0.1.0",
        transports: ["http", "sse", "stdio"],
        auth: { type: "apiKey", scopes: ["search", "ingest"] }
      },
      capabilities: [
        {
          id: "ai.simple",
          title: "Simple Automation",
          description: "simple",
          category: "tool",
          endpoint: "http://localhost/v1/mcp/tools/ai.simple",
          inputSchema: {},
          outputSchema: {},
          streaming: true,
          auth: { type: "apiKey", scopes: ["search"], workspaceScoped: true, orgScoped: true },
          idempotent: false,
          costHints: { baselineCostCents: 0, billableMetrics: [] },
          featureGates: []
        }
      ],
      resources: [],
      prompts: []
    });
  });

  it("returns the capability manifest for authorized clients", async () => {
    const response = await app.request("/ai/capabilities", {
      headers: { Authorization: "Bearer dslp_test" }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.capabilities).toHaveLength(1);
    expect(body.capabilities[0].id).toBe("ai.simple");
    expect(body.capabilities[0].endpoint).toBe("http://localhost/v1/mcp/tools/ai.simple");
  });

  it("does not expose direct automation submit endpoints", async () => {
    const response = await app.request("/ai/simple", {
      method: "POST",
      headers: {
        Authorization: "Bearer dslp_test",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceId: "ws-1",
        goal: "Find the renewal clause"
      })
    });

    expect(response.status).toBe(404);
  });
  it("streams operation events and a terminal done frame while retaining key scope", async () => {
    vi.mocked(automation.getAutomationOperation).mockResolvedValue({ id: "op-1", status: "completed" } as never);
    vi.mocked(automation.getAutomationOperationEvents).mockResolvedValue([{ sequence: 1, type: "completed" }] as never);
    const response = await app.request("/ai/operations/op-1/stream", { headers: { Authorization: "Bearer dslp_test" } });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: completed");
    expect(body).toContain("event: done");
    expect(automation.getAutomationOperation).toHaveBeenLastCalledWith({ operationId: "op-1", userId: "user-1", apiKey: validatedKey });
  });
  it("does not open a stream for an inaccessible operation", async () => {
    vi.mocked(automation.getAutomationOperation).mockResolvedValue(null);
    const response = await app.request("/ai/operations/op-other/stream", { headers: { Authorization: "Bearer dslp_test" } });
    expect(response.status).toBe(404);
    expect(automation.getAutomationOperationEvents).not.toHaveBeenCalled();
  });
  it("stops polling after the client disconnects", async () => {
    vi.mocked(automation.getAutomationOperation).mockResolvedValue({ id: "op-1", status: "running" } as never);
    vi.mocked(automation.getAutomationOperationEvents).mockResolvedValue([{ sequence: 1, type: "started" }] as never);
    const response = await app.request("/ai/operations/op-1/stream", { headers: { Authorization: "Bearer dslp_test" } });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(automation.getAutomationOperationEvents).toHaveBeenCalledOnce();
  });

});
