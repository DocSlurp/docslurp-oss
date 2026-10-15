import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, { unsafe: vi.fn() })
}));

vi.mock("../lib/request-actor.js", () => ({
  getRequestActor: vi.fn(() => ({ type: "session", userId: "user-1" })),
  resolveActorWorkspaceId: vi.fn(async (_actor: unknown, workspaceId?: string) => workspaceId ?? "ws-default"),
}));

const { suggestRoutes } = await import("../routes/suggest.js");

function buildApp() {
  const app = new Hono();
  // Attach a fake session user for the middleware-less test context
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "user-1@docslurp.local", name: "User One" });
    await next();
  });
  app.route("/v1", suggestRoutes);
  return app;
}

describe("suggestRoutes", () => {
  let app: Hono;

  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
    app = buildApp();
  });

  it("falls back to the default workspace when workspaceId is omitted", async () => {
    const res = await app.request("/v1/suggest?q=co");
    expect(res.status).toBe(200);
    expect(JSON.stringify(sqlMock.mock.calls)).toContain("ws-default");
  });

  function mockSemanticRow(row: { indexed_chunk_count: number; completed_documents: number; in_flight_documents: number }) {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("?").includes("in_flight_documents") ? [row] : []);
  }

  it("reports ready when only failed or superseded documents remain outside the corpus", async () => {
    mockSemanticRow({ indexed_chunk_count: 12, completed_documents: 3, in_flight_documents: 0 });
    const res = await app.request("/v1/suggest?workspaceId=ws-1");
    const body = await res.json();
    expect(body.semantic).toEqual({ status: "ready", indexedChunkCount: 12, completedDocuments: 3, totalDocuments: 3 });
  });

  it("reports partial only while current documents are in flight", async () => {
    mockSemanticRow({ indexed_chunk_count: 12, completed_documents: 3, in_flight_documents: 1 });
    const res = await app.request("/v1/suggest?workspaceId=ws-1");
    const body = await res.json();
    expect(body.semantic).toEqual({ status: "partial", indexedChunkCount: 12, completedDocuments: 3, totalDocuments: 4 });
    const semanticQuery = sqlMock.mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join("?"))
      .find((query) => query.includes("in_flight_documents"));
    expect(semanticQuery).toContain("workspace_corpus_stats");
    expect(semanticQuery).toContain("d.superseded_at is null");
  });

  it("returns suggestions array", async () => {
    const res = await app.request("/v1/suggest?workspaceId=ws-1&q=cont&limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.suggestions)).toBe(true);
  });
});
