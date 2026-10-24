import { afterEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
const scoped = vi.hoisted(() => vi.fn());
vi.mock("../lib/request-actor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/request-actor.js")>(),
  lookupActorWorkspace: lookup,
  resolveActorWorkspaceId: vi.fn(async (_actor: unknown, workspace?: string) => workspace ?? "ws-default"),
  loadActorScopedWorkspace: scoped,
}));
vi.mock("../services/billing/spend-guard.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/billing/spend-guard.js")>(),
  assertCanSpend: vi.fn(async () => undefined),
}));

const { webRoutesFor } = await import("./web.js");
const { setWebServiceDeps } = await import("../services/web/service.js");
const { WebRouter } = await import("../services/web/router.js");
const { env } = await import("../config.js");

const restrictedKey = { type: "apiKey", userId: "user-1", apiKey: { id: "key-1", userId: "user-1", orgId: "org-1", scopes: ["ingest", "search"], workspaceIds: ["ws-allowed"] } } as never;

function crawlSpy() {
  const run = vi.fn(async () => ({ data: { pages: [{ url: "https://a.test/", markdown: "# A" }] }, costUsd: 0.001, costSource: "reported" as const }));
  setWebServiceDeps({
    config: { ...env.web, enabled: true },
    router: new WebRouter({ adapters: [{ id: "firecrawl", keyEnv: "", capabilities: { crawl: { estimateUsd: () => 0.001, run } } }],
      keys: { firecrawl: "k" }, strategy: "cheapest", order: ["firecrawl"], maxAttempts: 1 }),
    assertSafeUrl: async (url) => url, workspaceAccess: async () => "allowed", assertCanSpend: async () => undefined,
    recordCost: vi.fn(async () => true), recordCharge: vi.fn(async () => ({}) as never),
  });
  return run;
}

afterEach(() => setWebServiceDeps(undefined));

describe("POST /v1/web/ingest preflight", () => {
  it("refuses a restricted key naming a new workspace before crawling or charging", async () => {
    const run = crawlSpy();
    lookup.mockResolvedValueOnce({ ref: { kind: "slug", slug: "brand-new" }, workspace: null });
    const response = await webRoutesFor(restrictedKey, "mcp").request("http://mcp.internal/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://a.test/", workspace: "Brand New" }),
    });
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an unknown workspace ID before crawling", async () => {
    const run = crawlSpy();
    lookup.mockResolvedValueOnce({ ref: { kind: "id", id: "00000000-0000-4000-8000-000000000000" }, workspace: null });
    const response = await webRoutesFor(restrictedKey, "mcp").request("http://mcp.internal/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://a.test/", workspace: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
    expect(scoped).not.toHaveBeenCalled();
  });
});
