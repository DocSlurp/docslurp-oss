import { defaultPipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * bulkReprocessDocuments against a migrated database: it must start the Runs it
 * publishes and keep going when one (workspace, pipeline) group cannot be created.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let bulkReprocessDocuments: typeof import("../services/documents.js").bulkReprocessDocuments;
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
  vi.doMock("../services/runs.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../services/runs.js")>();
    return {
      ...original,
      createRun: (args: Parameters<typeof original.createRun>[0]) => {
        if (failAll || args.pipeline.summarize === failingPipeline.summarize) {
          return Promise.reject(Object.assign(new Error("Insufficient credits"), { code: "credit_exhausted" }));
        }
        return original.createRun(args);
      },
    };
  });
  ({ bulkReprocessDocuments } = await import("../services/documents.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values ('o', 'O', 'o', 'u', 1000)`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W')`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

beforeEach(async () => {
  failAll = false;
  startWorkflow.mockClear();
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
});

async function seedDocument(id: string, pipeline: object) {
  const runId = `run-${id}`;
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
    values (${runId}, 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', ${sql.json(pipeline as postgres.JSONValue)}, 1, 2)`;
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
    values (${id}, 'o', 'u', 'w', ${runId}, ${`${id}.pdf`}, 'application/pdf', ${`u/raw/${id}.pdf`}, 'completed', 2)`;
}

describe("bulkReprocessDocuments", () => {
  it("starts each published Run without waiting for the stale-run sweeper", async () => {
    await seedDocument("a", defaultPipelineFeatures);
    const result = await bulkReprocessDocuments(["a"], "u");
    expect(result.failed).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow.mock.calls[0]![0]).toBe(result.runs[0]!.id);
    const [row] = await sql`select workflow_started_at is not null as started from workspace_runs where id = ${result.runs[0]!.id}`;
    expect(row).toEqual({ started: true });
  });

  it("keeps the Run queued and warns when the start fails", async () => {
    await seedDocument("a", defaultPipelineFeatures);
    startWorkflow.mockRejectedValueOnce(new Error("temporal down"));
    const result = await bulkReprocessDocuments(["a"], "u");
    expect(result.runs).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    const [row] = await sql`select status from workspace_runs where id = ${result.runs[0]!.id}`;
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
      { workspaceId: "w", documentIds: expect.arrayContaining(["bad1", "bad2"]), message: "Insufficient credits", code: "credit_exhausted" },
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
