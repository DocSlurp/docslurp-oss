import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PageTaskStore } from "../src/db/page-task-store.js";
import type { WorkflowState } from "../src/pipeline/pipeline.js";
import { PipelineUsageEventLedger } from "../src/pipeline/usage-ledger.js";
import type { VisionPageTask } from "../src/temporal/shared.js";
import { readFile } from "node:fs/promises";
import { installRunSpentTrigger } from "./run-spent-sql.js";
import { CREDIT_LEDGER_TABLE, CREDIT_POOL_ORG_COLUMNS, flushPendingCreditDebits, installCreditPoolSql } from "./credit-pool-sql.js";

const url = process.env.DATABASE_URL!;
if (!["localhost","127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Local database required");
const schema = `page_test_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, {prepare:false});
await admin.unsafe(`create schema ${schema}`);
const sql = postgres(url, {max:20, prepare:false, connection:{search_path:schema}});
try {
  await sql.unsafe(`create table workspace_runs(id text primary key,spent_cents numeric(24,12) not null default 0,updated_at timestamptz);
    create table documents(id text primary key);
    create table organizations(id text primary key,credit_balance_cents numeric(24,12),updated_at timestamptz,${CREDIT_POOL_ORG_COLUMNS});
    create table usage_events(id text primary key,user_id text,run_id text,provider text,model text,metric text,amount numeric,unit text,cost_cents numeric(24,12),input_tokens int,output_tokens int,metadata jsonb);
    ${CREDIT_LEDGER_TABLE};
    create table page_stage_states(run_id text,document_id text,stage_name text,page_number int,status text,completed_at timestamptz,unique(run_id,document_id,stage_name,page_number));
    insert into workspace_runs(id) values('run'); insert into documents values('doc'); insert into organizations(id,credit_balance_cents,updated_at) values('org',2000,now());`);
  await installCreditPoolSql(sql);
  await installRunSpentTrigger(sql);
  await sql.unsafe(await readFile(new URL("../../server/db/migrations/0014_distributed_page_tasks.sql", import.meta.url),"utf8"));
  const store = new PageTaskStore(sql);
  const tasks = Array.from({length:20},(_,i)=>({runId:"run",documentId:"doc",pageNumber:i+1,pageCount:20,vision:{}} as VisionPageTask));
  await store.enqueue(tasks);
  const claims = await Promise.all(tasks.map(task=>store.claim(task, `worker-${task.pageNumber}`)));
  assert.equal(new Set(claims).size,20);
  assert.equal(await store.claim(tasks[0]!,"duplicate"),"busy");
  const makeState = (n:number) => {
    const usageLedger = new PipelineUsageEventLedger();
    usageLedger.enqueue({id:`usage-${n}`,provider:"test",model:"test",metric:"page-analysis",amount:1,unit:"page",costCents:0.0001234567,inputTokens:10,outputTokens:5,metadata:{costSource:"provider"}});
    return {run:{id:"run",userId:"user",orgId:"org",spentCents:0},usageLedger} as unknown as WorkflowState;
  };
  await Promise.all(tasks.map((task,i)=>store.finish(task,claims[i]!,makeState(i),{pageNumber:task.pageNumber,text:`page ${task.pageNumber}`})));
  assert.equal((await store.completed("run")).size,20);
  assert.equal(await store.claim(tasks[0]!,"retry"),null);
  await assert.rejects(store.finish(tasks[0]!,claims[0]!,makeState(0),{}),/lease lost/);
  assert.equal(Number((await sql`select count(*)::int n from credit_debits_pending`)[0]!.n),20);
  await flushPendingCreditDebits(sql);
  const [totals] = await sql`select (select spent_cents::text from workspace_runs) cost,
    (select sum(cost_cents)::text from usage_events) usage,
    (select credit_balance_cents::text from organizations) balance,
    (select count(*)::int from credit_ledger) debits`;
  assert.equal(totals!.cost,"0.002469134000"); assert.equal(totals!.usage,totals!.cost);
  assert.equal(totals!.balance,"1999.997530866000"); assert.equal(totals!.debits,1); // 20 pending debits, one aggregated ledger row
  const task = {...tasks[0]!,pageNumber:21}; await store.enqueue([task]);
  const oldLease = await store.claim(task,"lost-worker");
  await sql`update page_work_tasks set lease_expires_at=now()-interval '1 second' where page_number=21`;
  const newLease = await store.claim(task,"replacement");
  await assert.rejects(store.finish(task,oldLease!,makeState(21),{}),/lease lost/);
  await store.finish(task,newLease!,makeState(21),{},true);
  assert.notEqual(await store.claim(task,"retry-failure"),"busy");
  console.log("PASS: 20 concurrent page checkpoints, exact costs, aggregated debits, duplicate retries, lease recovery, stale-worker fencing, failed-attempt persistence.");
} finally { await sql.end(); await admin.unsafe(`drop schema ${schema} cascade`); await admin.end(); }
