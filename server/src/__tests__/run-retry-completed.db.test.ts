import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import type { SqlClient } from "../db.js";
import { createRunLifecycle } from "../services/run-lifecycle.js";
import { startMigratedPostgres } from "../../../worker/src/test/migrated-postgres.js";

// Retrying a completed Run with failed Documents, against the real migrated schema
// (PGlite behind a socket; always runs, unlike run-lifecycle.db.test.ts).
let stop: () => Promise<void>;
let sql: SqlClient;
let client: postgres.Sql;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  await pg.db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, processed_documents, stats)
      values ('run-c', 'o1', 'u1', 'w', 'upload', 'completed', 'completed', '{}', 3, 3, '{"failedDocuments":1,"failedDocumentStages":1,"keep":true}'),
             ('run-d', 'o1', 'u1', 'w', 'upload', 'completed', 'completed', '{}', 1, 1, '{}');
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('a', 'o1', 'u1', 'w', 'run-c', 'a.pdf', 'application/pdf', 'k1', 'completed', 1),
             ('b', 'o1', 'u1', 'w', 'run-c', 'b.pdf', 'application/pdf', 'k2', 'completed', 1),
             ('x', 'o1', 'u1', 'w', 'run-c', 'x.pdf', 'application/pdf', 'k3', 'failed', 1),
             ('d', 'o1', 'u1', 'w', 'run-d', 'd.pdf', 'application/pdf', 'k4', 'completed', 1);
    insert into document_run_stage_states (run_id, document_id, stage_name, status) values
      ('run-c', 'a', 'extract-markdown', 'completed'), ('run-c', 'a', 'embed', 'completed'),
      ('run-c', 'b', 'extract-markdown', 'completed'), ('run-c', 'b', 'embed', 'completed'),
      ('run-c', 'x', 'extract-markdown', 'failed');
    insert into workspace_run_stage_states (run_id, stage_name, status) values
      ('run-c', 'normalize', 'completed'), ('run-c', 'extract-markdown', 'completed'), ('run-c', 'embed', 'completed');
  `);
  const url = pg.url;
  client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  sql = client as unknown as SqlClient;
}, 60_000);

afterAll(async () => {
  await client?.end();
  await stop?.();
});

describe("retrying a completed Run", () => {
  it("reprocesses only the failed Documents and keeps completed checkpoints", async () => {
    const startWorkflow = vi.fn(async () => {});
    const lifecycle = createRunLifecycle({ sql, startWorkflow, failureThreshold: 2 });
    const pipeline = { ...defaultPipelineFeatures };
    await client`update workspace_runs set creation_ready_at = now()`;

    const outcome = await lifecycle.retry({ id: "run-c", status: "completed", pipeline });
    expect(outcome).toEqual({ status: "resumed", start: { status: "started" } });
    expect(startWorkflow).toHaveBeenCalledWith("run-c", pipeline, { restartExisting: true });

    const [run] = await client`select status, stage, processed_documents, stats from workspace_runs where id = 'run-c'`;
    expect(run).toMatchObject({ status: "queued", stage: "queued", processed_documents: 2, stats: { keep: true } });
    expect(run!.stats).not.toHaveProperty("failedDocuments");
    expect(await client`select id, status from documents where run_id = 'run-c' order by id`).toEqual([
      { id: "a", status: "completed" }, { id: "b", status: "completed" }, { id: "x", status: "queued" },
    ]);
    expect(await client`select count(*)::int as n from document_run_stage_states where run_id = 'run-c' and status = 'completed'`)
      .toEqual([{ n: 4 }]);
    expect(await client`select count(*)::int as n from document_run_stage_states where document_id = 'x'`).toEqual([{ n: 0 }]);
    // Run-level checkpoints from the earliest failed stage onward are cleared; earlier ones stay.
    expect(await client`select stage_name from workspace_run_stage_states where run_id = 'run-c'`).toEqual([{ stage_name: "normalize" }]);

    // A second retry (the Run is queued now, not completed) is not a completed-Run retry.
    expect(await lifecycle.retry({ id: "run-c", status: "completed", pipeline })).toEqual({ status: "not-retryable" });
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("rejects a clean completed Run", async () => {
    const startWorkflow = vi.fn(async () => {});
    const lifecycle = createRunLifecycle({ sql, startWorkflow, failureThreshold: 2 });
    expect(await lifecycle.retry({ id: "run-d", status: "completed", pipeline: defaultPipelineFeatures })).toEqual({ status: "not-retryable" });
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(await client`select status from workspace_runs where id = 'run-d'`).toEqual([{ status: "completed" }]);
  });
});
