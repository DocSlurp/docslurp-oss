import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { createRunLifecycle } from "../services/run-lifecycle.js";
import type { SqlClient } from "../db.js";

let sql: postgres.Sql;
let stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user" (id, name, email) values ('u', 'Test', 'retired@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Test', 'retired', 'u')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Test')`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

async function run(id: string, status: string) {
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, creation_ready_at)
    values (${id}, 'o', 'u', 'w', 'upload', ${status}, 'embed', '{}'::jsonb, now())`;
}
async function doc(id: string, runId: string, status: string, retired = false) {
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, superseded_at)
    values (${id}, 'o', 'u', 'w', ${runId}, 'a.txt', 'text/plain', ${id}, ${status}, ${retired ? new Date() : null})`;
}
function lifecycle() {
  return createRunLifecycle({ sql: sql as unknown as SqlClient, startWorkflow: vi.fn(async () => {}), failureThreshold: 3 });
}
async function statuses(runId: string) {
  return await sql`select id, status from documents where run_id = ${runId} order by id`;
}

describe("retired documents stay outside run retries", () => {
  it("retries current failures without requeueing superseded or cancelled documents", async () => {
    await run('retry-failed', 'failed');
    await doc('retry-a-current', 'retry-failed', 'failed');
    await doc('retry-b-history', 'retry-failed', 'failed', true);
    await doc('retry-c-cancelled', 'retry-failed', 'cancelled');
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status)
      values ('retry-failed', 'retry-b-history', 'embed', 'failed'), ('retry-failed', 'retry-c-cancelled', 'embed', 'failed')`;
    expect((await lifecycle().retry({ id: 'retry-failed', status: 'failed', pipeline: defaultPipelineFeatures })).status).toBe('resumed');
    expect(await statuses('retry-failed')).toEqual([
      { id: 'retry-a-current', status: 'queued' }, { id: 'retry-b-history', status: 'failed' }, { id: 'retry-c-cancelled', status: 'cancelled' },
    ]);
    expect(await sql`select count(*)::int as n from document_run_stage_states where run_id = 'retry-failed'`).toEqual([{ n: 2 }]);
  });

  it("does not restart a completed run whose only failed documents are superseded", async () => {
    await run('retry-completed', 'completed');
    await doc('only-history', 'retry-completed', 'failed', true);
    expect(await lifecycle().retry({ id: 'retry-completed', status: 'completed', pipeline: defaultPipelineFeatures }))
      .toEqual({ status: 'not-retryable' });
  });

  it("failure cleanup retires obsolete pending documents and preserves cancellation", async () => {
    await run('failure', 'processing');
    await doc('failure-a-live', 'failure', 'queued');
    await doc('failure-b-history', 'failure', 'queued', true);
    await doc('failure-c-cancelled', 'failure', 'cancelled');
    await lifecycle().fail('failure', { stage: 'embed', message: 'lost worker', fromStatuses: ['processing'] });
    expect(await statuses('failure')).toEqual([
      { id: 'failure-a-live', status: 'queued' }, { id: 'failure-b-history', status: 'cancelled' }, { id: 'failure-c-cancelled', status: 'cancelled' },
    ]);
  });

  it("repairs only superseded pending documents in terminal runs, retaining history and active work", async () => {
    await run('repair-terminal', 'failed');
    await run('repair-active', 'processing');
    await sql`update workspace_runs set control_state = 'cancel_requested' where id = 'repair-active'`;
    await doc('repair-a-old-queued', 'repair-terminal', 'queued', true);
    await doc('repair-b-old-processing', 'repair-terminal', 'processing', true);
    await doc('repair-c-current', 'repair-terminal', 'queued');
    await doc('repair-d-old-completed', 'repair-terminal', 'completed', true);
    await doc('repair-e-active', 'repair-active', 'queued', true);
    const repair = readFileSync(new URL('../../db/migrations/0073_retire_superseded_pending_documents.sql', import.meta.url), 'utf8');
    await sql.unsafe(repair);
    expect(await statuses('repair-terminal')).toEqual([
      { id: 'repair-a-old-queued', status: 'cancelled' }, { id: 'repair-b-old-processing', status: 'cancelled' },
      { id: 'repair-c-current', status: 'queued' }, { id: 'repair-d-old-completed', status: 'completed' },
    ]);
    expect(await statuses('repair-active')).toEqual([{ id: 'repair-e-active', status: 'queued' }]);
  });
});
