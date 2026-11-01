import { defaultPipelineFeatures } from "@docslurp/shared";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";
import { withTestSession } from "./helpers/session-app.js";

/** HTTP-level behaviour of the indexing-mode routes against a migrated database. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let app: Hono;
let dispatch: (path: string, init?: RequestInit) => Promise<Response>;
const startRun = vi.fn(async () => ({ status: "started" }));

const actor = { type: "session", userId: "u1", sessionId: "s", user: { id: "u1", email: "a@x", name: "A" } } as never;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (v: unknown) => String(v), parse: (v: string): unknown => Number(v) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/run-lifecycle.js", () => ({ runLifecycle: { start: startRun } }));
  vi.doMock("../services/audit-log.js", () => ({ appendAuditLog: vi.fn(async () => undefined) }));
  vi.doMock("../services/documents.js", () => ({
    getDocumentViewerPayload: async (id: string) => {
      const [row] = await sql<{ id: string; workspace_id: string }[]>`select id, workspace_id from documents where id = ${id}`;
      return row ? { document: { id: row.id, workspaceId: row.workspace_id } } : null;
    },
  }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  // "free" is a starter org; "gold" and "broke" are funded (funded_at set by a paid grant).
  const org = (id: string, plan: string, cents: number) =>
    sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at) values (${id}, ${id}, ${id}, 'u1', ${cents}, ${plan === "free" ? null : new Date()})`;
  await org("free", "free", 0);
  await org("gold", "gold", 1000);
  await org("broke", "gold", 0);
  for (const id of ["free", "gold", "broke"]) await sql`insert into org_memberships(org_id, user_id, role) values (${id}, 'u1', 'owner')`;
  const { workspacesRoutes } = await import("../routes/workspaces.js");
  const { documentsRoutes } = await import("../routes/documents.js");
  const { spendAwareErrorHandler } = await import("../services/billing/spend-guard.js");
  const { createMcpDispatcher } = await import("../services/mcp-tools.js");
  app = withTestSession(new Hono(), { id: "u1" });
  app.route("/v1/workspaces", workspacesRoutes);
  app.route("/v1/documents", documentsRoutes);
  app.onError(spendAwareErrorHandler);
  dispatch = createMcpDispatcher(actor);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(() => {
  process.env.DOCSLURP_DEFERRED_PROFILES = "1";
  startRun.mockClear();
});
afterEach(async () => {
  delete process.env.DOCSLURP_DEFERRED_PROFILES;
  await sql`delete from workspaces where id like 't-%'`;
});

async function seedWorkspace(id: string, orgId: string, mode: "full" | "map" | "visual", pipeline: Record<string, unknown> = {}) {
  await sql`insert into workspaces(id, org_id, user_id, name, pipeline) values (${id}, ${orgId}, 'u1', ${id}, ${sql.json({ ...defaultPipelineFeatures, ...pipeline, indexingMode: mode } as never)})`;
}
async function seedDoc(id: string, workspaceId: string, orgId: string, pages: number, indexed: number, mode: "full" | "map" | "visual" = "map", purged = false) {
  await sql`insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total, artifacts_purged_at)
    values (${`run-${id}`}, ${orgId}, 'u1', ${workspaceId}, 'bulk-upload', 'completed', 'completed', ${sql.json(defaultPipelineFeatures as never)}, 1, ${pages}, ${purged ? new Date() : null})`;
  await sql`insert into documents(id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, indexing_mode)
    values (${id}, ${orgId}, 'u1', ${workspaceId}, ${`run-${id}`}, ${`${id}.pdf`}, 'application/pdf', ${`raw/${id}.pdf`}, 'completed', ${pages}, ${mode})`;
  for (let page = 1; page <= indexed; page += 1) {
    await sql`insert into document_page_states(document_id, page_number, state) values (${id}, ${page}, 'indexed')`;
  }
}
const { indexingMode: _mode, ...withoutMode } = defaultPipelineFeatures;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const storedMode = async (id: string) => (await sql<{ m: string }[]>`select pipeline ->> 'indexingMode' as m from workspaces where id = ${id}`)[0]?.m;

describe("POST /v1/workspaces", () => {
  it("applies the same default to every org when the body has a pipeline without a mode", async () => {
    for (const orgId of ["free", "gold"]) {
      const res = await app.request("/v1/workspaces", json("POST", { name: "P", orgId, pipeline: {} }));
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ indexingMode: "full" });
    }
  });

  it("accepts an explicit full on a free org", async () => {
    const res = await app.request("/v1/workspaces", json("POST", { name: "P", orgId: "free", pipeline: { indexingMode: "full" } }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ indexingMode: "full" });
  });
});

describe("PATCH /v1/workspaces/:id indexing mode", () => {
  it("parses pipeline.indexingMode from the raw body and returns indexingJob", async () => {
    await seedWorkspace("t-vis", "gold", "map");
    await seedDoc("t-vis-a", "t-vis", "gold", 4, 4);
    const res = await app.request("/v1/workspaces/t-vis", json("PATCH", { pipeline: { indexingMode: "visual" } }));
    expect(res.status).toBe(200);
    const body = await res.json() as { indexingMode: string; indexingJob?: { runIds: string[] } };
    expect(body.indexingMode).toBe("visual");
    expect(body.indexingJob?.runIds).toHaveLength(1);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("does not flip the mode on a pipeline edit without a mode", async () => {
    await seedWorkspace("t-keep", "gold", "map");
    const res = await app.request("/v1/workspaces/t-keep", json("PATCH", { pipeline: withoutMode }));
    expect(res.status).toBe(200);
    expect(await storedMode("t-keep")).toBe("map");
  });

  it("indexes everything only when indexAll is true, and a repeat does not double-spend", async () => {
    await seedWorkspace("t-all", "gold", "map");
    await seedDoc("t-all-a", "t-all", "gold", 6, 1);
    const plain = await app.request("/v1/workspaces/t-all", json("PATCH", { pipeline: { indexingMode: "full" } }));
    expect((await plain.json() as { indexingJob?: unknown }).indexingJob).toBeUndefined();
    await sql`update workspaces set pipeline = jsonb_set(pipeline, '{indexingMode}', '"map"') where id = 't-all'`;
    const first = await app.request("/v1/workspaces/t-all", json("PATCH", { pipeline: { indexingMode: "full" }, indexAll: true }));
    expect((await first.json() as { indexingJob?: { runIds: string[] } }).indexingJob?.runIds).toHaveLength(1);
    await sql`update workspaces set pipeline = jsonb_set(pipeline, '{indexingMode}', '"map"') where id = 't-all'`;
    const again = await app.request("/v1/workspaces/t-all", json("PATCH", { pipeline: { indexingMode: "full" }, indexAll: true }));
    expect((await again.json() as { indexingJob?: unknown }).indexingJob).toBeUndefined();
    expect(Number((await sql<{ n: number }[]>`select count(*)::int as n from workspace_runs where kind = 'full-index' and workspace_id = 't-all'`)[0]?.n)).toBe(1);
  });

  it("rejects an impossible backfill before saving the mode", async () => {
    await seedWorkspace("t-purged", "gold", "map");
    await seedDoc("t-purged-a", "t-purged", "gold", 4, 4, "map", true);
    const res = await app.request("/v1/workspaces/t-purged", json("PATCH", { pipeline: { indexingMode: "visual" } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { details: { category: "backfill_not_possible" } } });
    expect(await storedMode("t-purged")).toBe("map");
    expect(Number((await sql<{ n: number }[]>`select count(*)::int as n from workspace_runs where kind = 'full-index'`)[0]?.n)).toBe(0);
  });

  it("rolls the mode back when jobs cannot be admitted", async () => {
    await seedWorkspace("t-broke", "broke", "map");
    await seedDoc("t-broke-a", "t-broke", "broke", 4, 1);
    const res = await app.request("/v1/workspaces/t-broke", json("PATCH", { pipeline: { indexingMode: "full" }, indexAll: true }));
    expect(res.status).toBe(402);
    expect(await storedMode("t-broke")).toBe("map");
  });

  it("refuses a switch that would touch more than 500 documents", async () => {
    await seedWorkspace("t-big", "gold", "map");
    await seedDoc("t-big-0", "t-big", "gold", 2, 2);
    await sql`insert into documents(id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, indexing_mode)
      select 't-big-' || g, 'gold', 'u1', 't-big', 'run-t-big-0', 'f' || g, 'application/pdf', 'raw/' || g, 'completed', 2, 'map' from generate_series(1, 500) g`;
    const res = await app.request("/v1/workspaces/t-big", json("PATCH", { pipeline: { indexingMode: "visual" } }));
    expect(res.status).toBe(413);
    expect(await storedMode("t-big")).toBe("map");
  });

  it("keeps the stored raw mode when the flag is off", async () => {
    await seedWorkspace("t-off", "gold", "visual");
    process.env.DOCSLURP_DEFERRED_PROFILES = "0";
    const res = await app.request("/v1/workspaces/t-off", json("PATCH", { name: "renamed", pipeline: withoutMode }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ indexingMode: "full", deferredIndexingAvailable: false });
    expect(await storedMode("t-off")).toBe("visual");
  });
});

describe("full-index routes", () => {
  it("returns 404 for the three routes when the flag is off", async () => {
    await seedWorkspace("t-404", "gold", "map");
    await seedDoc("t-404-a", "t-404", "gold", 4, 1);
    process.env.DOCSLURP_DEFERRED_PROFILES = "0";
    for (const [path, body] of [
      ["/v1/workspaces/t-404/full-index", {}],
      ["/v1/workspaces/t-404/indexing-mode/estimate", { mode: "full" }],
      ["/v1/documents/t-404-a/full-index", {}],
    ] as const) {
      expect((await app.request(path, json("POST", body))).status, path).toBe(404);
    }
  });

  it("starts one run, then reports index_in_progress instead of double-spending", async () => {
    await seedWorkspace("t-fi", "gold", "map");
    await seedDoc("t-fi-a", "t-fi", "gold", 6, 1);
    const first = await app.request("/v1/workspaces/t-fi/full-index", json("POST", {}));
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ pages: 5 });
    const second = await app.request("/v1/workspaces/t-fi/full-index", json("POST", {}));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { details: { category: "index_in_progress" } } });
    const viaDoc = await app.request("/v1/documents/t-fi-a/full-index", json("POST", {}));
    expect(viaDoc.status).toBe(409);
  });

  it("document route: 202 for an allowed document, 404 for unknown, 403 when policy forbids", async () => {
    await seedWorkspace("t-doc", "gold", "map");
    await seedDoc("t-doc-a", "t-doc", "gold", 3, 0);
    expect((await app.request("/v1/documents/nope/full-index", json("POST", {}))).status).toBe(404);
    await seedWorkspace("t-doc2", "gold", "map", { materialization: { allowFullIndexRequest: false } });
    await seedDoc("t-doc2-a", "t-doc2", "gold", 3, 0);
    const denied = await app.request("/v1/documents/t-doc2-a/full-index", json("POST", {}));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { details: { category: "full_index_not_allowed" } } });
    expect((await app.request("/v1/documents/t-doc-a/full-index", json("POST", {}))).status).toBe(202);
  });

  it("MCP fullIndex: happy path and policy denial", async () => {
    await seedWorkspace("t-mcp", "gold", "map");
    await seedDoc("t-mcp-a", "t-mcp", "gold", 5, 2);
    const ok = await dispatch("/tools/fullIndex", json("POST", { workspace: "t-mcp" }));
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ tool: "fullIndex", pages: 3 });
    await seedWorkspace("t-mcp2", "gold", "map", { materialization: { allowFullIndexRequest: false } });
    await seedDoc("t-mcp2-a", "t-mcp2", "gold", 5, 2);
    const denied = await dispatch("/tools/fullIndex", json("POST", { workspace: "t-mcp2" }));
    expect(denied.status).toBe(403);
    process.env.DOCSLURP_DEFERRED_PROFILES = "0";
    expect((await dispatch("/tools/fullIndex", json("POST", { workspace: "t-mcp" }))).status).toBe(404);
  });
});

describe("stored extractor settings the strict schemas reject (round 4 M2)", () => {
  const hostile = {
    options: { dolphin: { mode: "page", repoPath: "/tmp/attacker" }, kreuzberg: { useCache: false }, liteparse: {} },
    ocr: { language: "en", autoRotate: true },
  };

  it("lists and gets a workspace and run whose stored pipeline has them, with every rejected path gone", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await seedWorkspace("t-stale-x", "gold", "full", { quality: "fast", documentExtraction: { ...defaultPipelineFeatures.documentExtraction, ...hostile } });
      await sql`insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('t-stale-run', 'gold', 'u1', 't-stale-x', 'bulk-upload', 'completed', 'completed',
          ${sql.json({ ...defaultPipelineFeatures, documentExtraction: { ...defaultPipelineFeatures.documentExtraction, ...hostile } } as never)}, 1)`;
      const list = await app.request("/v1/workspaces");
      expect(list.status).toBe(200);
      const get = await app.request("/v1/workspaces/t-stale-x");
      expect(get.status).toBe(200);
      const body = await get.json() as { pipeline: { quality: string; documentExtraction: { options: unknown; ocr: { language: string } } } };
      expect(body.pipeline.quality).toBe("fast");
      expect(body.pipeline.documentExtraction.options).toEqual({ kreuzberg: {}, dolphin: { mode: "page" } });
      expect(body.pipeline.documentExtraction.ocr.language).toBe("eng");
      expect(JSON.stringify(await list.json())).not.toContain("/tmp/attacker");
      const runs = await import("../services/runs.js");
      const listed = (await runs.listRuns("u1")).filter((run) => run.id === "t-stale-run");
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain("/tmp/attacker");
      const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("workspace t-stale-x");
      expect(logged).toContain("documentExtraction.options.dolphin.repoPath");
      expect(logged).toContain("run t-stale-run");
    } finally {
      errors.mockRestore();
      await sql`delete from workspace_runs where id = 't-stale-run'`;
    }
  });

  it("full index and its estimate succeed on a stale workspace row, and the run row drops the rejected paths (round 5 M1)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await seedWorkspace("t-stale-fi", "gold", "map", { documentExtraction: { ...defaultPipelineFeatures.documentExtraction, ...hostile } });
      await seedDoc("t-stale-fi-a", "t-stale-fi", "gold", 5, 2);
      const estimate = await app.request("/v1/workspaces/t-stale-fi/full-index/estimate", json("POST", {}));
      expect(estimate.status).toBe(200);
      const res = await app.request("/v1/workspaces/t-stale-fi/full-index", json("POST", {}));
      expect(res.status).toBe(202);
      const [run] = await sql<{ pipeline: unknown }[]>`select pipeline from workspace_runs where kind = 'full-index' and workspace_id = 't-stale-fi'`;
      expect(run).toBeDefined();
      expect(JSON.stringify(run!.pipeline)).not.toContain("/tmp/attacker");
      expect(JSON.stringify(run!.pipeline)).not.toContain("useCache");
      expect((run!.pipeline as { documentExtraction: { ocr: { language: string } } }).documentExtraction.ocr.language).not.toBe("en");
    } finally {
      errors.mockRestore();
    }
  });

  it("rejects the same settings on write with 400", async () => {
    await seedWorkspace("t-strict-x", "gold", "full");
    for (const documentExtraction of [
      { options: { dolphin: { repoPath: "/tmp/attacker" } } },
      { options: { kreuzberg: { useCache: false } } },
      { options: { liteparse: {} } },
      { ocr: { language: "en" } },
    ]) {
      const patch = await app.request("/v1/workspaces/t-strict-x", json("PATCH", { pipeline: { documentExtraction } }));
      expect(patch.status, JSON.stringify(documentExtraction)).toBe(400);
      const create = await app.request("/v1/workspaces", json("POST", { name: "S", orgId: "gold", pipeline: { documentExtraction } }));
      expect(create.status, JSON.stringify(documentExtraction)).toBe(400);
    }
    const stored = (await sql<{ p: unknown }[]>`select pipeline -> 'documentExtraction' -> 'options' as p from workspaces where id = 't-strict-x'`)[0]?.p;
    expect(JSON.stringify(stored ?? {})).not.toContain("/tmp/attacker");
  });
});
