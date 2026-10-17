import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import type { SqlClient } from "../db.js";
import { createRunLifecycle } from "../services/run-lifecycle.js";
import { startMigratedPostgres } from "@docslurp/worker/testing";

// A retried Document must not keep serving the previous attempt's chunks as
// early keyword results (lexical_searchable_at, server/src/search/eligibility.ts)
// while its chunks are rewritten; a Document whose embed stage already
// completed keeps a complete chunk set and its marker.
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
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, processed_documents, stats, creation_ready_at)
      values ('run-failed', 'o1', 'u1', 'w', 'upload', 'failed', 'index', '{}', 3, 0, '{}', now()),
             ('run-partial', 'o1', 'u1', 'w', 'upload', 'completed', 'completed', '{}', 3, 3, '{"failedDocuments":2}', now());
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, lexical_searchable_at)
      values ('f-embed-failed', 'o1', 'u1', 'w', 'run-failed', 'a.pdf', 'application/pdf', 'k1', 'failed', 1, now()),
             ('f-index-failed', 'o1', 'u1', 'w', 'run-failed', 'b.pdf', 'application/pdf', 'k2', 'failed', 1, now()),
             ('f-done', 'o1', 'u1', 'w', 'run-failed', 'c.pdf', 'application/pdf', 'k3', 'completed', 1, now()),
             ('p-embed-failed', 'o1', 'u1', 'w', 'run-partial', 'd.pdf', 'application/pdf', 'k4', 'failed', 1, now()),
             ('p-index-failed', 'o1', 'u1', 'w', 'run-partial', 'e.pdf', 'application/pdf', 'k5', 'failed', 1, now()),
             ('p-done', 'o1', 'u1', 'w', 'run-partial', 'f.pdf', 'application/pdf', 'k6', 'completed', 1, now());
    insert into document_run_stage_states (run_id, document_id, stage_name, status) values
      ('run-failed', 'f-embed-failed', 'embed', 'failed'),
      ('run-failed', 'f-index-failed', 'embed', 'completed'), ('run-failed', 'f-index-failed', 'index', 'failed'),
      ('run-partial', 'p-embed-failed', 'embed', 'failed'),
      ('run-partial', 'p-index-failed', 'embed', 'completed'), ('run-partial', 'p-index-failed', 'index', 'failed');
  `);
  client = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  sql = client as unknown as SqlClient;
}, 60_000);

afterAll(async () => {
  await client?.end();
  await stop?.();
});

const marked = (runId: string) => client`
  select id, lexical_searchable_at is not null as marked from documents where run_id = ${runId} order by id`;

describe("retry and the early keyword marker", () => {
  it("lifts the marker of a failed Run's unfinished Documents, keeping those whose embed completed", async () => {
    const lifecycle = createRunLifecycle({ sql, startWorkflow: vi.fn(async () => {}), failureThreshold: 2 });
    const outcome = await lifecycle.retry({ id: "run-failed", status: "failed", pipeline: defaultPipelineFeatures });
    expect(outcome).toMatchObject({ status: "resumed" });
    expect(await marked("run-failed")).toEqual([
      { id: "f-done", marked: true },
      { id: "f-embed-failed", marked: false },
      { id: "f-index-failed", marked: true },
    ]);
  });

  it("lifts the marker of a completed Run's failed Documents on retry, leaving completed ones", async () => {
    const lifecycle = createRunLifecycle({ sql, startWorkflow: vi.fn(async () => {}), failureThreshold: 2 });
    const outcome = await lifecycle.retry({ id: "run-partial", status: "completed", pipeline: defaultPipelineFeatures });
    expect(outcome).toMatchObject({ status: "resumed" });
    expect(await marked("run-partial")).toEqual([
      { id: "p-done", marked: true },
      { id: "p-embed-failed", marked: false },
      { id: "p-index-failed", marked: true },
    ]);
  });
});
