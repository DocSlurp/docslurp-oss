import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { recordPageBaseFee, pageBaseFeeRateCents } from "../src/db/page-base-fee.js";
import type { WorkflowState } from "../src/pipeline/pipeline.js";
import { installRunSpentTrigger } from "./run-spent-sql.js";
import { CREDIT_LEDGER_TABLE, CREDIT_POOL_ORG_COLUMNS, flushPendingCreditDebits, installCreditPoolSql } from "./credit-pool-sql.js";
const url = process.env.DATABASE_URL!;
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Local database required");
const schema = `fee_test_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { prepare: false });
await admin.unsafe(`create schema ${schema}`);
const sql = postgres(url, { prepare: false, max: 4, connection: { search_path: schema } });
try {
  await sql.unsafe(`
    create table workspace_runs(id text primary key,spent_cents numeric not null default 0);
    create table documents(run_id text,page_count int,status text,deduped_from_document_id text);
    create table organizations(id text primary key,credit_balance_cents numeric,updated_at timestamptz,${CREDIT_POOL_ORG_COLUMNS});
    create table usage_events(id text primary key,user_id text,run_id text,provider text,model text,metric text,amount numeric,unit text,cost_cents numeric,input_tokens int,output_tokens int,metadata jsonb);
    ${CREDIT_LEDGER_TABLE};
    insert into workspace_runs(id) values('paid'),('free');
    insert into organizations(id,credit_balance_cents,updated_at) values('org',100,now());
    insert into documents values('paid',20,'completed',null),('paid',8,'completed','duplicate'),('paid',4,'failed',null),('free',20,'completed',null);
  `);
  await installCreditPoolSql(sql);
  await installRunSpentTrigger(sql);
  const state = (id: string) => ({run:{id,userId:'user',workspaceId:'space',orgId:'org',spentCents:0}}) as WorkflowState;
  assert.equal(pageBaseFeeRateCents('0.005'),0.5);
  assert.throws(()=>pageBaseFeeRateCents('-1'));
  process.env.DOCSLURP_PAGE_BASE_FEE_USD='0.005';
  await Promise.all(Array.from({length:4},()=>recordPageBaseFee(sql,state('paid'))));
  assert.equal(Number((await sql`select spent_cents from workspace_runs where id='paid'`)[0]!.spent_cents),10);
  await flushPendingCreditDebits(sql);
  assert.equal(Number((await sql`select credit_balance_cents from organizations`)[0]!.credit_balance_cents),90);
  assert.equal((await sql`select * from credit_ledger`).length,1);
  process.env.DOCSLURP_PAGE_BASE_FEE_USD='0';
  await recordPageBaseFee(sql,state('free'));
  process.env.DOCSLURP_PAGE_BASE_FEE_USD='0.005';
  await recordPageBaseFee(sql,state('free'));
  assert.equal(Number((await sql`select spent_cents from workspace_runs where id='free'`)[0]!.spent_cents),0);
  assert.equal((await sql`select * from credit_ledger`).length,1);
  console.log('PASS: half-cent fee, dedup/failed exclusion, concurrent retry idempotency, exact credit debit, zero-rate snapshot.');
} finally {
  await sql.end();await admin.unsafe(`drop schema ${schema} cascade`);await admin.end();
}
