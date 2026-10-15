import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestActor } from "../lib/request-actor.js";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  loadActorScopedWorkspace: vi.fn(),
}));

vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../lib/request-actor.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/request-actor.js")>("../lib/request-actor.js");
  return { ...actual, loadActorScopedWorkspace: mocks.loadActorScopedWorkspace };
});

const { suggestRoutes } = await import("../routes/suggest.js");

function appFor(actor: RequestActor) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestActor", actor);
    c.set("sessionUser", { id: actor.userId, email: "", name: "" });
    if (actor.type === "apiKey") c.set("apiKey", actor.apiKey);
    await next();
  });
  app.route("/v1", suggestRoutes);
  return app;
}

const session: RequestActor = { type: "session", userId: "user-1", sessionId: "s", user: { id: "user-1", email: "a@b.test", name: "A" } };
const apiKey = (scopes: string[]): RequestActor => ({
  type: "apiKey",
  userId: "user-1",
  apiKey: { keyId: "k", userId: "user-1", orgId: "org-1", keyType: "server", allowedDomains: [], scopes, rateLimitRpm: 60, rateLimitPpd: 100, rateLimits: [], workspaceIds: [] },
});

describe("GET /v1/search/diagnostics", () => {
  beforeEach(() => {
    mocks.sql.mockReset().mockResolvedValue([{ reason: "no_matches", suggestions: ["x"], created_at: "2026-01-01", workspace_id: "ws-other" }]);
    mocks.loadActorScopedWorkspace.mockReset();
  });

  it("hides diagnostics for a session in a workspace the actor cannot read", async () => {
    mocks.loadActorScopedWorkspace.mockResolvedValue(null);
    const response = await appFor(session).request("/v1/search/diagnostics?sessionId=foreign");
    expect(await response.json()).toEqual({ diagnostics: null });
    expect(mocks.loadActorScopedWorkspace).toHaveBeenCalledWith("ws-other", session);
  });

  it("returns diagnostics when the workspace is accessible", async () => {
    mocks.loadActorScopedWorkspace.mockResolvedValue({ id: "ws-other", orgId: "org-1" });
    const response = await appFor(session).request("/v1/search/diagnostics?sessionId=mine");
    expect(await response.json()).toEqual({ diagnostics: { reason: "no_matches", suggestions: ["x"], createdAt: "2026-01-01" } });
  });

  it("requires the search scope for API keys", async () => {
    const response = await appFor(apiKey(["ingest"])).request("/v1/search/diagnostics?sessionId=mine");
    expect(response.status).toBe(403);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
