import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { createRunLifecycle } from "../services/run-lifecycle.js";
import type { SqlClient } from "../db.js";

// Default test runtime is migrated PGlite over its PostgreSQL wire adapter, not native PostgreSQL.
let sql: postgres.Sql;
let stop: () => Promise<void>;
beforeAll(async () => {
  const databaseUrl = process.env.RUN_RETRY_BOOST_TEST_DATABASE_URL;
  const database = databaseUrl ? null : await startMigratedPostgres();
  stop = database?.stop ?? (async () => {});
  sql = postgres(databaseUrl ?? database!.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user" (id,name,email) values ('retry-u','Retry','retry@boost.test')`;
  await sql`insert into organizations (id,name,created_by_user_id) values ('retry-o','Retry','retry-u')`;
  await sql`insert into workspaces (id,org_id,user_id,name) values ('retry-w','retry-o','retry-u','Retry')`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

it("rolls back boosted retry state when admission fails, then starts only after commit", async () => {
  const pipeline = { ...defaultPipelineFeatures, speedBoost: true };
  await sql`insert into workspace_runs (id,org_id,user_id,workspace_id,kind,status,stage,creation_ready_at,pipeline)
    values ('retry-r','retry-o','retry-u','retry-w','upload','failed','extract-markdown',now(),${sql.json(JSON.parse(JSON.stringify(pipeline)))})`;
  await sql`insert into documents (id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status)
    values ('retry-d','retry-o','retry-u','retry-w','retry-r','a.txt','text/plain','a','failed')`;
  const startWorkflow = vi.fn(async () => {});
  const lifecycle = createRunLifecycle({ sql: sql as unknown as SqlClient, startWorkflow, failureThreshold: 3 });
  const run = { id: 'retry-r', pipeline, status: 'failed' as const };
  await expect(sql.begin(async tx => {
    expect(await lifecycle.prepareRetry(run, tx)).toBe('resumed');
    expect(startWorkflow).not.toHaveBeenCalled();
    throw new Error('lease refused');
  })).rejects.toThrow('lease refused');
  expect((await sql`select status,pipeline from workspace_runs where id='retry-r'`)[0]).toMatchObject({status:'failed',pipeline:{speedBoost:true}});
  expect((await sql`select status from documents where id='retry-d'`)[0].status).toBe('failed');
  await sql.begin(async tx => {
    expect(await lifecycle.prepareRetry(run, tx)).toBe('resumed');
    expect(startWorkflow).not.toHaveBeenCalled();
  });
  expect((await sql`select status from workspace_runs where id='retry-r'`)[0].status).toBe('queued');
  await lifecycle.start(run, { restartExisting: true });
  expect(startWorkflow).toHaveBeenCalledExactlyOnceWith('retry-r',pipeline,{restartExisting:true});
});

it("rechecks queued retry eligibility under the transaction lock", async () => {
  const pipeline = { ...defaultPipelineFeatures, speedBoost: true };
  const lifecycle = createRunLifecycle({ sql: sql as unknown as SqlClient, startWorkflow: vi.fn(), failureThreshold: 3 });
  await sql`update workspace_runs set status='processing' where id='retry-r'`;
  const outcome = await sql.begin(tx => lifecycle.prepareRetry({ id:'retry-r', pipeline, status:'queued' }, tx));
  expect(outcome).toBe('not-retryable');
  expect((await sql`select pipeline from workspace_runs where id='retry-r'`)[0].pipeline.speedBoost).toBe(true);
});
