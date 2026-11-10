import { afterEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
const scoped = vi.hoisted(() => vi.fn());
vi.mock("../lib/request-actor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/request-actor.js")>(),
  lookupActorProject: lookup,
  resolveActorProjectId: vi.fn(async (_actor: unknown, project?: string) => project ?? "ws-default"),
  loadActorScopedProject: scoped,
}));
vi.mock("../services/billing/spend-guard.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/billing/spend-guard.js")>(),
  assertCanSpend: vi.fn(async () => undefined),
}));

const { webRoutesFor } = await import("./web.js");
const { setWebServiceDeps } = await import("../services/web/service.js");
const { WebRouter } = await import("../services/web/router.js");
const { env } = await import("../config.js");

const restrictedKey = { type: "apiKey", userId: "user-1", apiKey: { id: "key-1", userId: "user-1", orgId: "org-1", scopes: ["ingest", "search"], projectIds: ["ws-allowed"] } } as never;

function crawlSpy() {
  const run = vi.fn(async () => ({ data: { pages: [{ url: "https://a.test/", markdown: "# A" }] }, costUsd: 0.001, costSource: "reported" as const }));
  setWebServiceDeps({
    config: { ...env.web, enabled: true },
    router: new WebRouter({ adapters: [{ id: "firecrawl", keyEnv: "", capabilities: { crawl: { estimateUsd: () => 0.001, run } } }],
      keys: { firecrawl: "k" }, strategy: "cheapest", order: ["firecrawl"], maxAttempts: 1 }),
    assertSafeUrl: async (url) => url, projectAccess: async () => "allowed", assertCanSpend: async () => undefined,
    recordCost: vi.fn(async () => true), recordCharge: vi.fn(async () => ({}) as never),
  });
  return run;
}

afterEach(() => setWebServiceDeps(undefined));

describe("POST /v1/web/ingest preflight", () => {
  it("refuses a restricted key naming a new project before crawling or charging", async () => {
    const run = crawlSpy();
    lookup.mockResolvedValueOnce({ ref: { kind: "slug", slug: "brand-new" }, project: null });
    const response = await webRoutesFor(restrictedKey, "mcp").request("http://mcp.internal/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://a.test/", project: "Brand New" }),
    });
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("ingests a restricted key's default into its own allowlisted project, never the org default", async () => {
    crawlSpy();
    lookup.mockResolvedValueOnce({ ref: { kind: "default" } });
    scoped.mockResolvedValueOnce({ id: "ws-allowed", orgId: "org-1" });
    const intake = vi.spyOn(await import("../services/project-intake-actions.js"), "createWebsiteProjectIntake")
      .mockResolvedValueOnce({ payload: {} as never, status: 201, temporalDeferred: false });
    const response = await webRoutesFor(restrictedKey, "mcp").request("http://mcp.internal/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://a.test/" }),
    });
    expect(response.status).toBe(201);
    expect(intake).toHaveBeenCalledWith(expect.objectContaining({ project: "ws-allowed", allowedProjectIds: ["ws-allowed"] }));
  });

  it("refuses an unknown project ID before crawling", async () => {
    const run = crawlSpy();
    lookup.mockResolvedValueOnce({ ref: { kind: "id", id: "00000000-0000-4000-8000-000000000000" }, project: null });
    const response = await webRoutesFor(restrictedKey, "mcp").request("http://mcp.internal/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://a.test/", project: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
    expect(scoped).not.toHaveBeenCalled();
  });
});

describe("web tools and public client keys", () => {
  const clientKey = (scopes: string[]) => ({ type: "apiKey", userId: "user-1", apiKey: { id: "key-pub", userId: "user-1", orgId: "org-1", keyType: "client", scopes, projectIds: ["ws-allowed"] } }) as never;
  const fetchSpy = () => {
    const run = vi.fn(async () => ({ data: { pages: [], failed: [] }, costUsd: 0, costSource: "reported" as const }));
    setWebServiceDeps({
      config: { ...env.web, enabled: true },
      router: new WebRouter({ adapters: [{ id: "firecrawl", keyEnv: "", capabilities: { fetch: { estimateUsd: () => 0.001, run } } }],
        keys: { firecrawl: "k" }, strategy: "cheapest", order: ["firecrawl"], maxAttempts: 1 }),
      assertSafeUrl: async (url) => url, projectAccess: async () => "allowed", assertCanSpend: async () => undefined,
      recordCost: vi.fn(async () => true), recordCharge: vi.fn(async () => ({}) as never),
    });
    return run;
  };
  const post = (actor: never, path: string, body: unknown) => webRoutesFor(actor, "mcp").request(`http://mcp.internal${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("refuses a search-scoped client key before any provider call", async () => {
    const run = fetchSpy();
    const response = await post(clientKey(["search", "chat"]), "/fetch", { urls: ["https://a.test/"] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "web_scope_required" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses website ingestion to a client key with ingest but no web scope", async () => {
    const run = crawlSpy();
    const response = await post(clientKey(["search", "ingest"]), "/ingest", { url: "https://a.test/" });
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses unverified target fetching even for a key with web scope", async () => {
    const run = fetchSpy();
    scoped.mockResolvedValueOnce({ id: "ws-allowed", orgId: "org-1" });
    const response = await post(clientKey(["search", "web"]), "/fetch", { urls: ["https://a.test/"] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(run).not.toHaveBeenCalled();
  });
});
