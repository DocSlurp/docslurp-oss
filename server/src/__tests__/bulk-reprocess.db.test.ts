import { defaultPipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * bulkReprocessDocuments against a migrated database: it must start the Runs it
 * publishes and keep going when one (project, pipeline) group cannot be created.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let bulkReprocessDocuments: typeof import("../services/documents.js").bulkReprocessDocuments;
let documents: typeof import("../services/documents.js");
let listAuditLog: typeof import("../services/audit-log.js").listAuditLog;
const startWorkflow = vi.fn(async (..._args: unknown[]) => {});
const failingPipeline = { ...defaultPipelineFeatures, summarize: !defaultPipelineFeatures.summarize };
let failAll = false;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({
    startPipelineWorkflow: startWorkflow, signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
    isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
  }));
  vi.doMock("../services/run-creation.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../services/run-creation.js")>();
    return {
      ...original,
      runCreation: {
        create: (input: Parameters<typeof original.runCreation.create>[0]) => {
          if (failAll || input.pipeline.summarize === failingPipeline.summarize) {
            return Promise.reject(Object.assign(new Error("Insufficient credits"), { code: "credit_exhausted" }));
          }
          return original.runCreation.create(input);
        },
      },
    };
  });
  documents = await import("../services/documents.js");
  ({ bulkReprocessDocuments } = documents);
  ({ listAuditLog } = await import("../services/audit-log.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values ('o', 'O', 'o', 'u', 1000)`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('w', 'o', 'u', 'W'), ('w2', 'o', 'u', 'W2')`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

beforeEach(async () => {
  failAll = false;
  startWorkflow.mockClear();
  await sql`delete from documents`;
  await sql`delete from project_runs`;
});

async function seedDocument(id: string, pipeline: object, project = "w") {
  const runId = `run-${id}`;
  await sql`
    insert into project_runs (monthly_reservation_cents,id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
    values (100, ${runId}, 'o', 'u', ${project}, 'bulk-upload', 'completed', 'completed', ${sql.json(pipeline as postgres.JSONValue)}, 1, 2)`;
  await sql`
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, file_size, page_count)
    values (${id}, 'o', 'u', ${project}, ${runId}, ${`${id}.pdf`}, 'application/pdf', ${`u/raw/${id}.pdf`}, 'completed', 1000, 2)`;
}

describe("bulkReprocessDocuments", () => {
  it("starts each published Run without waiting for the stale-run sweeper", async () => {
    await seedDocument("a", defaultPipelineFeatures);
    const result = await bulkReprocessDocuments(["a"], "u");
    expect(result.failed).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow.mock.calls[0]![0]).toBe(result.runs[0]!.id);
    const [row] = await sql`select workflow_started_at is not null as started from project_runs where id = ${result.runs[0]!.id}`;
    expect(row).toEqual({ started: true });
  });

  it("keeps the Run queued and warns when the start fails", async () => {
    await seedDocument("a", defaultPipelineFeatures);
    startWorkflow.mockRejectedValueOnce(new Error("temporal down"));
    const result = await bulkReprocessDocuments(["a"], "u");
    expect(result.runs).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    const [row] = await sql`select status from project_runs where id = ${result.runs[0]!.id}`;
    expect(row).toEqual({ status: "queued" });
  });

  it("reports a failed group and still reprocesses the others", async () => {
    await seedDocument("ok", defaultPipelineFeatures);
    await seedDocument("bad1", failingPipeline);
    await seedDocument("bad2", failingPipeline);
    const result = await bulkReprocessDocuments(["ok", "bad1", "bad2"], "u");
    expect(result.runs).toHaveLength(1);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(result.failed).toEqual([
      { projectId: "w", documentIds: expect.arrayContaining(["bad1", "bad2"]), message: "Insufficient credits", code: "credit_exhausted" },
    ]);
    expect(result.failed[0]!.documentIds).toHaveLength(2);
    expect(result.warnings).toEqual(["2 documents in w were not reprocessed: Insufficient credits"]);
  });

  it("throws the first error when every group fails", async () => {
    await seedDocument("a", defaultPipelineFeatures);
    await seedDocument("b", failingPipeline);
    failAll = true;
    await expect(bulkReprocessDocuments(["a", "b"], "u")).rejects.toThrow("Insufficient credits");
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

describe("stored pipelines the strict schemas now reject (round 5 M1)", () => {
  // A run row written before the per-extractor option schemas: a Dolphin repoPath and an unknown option key.
  const stale = {
    ...defaultPipelineFeatures,
    documentExtraction: {
      ...defaultPipelineFeatures.documentExtraction,
      options: { dolphin: { mode: "page", repoPath: "/tmp/attacker" }, kreuzberg: { useCache: false } },
    },
  };
  // Fails validation for good: no sanitizing can make it start.
  const invalid = { ...defaultPipelineFeatures, quality: "turbo" };
  const counts = async () => (await sql<{ runs: number; docs: number }[]>`
    select (select count(*)::int from project_runs) as runs, (select count(*)::int from documents) as docs`)[0];
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("bulk reprocess and its estimate succeed on a stale row, with the rejected path dropped", async () => {
    const errors = quiet();
    try {
      await seedDocument("s", stale);
      const { estimateDocumentReprocess } = await import("../services/work-estimates.js");
      expect(await estimateDocumentReprocess({ documentIds: ["s"], userId: "u" })).not.toBeNull();
      const result = await bulkReprocessDocuments(["s"], "u");
      expect(result.failed).toEqual([]);
      expect(result.runs).toHaveLength(1);
      const [row] = await sql<{ pipeline: unknown }[]>`select pipeline from project_runs where id = ${result.runs[0]!.id}`;
      expect(JSON.stringify(row!.pipeline)).not.toContain("/tmp/attacker");
      expect(JSON.stringify(row!.pipeline)).not.toContain("useCache");
      expect(startWorkflow).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(startWorkflow.mock.calls[0]![1])).not.toContain("/tmp/attacker");
    } finally {
      errors.mockRestore();
    }
  });

  it("refuses a permanently invalid row before anything is written (no orphan run or document version)", async () => {
    await seedDocument("x", invalid);
    const before = await counts();
    await expect(bulkReprocessDocuments(["x"], "u")).rejects.toThrow();
    expect(await counts()).toEqual(before);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  describe("queued-run recovery", () => {
    const queued = async (id: string, pipeline: object) => {
      await sql`
        insert into project_runs (monthly_reservation_cents,id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, creation_ready_at)
        values (100, ${id}, 'o', 'u', 'w', 'bulk-upload', 'queued', 'queued', ${sql.json(pipeline as postgres.JSONValue)}, 0, now())`;
    };
    const sweeper = async () => {
      const { createRunLifecycle } = await import("../services/run-lifecycle.js");
      const { createRunStartRecovery } = await import("../services/run-start-recovery.js");
      const lifecycle = createRunLifecycle({ sql: sql as never, startWorkflow, failureThreshold: 3 });
      return createRunStartRecovery({ sql: sql as never, lifecycle, config: { batchSize: 25, leaseMs: 30_000 } });
    };

    it("starts a queued run whose stored pipeline is stale, with the rejected path dropped", async () => {
      const errors = quiet();
      try {
        await queued("q-stale", stale);
        const pass = await (await sweeper()).sweepOnce({ ignoreBackoff: true });
        expect(pass).toMatchObject({ claimed: 1, started: 1, failed: 0 });
        expect(startWorkflow.mock.calls[0]![0]).toBe("q-stale");
        expect(JSON.stringify(startWorkflow.mock.calls[0]![1])).not.toContain("/tmp/attacker");
      } finally {
        errors.mockRestore();
      }
    });

    it("fails a permanently invalid queued run once, with a category, and never claims it again", async () => {
      const errors = quiet();
      try {
        await queued("q-bad", invalid);
        const recovery = await sweeper();
        expect(await recovery.sweepOnce({ ignoreBackoff: true })).toMatchObject({ claimed: 1, started: 0, failed: 1 });
        const [row] = await sql<{ status: string; error: string; stats: { startFailure?: { category?: string } } }[]>`
          select status, error, stats from project_runs where id = 'q-bad'`;
        expect(row!.status).toBe("failed");
        expect(row!.stats.startFailure?.category).toBe("invalid_pipeline");
        // The public error does not echo the raw validation message.
        expect(row!.error).not.toContain("turbo");
        expect(await recovery.sweepOnce({ ignoreBackoff: true })).toMatchObject({ claimed: 0 });
        expect(startWorkflow).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  });
});

describe("bulk reprocess never replays an old run snapshot's model values", () => {
  it("creates the new run on the current defaults and the project's explicit overrides", async () => {
    const legacy = {
      ...defaultPipelineFeatures,
      vision: { profile: "good-fast-hosted", modelUri: "llm://openrouter/deepseek/deepseek-v4.1-flash-1017", target: "hosted", remoteFallbackModelUri: null },
      textGeneration: { model: "z-ai/glm-5.3-flash", models: { "document-summary": "qwen/qwen3.5-flash-02-23" } },
      visualPages: { route: "gemini", coarseFallback: false },
    };
    await seedDocument("legacy", legacy);
    await sql`update projects set managed_models = ${sql.json({ pipeline: { structuredExtraction: { model: "llm://private/gpu1/acme/extract" } } })} where id = 'w'`;
    try {
      const result = await bulkReprocessDocuments(["legacy"], "u");
      expect(result.failed).toEqual([]);
      const [run] = await sql<{ pipeline: Record<string, Record<string, unknown>> }[]>`select pipeline from project_runs where kind = 'bulk-reprocess' order by created_at desc limit 1`;
      expect(run!.pipeline.vision!.modelUri).not.toMatch(/deepseek/);
      expect(run!.pipeline.textGeneration).toMatchObject({ model: null, models: {} });
      expect(run!.pipeline.visualPages!.route).toBe("auto");
      expect(run!.pipeline.structuredExtraction!.model).toBe("llm://private/gpu1/acme/extract");
    } finally {
      await sql`update projects set managed_models = '{}'::jsonb where id = 'w'`;
    }
  });
});

describe("document audit records: written in their change's transaction, scoped to the organization", () => {
  /** A record a route would build; the service adds orgId, projectId (and runId) from the rows it changed. */
  const record = (action: string, marker: string, ids: string[] = []) => ({ userId: "u", action, resourceType: "document-bulk", resourceId: ids.slice(0, 20).join(","), metadata: { marker, documentIds: ids } });
  const failing = (marker: string) => () => ({ userId: "u", action: null as unknown as string, resourceType: "document-bulk", metadata: { marker } });
  const byMarker = (marker: string) => sql<{ action: string; org_id: string | null; project_id: string | null; run_id: string | null; ids: string[] }[]>`
    select action, org_id, project_id, run_id, array(select jsonb_array_elements_text(metadata -> 'documentIds')) as ids
    from audit_log where metadata ->> 'marker' = ${marker} order by created_at, action`;

  it("two reprocess groups make two runs and exactly two audit records, each with its org, project and run", async () => {
    await seedDocument("g1", defaultPipelineFeatures, "w");
    await seedDocument("g2", defaultPipelineFeatures, "w2");
    const marker = `reprocess-${Math.random()}`;
    const result = await bulkReprocessDocuments(["g1", "g2"], "u", { audit: (run) => record("documents.bulk_reprocessed", marker, run.documentIds) });
    expect(result.runs).toHaveLength(2);
    const rows = await byMarker(marker);
    expect(rows).toHaveLength(2);
    const runIds = new Set(result.runs.map((run) => run.id));
    for (const row of rows) {
      expect(row.org_id).toBe("o");
      expect(runIds.has(row.run_id!)).toBe(true);
      expect(row.ids).toEqual([row.project_id === "w" ? "g1" : "g2"]);
    }
    expect(new Set(rows.map((row) => row.project_id))).toEqual(new Set(["w", "w2"]));
  });

  it("an audit insert that fails inside the publish transaction leaves no run, no documents, no record and no workflow start", async () => {
    await seedDocument("p1", defaultPipelineFeatures);
    const before = (await sql<{ runs: number; docs: number }[]>`select (select count(*)::int from project_runs) as runs, (select count(*)::int from documents) as docs`)[0];
    const marker = `publish-fail-${Math.random()}`;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(bulkReprocessDocuments(["p1"], "u", { audit: failing(marker) })).rejects.toBeTruthy();
    } finally {
      errors.mockRestore();
    }
    const after = (await sql<{ runs: number; docs: number }[]>`select (select count(*)::int from project_runs) as runs, (select count(*)::int from documents) as docs`)[0];
    expect(after).toEqual(before);
    expect(await byMarker(marker)).toEqual([]);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("a failed audit insert rolls back a single-document tag replacement", async () => {
    await seedDocument("t1", defaultPipelineFeatures);
    await sql`insert into document_tags (document_id, user_id, tag) values ('t1', 'u', 'kept')`;
    const marker = `tags-fail-${Math.random()}`;
    await expect(documents.setDocumentTags("t1", "u", ["replaced"], failing(marker))).rejects.toBeTruthy();
    expect(await sql`select tag from document_tags where document_id = 't1' order by tag`).toEqual([{ tag: "kept" }]);
    expect(await byMarker(marker)).toEqual([]);
  });

  it("single delete, bulk delete, tag changes and reprocess records all appear in the org-scoped audit query", async () => {
    for (const id of ["s1", "b1", "b2", "t2", "r1"]) await seedDocument(id, defaultPipelineFeatures);
    const marker = `scoped-${Math.random()}`;
    await documents.setDocumentTags("t2", "u", ["one"], (tags) => record("document.tags.updated", marker, ["t2", ...tags]));
    await documents.addDocumentTags(["t2", "r1"], "u", ["two"], (ids) => record("documents.tags.bulk_applied", marker, ids));
    await documents.removeDocumentTags(["t2"], "u", ["two"], (ids) => record("documents.tags.bulk_removed", marker, ids));
    await bulkReprocessDocuments(["r1"], "u", { audit: (run) => record("documents.bulk_reprocessed", marker, run.documentIds) });
    await documents.deleteDocument("s1", "u", (row) => record("document.deleted", marker, [row.documentId]));
    await documents.deleteDocuments(["b1", "b2"], "u", (rows) => record("documents.deleted", marker, rows.map((row) => row.documentId)));
    const actions = ["document.tags.updated", "documents.tags.bulk_applied", "documents.tags.bulk_removed", "documents.bulk_reprocessed", "document.deleted", "documents.deleted"];
    // Every record carries the organization and project of the rows it covers ...
    const rows = await byMarker(marker);
    expect(rows.map((row) => row.action).sort()).toEqual([...actions].sort());
    for (const row of rows) expect(row).toMatchObject({ org_id: "o", project_id: "w" });
    // ... so the org-scoped read (a member of the organization) returns them.
    const visible = (await listAuditLog({ actorUserId: "u", limit: 200 })).filter((entry) => entry.metadata.marker === marker);
    expect(visible.map((entry) => entry.action).sort()).toEqual([...actions].sort());
    for (const entry of visible) expect(entry.orgId).toBe("o");
    const byOrg = (await listAuditLog({ orgId: "o", limit: 200 })).filter((entry) => entry.metadata.marker === marker);
    expect(byOrg).toHaveLength(actions.length);
  });
});
