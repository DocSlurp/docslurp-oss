import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Workspace deletion and discarded intake against a migrated Postgres: in-flight
 * runs are cancelled through Temporal first, and every deleted document and run
 * lands in the cleanup queues (docs/data-deletion.md).
 */

const cancelWorkflow = vi.fn(async (_runId: string) => {});
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, postgres.PostgresType>>;
let workspaces: typeof import("../services/workspaces.js");
let runManifest: typeof import("../services/run-creation.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  // The PGlite socket serves one connection at a time.
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({
    signalPipelineCancel: cancelWorkflow,
    signalPipelinePause: vi.fn(),
    signalPipelineResume: vi.fn(),
    startPipelineWorkflow: vi.fn(),
  }));
  vi.doMock("../services/workspace-naming.js", () => ({ refineWorkspaceNames: async () => {} }));
  workspaces = await import("../services/workspaces.js");
  runManifest = await import("../services/run-creation.js");

  await sql`insert into "user"(id, name, email) values ('owner', 'Owner', 'owner@example.test')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org', 'Org', 'org', 'owner')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('org', 'owner', 'owner')`;
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  cancelWorkflow.mockClear();
  await sql`delete from workspaces`;
  await sql`delete from document_cleanup_queue`;
  await sql`delete from storage_cleanup_queue`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('ws', 'org', 'owner', 'Contracts')`;
});

async function seedRun(id: string, status: string) {
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pipeline)
    values (${id}, 'org', 'owner', 'ws', 'bulk-upload', ${status}, ${status}, 1, '{}'::jsonb)
  `;
}

async function seedDocument(id: string, runId: string, status = "completed") {
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    values (${id}, 'org', 'owner', 'ws', ${runId}, ${`${id}.pdf`}, 'application/pdf', ${`owner/up/raw/${id}.pdf`}, ${status})
  `;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`vi-${id}`}, ${id}, 'lancedb', 'b', 'p', 'm', 4)`;
}

describe("workspace delete", () => {
  it("cancels in-flight runs, then enqueues cleanup for every document and run", async () => {
    await seedRun("done", "completed");
    await seedRun("live", "processing");
    await seedDocument("d1", "done");
    await seedDocument("d2", "live", "processing");

    const deleted = await workspaces.deleteWorkspace("ws", "owner", "Contracts");

    expect(deleted.id).toBe("ws");
    expect(cancelWorkflow.mock.calls.map(([runId]) => runId)).toEqual(["live"]);
    expect(await sql`select count(*)::int as count from workspaces where id = 'ws'`).toEqual([{ count: 0 }]);
    expect(await sql`select document_id, vector_targets from document_cleanup_queue order by document_id`).toEqual([
      { document_id: "d1", vector_targets: [{ backend: "lancedb", embeddingModel: "m", dimension: 4 }] },
      { document_id: "d2", vector_targets: [{ backend: "lancedb", embeddingModel: "m", dimension: 4 }] },
    ]);
    // The workspace's LanceDB database is dropped whole, after the in-flight grace.
    expect(await sql`select kind, target, payload, reason, not_before > now() + interval '10 minutes' as deferred
      from storage_cleanup_queue order by target`).toEqual([
      { kind: "vector_prefix", target: "org|ws", payload: { workspaceId: "ws" }, reason: "workspace_deleted", deferred: true },
      { kind: "vector_table", target: "org|ws|m|4", payload: { workspaceId: "ws", embeddingModel: "m", dimension: 4 }, reason: "workspace_deleted", deferred: true },
      { kind: "storage_prefix", target: "owner/done/", payload: { workspaceId: "ws" }, reason: "run_deleted", deferred: false },
      { kind: "storage_prefix", target: "owner/live/", payload: { workspaceId: "ws" }, reason: "run_deleted", deferred: false },
    ]);
  });

  it("deletes in batches without losing documents", async () => {
    await seedRun("r", "completed");
    for (let index = 0; index < 7; index += 1) await seedDocument(`doc-${index}`, "r");
    const { deleteWorkspaceData } = await import("../services/data-deletion.js");

    expect(await deleteWorkspaceData("ws", { sql, cancelWorkflow, documentBatchSize: 3 })).toEqual({ documents: 7, runs: 1 });
    expect(await sql`select count(*)::int as count from document_cleanup_queue`).toEqual([{ count: 7 }]);
  });

  it("still deletes when Temporal is unreachable", async () => {
    await seedRun("live", "processing");
    cancelWorkflow.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await workspaces.deleteWorkspace("ws", "owner", "Contracts");
    expect(await sql`select target from storage_cleanup_queue order by target`).toEqual([{ target: "org|ws" }, { target: "owner/live/" }]);
  });
});

describe("discarded intake", () => {
  it("enqueues cleanup for the documents and raw uploads of a run that never started", async () => {
    await seedRun("queued-run", "queued");
    await seedDocument("upload", "queued-run", "queued");

    expect(await runManifest.discardUnstartedRun("queued-run", sql)).toBe(true);
    expect(await sql`select document_id, source_key, delete_source from document_cleanup_queue`)
      .toEqual([{ document_id: "upload", source_key: "owner/up/raw/upload.pdf", delete_source: true }]);
    expect(await sql`select target from storage_cleanup_queue`).toEqual([{ target: "owner/queued-run/" }]);
  });
});
