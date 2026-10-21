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

const suggestedQuestionsMock = vi.fn(async (_args: unknown) => ({ questions: [] as string[], pending: false }));
vi.mock("../services/workspace-suggested-questions.js", () => ({
  workspaceSuggestedQuestions: (args: unknown) => suggestedQuestionsMock(args),
}));

const { suggestRoutes, isGenericHeading } = await import("../routes/suggest.js");

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
    suggestedQuestionsMock.mockClear();
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

  it("never suggests encrypted or hashed stored queries", async () => {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("from search_sessions")) {
        expect(query).toContain("s.query not like 'enc:%'");
        return [{ phrase: "enc:pgp:v1:ww0EBwMC", weight: 10 }, { phrase: "redacted:sha256:abc", weight: 10 }];
      }
      if (query.includes("from documents d")) return [{ phrase: "catalog.pdf", weight: 5 }];
      return [];
    });
    const body = await (await app.request("/v1/suggest?workspaceId=ws-1")).json();
    expect(body.suggestions).toEqual(["catalog.pdf"]);
  });

  it("leads with questions written from the documents, then specific headings", async () => {
    suggestedQuestionsMock.mockResolvedValueOnce({ questions: ["Which suppliers raised prices in 2025?"], pending: true });
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("in_flight_documents")) return [{ indexed_chunk_count: 4, completed_documents: 1, in_flight_documents: 0 }];
      if (query.includes("as hits")) return [{ heading: "Introduction", hits: 9 }, { heading: "Freight surcharges", hits: 3 }];
      if (query.includes("order by d.updated_at desc")) return [{ filename: "catalog.pdf" }];
      return [];
    });
    const body = await (await app.request("/v1/suggest?workspaceId=ws-1")).json();
    expect(suggestedQuestionsMock).toHaveBeenCalledWith({ workspaceId: "ws-1", userId: "user-1", settled: true });
    expect(body.contextualSuggestions).toEqual([
      "Which suppliers raised prices in 2025?",
      "What does Freight surcharges cover?",
      "Summarize catalog.pdf",
    ]);
    expect(body.contextualPending).toBe(true);
  });

  it("treats boilerplate section names as generic", () => {
    for (const heading of ["Introduction", "2.1 Methods", "Table of Contents", "Page 3", "Figure 12", "##", "IV. Conclusion"]) {
      expect(isGenericHeading(heading)).toBe(true);
    }
    expect(isGenericHeading("Freight surcharges")).toBe(false);
  });
});
