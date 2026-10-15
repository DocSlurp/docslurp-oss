import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { defaultPipelineFeatures } from "@docslurp/shared";
import type { SqlClient } from "../src/db.js";
import { createRunLifecycle } from "../src/services/run-lifecycle.js";
const url = process.env.DATABASE_URL!;
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Local database required");
const schema = `retry_test_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { prepare: false });
await admin.unsafe(`create schema ${schema}`);
const sql = postgres(url, { prepare: false, max: 3, connection: { search_path: schema } });
try {
  await sql.unsafe(`
    create table workspace_runs(id text primary key,status text,stage text,control_state text,control_requested_at timestamptz,error text,failure_count int,dead_lettered_at timestamptz,dead_letter_reason text,lease_expires_at timestamptz,last_heartbeat_at timestamptz,updated_at timestamptz,cost numeric,artifacts jsonb);
    create table documents(id text,run_id text,status text,updated_at timestamptz);
    create table document_run_stage_states(run_id text,stage_name text,status text);
    create table workspace_run_stage_states(run_id text,stage_name text,status text);
    create table page_work_tasks(run_id text,page_number int,result jsonb,status text);
    create table usage_events(run_id text,cost numeric);
    create table credit_ledger(run_id text,delta numeric);
    insert into workspace_runs(id,status,stage,cost,artifacts) values('run','failed','index',0.012345,'{"embeddings":"s3://saved"}');
    insert into documents values('doc','run','failed',now()),('done','run','completed',now());
    insert into document_run_stage_states values('run','embed','completed'),('run','index','failed');
    insert into workspace_run_stage_states select * from document_run_stage_states;
    insert into page_work_tasks values('run',1,'{"text":"paid extraction"}','completed');
    insert into usage_events values('run',0.012345); insert into credit_ledger values('run',-0.012345);
  `);
  const lifecycle = createRunLifecycle({ sql: sql as unknown as SqlClient, startWorkflow: async () => {}, failureThreshold: 3 });
  const retry = (status: "failed" | "processing") => lifecycle.retry({ id: "run", status, pipeline: defaultPipelineFeatures });
  const results = await Promise.all([retry("failed"), retry("failed")]);
  assert.equal(results.filter((outcome) => outcome.status === "resumed").length, 1);
  const [run] = await sql`select * from workspace_runs`;
  assert.equal(run!.status, "queued");
  assert.equal(run!.cost, "0.012345");
  assert.deepEqual(run!.artifacts, { embeddings: "s3://saved" });
  assert.equal((await sql`select sum(cost) as cost from usage_events`)[0]!.cost, "0.012345");
  assert.equal((await sql`select sum(delta) as debit from credit_ledger`)[0]!.debit, "-0.012345");
  assert.deepEqual((await sql`select result from page_work_tasks`)[0]!.result, { text: "paid extraction" });
  assert.deepEqual((await sql`select stage_name from document_run_stage_states`).map(r => r.stage_name), ["embed"]);
  assert.deepEqual((await sql`select stage_name from workspace_run_stage_states`).map(r => r.stage_name), ["embed"]);
  assert.equal((await sql`select status from documents where id='done'`)[0]!.status, "completed");
  await sql`update workspace_runs set status='processing'`;
  assert.equal((await retry("failed")).status, "not-retryable");
  console.log("PASS: concurrent retries preserve paid page outputs, embedding checkpoints, exact costs and credit history; active runs are unchanged.");
} finally {
  await sql.end(); await admin.unsafe(`drop schema ${schema} cascade`); await admin.end();
}
