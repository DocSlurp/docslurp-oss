import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import { createRunLifecycle } from "../services/run-lifecycle.js";
import type { SqlClient } from "../db.js";

// Real-Postgres check of Run Lifecycle transitions, run inside a throwaway
// schema that is dropped afterwards. Skipped without a local DB:
//   RUN_LIFECYCLE_DATABASE_URL=$DATABASE_URL npx vitest run --project api run-lifecycle.db
const databaseUrl = process.env.RUN_LIFECYCLE_DATABASE_URL ?? "";
const isLocal =
  databaseUrl !== "" && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname);

async function withSchema(run: (sql: SqlClient) => Promise<void>): Promise<void> {
  const schema = `run_lifecycle_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`create schema ${schema}`);
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  try {
    await sql.unsafe(`
      create table workspace_runs (
        id text primary key, user_id text not null, status text not null, stage text not null,
        creation_ready_at timestamptz default now(), creation_expires_at timestamptz,
        control_state text, control_requested_at timestamptz, error text,
        stats jsonb not null default '{}', pipeline jsonb not null default '{}',
        failure_count integer not null default 0, dead_lettered_at timestamptz, dead_letter_reason text,
        lease_expires_at timestamptz, last_heartbeat_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create table documents (id text primary key, run_id text not null, status text not null, updated_at timestamptz, superseded_at timestamptz);
      create table workspace_run_stage_states (run_id text, stage_name text, status text, primary key (run_id, stage_name));
      create table document_run_stage_states (
        run_id text, document_id text, stage_name text, status text, error text, updated_at timestamptz
      );
      create function retire_replaced_pending_documents(text) returns void language plpgsql as $$ begin return; end; $$;
      create table workspace_run_events (
        id text primary key, user_id text, run_id text, document_id text, stage_name text, event_type text,
        status text, message text, progress jsonb, stats jsonb, payload jsonb, created_at timestamptz
      );
    `);
    await run(sql as unknown as SqlClient);
  } finally {
    await sql.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
  }
}

function lifecycle(sql: SqlClient, startWorkflow = vi.fn(async () => {})) {
  return createRunLifecycle({ sql, startWorkflow, failureThreshold: 2 });
}

describe.skipIf(!isLocal)("Run Lifecycle (local Postgres)", () => {
  it("fails a stuck Run with worker-equivalent bookkeeping and dead-letters at the threshold", async () => {
    await withSchema(async (sql) => {
      await sql`insert into workspace_runs (id, user_id, status, stage, stats) values ('run-1', 'user-1', 'queued', 'queued', '{"old":true}')`;
      await sql`insert into documents (id, run_id, status, updated_at) values ('doc-done', 'run-1', 'completed', now()), ('doc-open', 'run-1', 'queued', now())`;

      const failed = await lifecycle(sql).fail("run-1", {
        stage: "queued",
        message: "stale",
        fromStatuses: ["queued"],
        skipControlStates: ["paused"],
        stats: { staleQueueRecovery: { reason: "stale" } },
        payload: { reason: "stale-queued-run-sweep" },
      });
      expect(failed).toMatchObject({ status: "failed", failure_count: 1, control_state: null });
      expect(failed?.stats).toMatchObject({
        old: true,
        staleQueueRecovery: { reason: "stale" },
        deadLettered: false,
        lastFailure: { stage: "queued", message: "stale", failureCount: 1 },
      });

      const docs = await sql<{ id: string; status: string }[]>`select id, status from documents order by id`;
      expect(docs).toEqual([{ id: "doc-done", status: "completed" }, { id: "doc-open", status: "failed" }]);
      const [event] = await sql<{ event_type: string; payload: Record<string, unknown> }[]>`
        select event_type, payload from workspace_run_events where run_id = 'run-1'
      `;
      expect(event).toMatchObject({
        event_type: "run.failed",
        payload: { reason: "stale-queued-run-sweep", failureCount: 1, deadLettered: false },
      });

      // A Run that is no longer queued is not failed again by the sweep.
      expect(await lifecycle(sql).fail("run-1", { stage: "queued", message: "again", fromStatuses: ["queued"] })).toBeNull();

      // The second failure reaches the poison threshold.
      await sql`update workspace_runs set status = 'processing' where id = 'run-1'`;
      const dead = await lifecycle(sql).fail("run-1", { stage: "parse", message: "boom", fromStatuses: ["processing"] });
      expect(dead).toMatchObject({ failure_count: 2, control_state: "dead-letter", dead_letter_reason: "boom" });
    });
  });

  it("skips Runs held by an operator control state", async () => {
    await withSchema(async (sql) => {
      await sql`insert into workspace_runs (id, user_id, status, stage, control_state) values ('run-p', 'user-1', 'queued', 'queued', 'paused')`;
      const result = await lifecycle(sql).fail("run-p", {
        stage: "queued", message: "stale", fromStatuses: ["queued"], skipControlStates: ["paused"],
      });
      expect(result).toBeNull();
      const [row] = await sql<{ status: string }[]>`select status from workspace_runs where id = 'run-p'`;
      expect(row.status).toBe("queued");
    });
  });

  it("retries a failed Run from its checkpoints and restarts the workflow", async () => {
    await withSchema(async (sql) => {
      await sql`
        insert into workspace_runs (id, user_id, status, stage, error, failure_count, control_state, dead_letter_reason)
        values ('run-f', 'user-1', 'failed', 'parse', 'boom', 3, 'dead-letter', 'boom')
      `;
      await sql`insert into documents (id, run_id, status, updated_at) values ('doc-a', 'run-f', 'completed', now()), ('doc-b', 'run-f', 'failed', now())`;
      await sql`insert into workspace_run_stage_states values ('run-f', 'fetch', 'completed'), ('run-f', 'parse', 'failed')`;

      const startWorkflow = vi.fn(async () => {});
      const outcome = await lifecycle(sql, startWorkflow).retry({ id: "run-f", status: "failed", pipeline: defaultPipelineFeatures });

      expect(outcome).toEqual({ status: "resumed", start: { status: "started" } });
      expect(startWorkflow).toHaveBeenCalledWith("run-f", defaultPipelineFeatures, { restartExisting: true });
      const [row] = await sql`select status, stage, error, failure_count, control_state, dead_letter_reason from workspace_runs where id = 'run-f'`;
      expect(row).toEqual({ status: "queued", stage: "queued", error: null, failure_count: 0, control_state: null, dead_letter_reason: null });
      expect(await sql`select stage_name from workspace_run_stage_states where run_id = 'run-f'`).toEqual([{ stage_name: "fetch" }]);
      expect(await sql`select id, status from documents order by id`).toEqual([
        { id: "doc-a", status: "completed" },
        { id: "doc-b", status: "queued" },
      ]);

      // A concurrent retry that lost the race does not restart again.
      const again = await lifecycle(sql, startWorkflow).retry({ id: "run-f", status: "failed", pipeline: defaultPipelineFeatures });
      expect(again).toEqual({ status: "not-retryable" });
      expect(startWorkflow).toHaveBeenCalledTimes(1);
    });
  });
});
