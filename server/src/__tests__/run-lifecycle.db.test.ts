import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import { createRunLifecycle } from "../services/run-lifecycle.js";
import type { SqlClient } from "../db.js";

// Real-Postgres check of Run Lifecycle transitions. RUN_LIFECYCLE_DATABASE_URL
// must point at a disposable local database built by applying
// server/db/migrations (pnpm db:migrate); server/db/migrations is the only
// schema source. Each test seeds its own user, organization and workspace with
// unique ids and deletes them afterwards. Skipped without a local DB:
//   RUN_LIFECYCLE_DATABASE_URL=$DATABASE_URL npx vitest run --project api run-lifecycle.db
const databaseUrl = process.env.RUN_LIFECYCLE_DATABASE_URL ?? "";
const isLocal =
  databaseUrl !== "" && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname);

type Tenant = { userId: string; orgId: string; workspaceId: string; id: (name: string) => string };

async function withTenant(run: (sql: SqlClient, tenant: Tenant) => Promise<void>): Promise<void> {
  const suffix = randomUUID();
  const tenant: Tenant = {
    userId: `rl-user-${suffix}`,
    orgId: `rl-org-${suffix}`,
    workspaceId: `rl-ws-${suffix}`,
    id: (name) => `${name}-${suffix}`,
  };
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql`insert into "user" (id, name, email) values (${tenant.userId}, 'Run lifecycle', ${`${tenant.userId}@example.test`})`;
    await sql`insert into organizations (id, name, created_by_user_id) values (${tenant.orgId}, 'Run lifecycle', ${tenant.userId})`;
    await sql`insert into org_memberships (org_id, user_id, role) values (${tenant.orgId}, ${tenant.userId}, 'owner')`;
    await sql`insert into workspaces (id, org_id, user_id, name) values (${tenant.workspaceId}, ${tenant.orgId}, ${tenant.userId}, 'Run lifecycle')`;
    await run(sql as unknown as SqlClient, tenant);
  } finally {
    // Runs, events, stage states and documents cascade from the workspace.
    await sql`delete from workspaces where id = ${tenant.workspaceId}`;
    await sql`delete from organizations where id = ${tenant.orgId}`;
    await sql`delete from "user" where id = ${tenant.userId}`;
    await sql.end();
  }
}

async function insertRun(
  sql: SqlClient,
  tenant: Tenant,
  name: string,
  values: { status: string; stage: string; stats?: Record<string, unknown>; controlState?: string; error?: string; failureCount?: number; deadLetterReason?: string },
): Promise<string> {
  const id = tenant.id(name);
  await sql`
    insert into workspace_runs (
      id, org_id, user_id, workspace_id, kind, status, stage, stats, control_state, error, failure_count,
      dead_letter_reason, creation_ready_at
    )
    values (
      ${id}, ${tenant.orgId}, ${tenant.userId}, ${tenant.workspaceId}, 'bulk-upload', ${values.status}, ${values.stage},
      ${sql.json((values.stats ?? {}) as postgres.JSONValue)}, ${values.controlState ?? null}, ${values.error ?? null},
      ${values.failureCount ?? 0}, ${values.deadLetterReason ?? null}, now()
    )
  `;
  return id;
}

async function insertDocument(sql: SqlClient, tenant: Tenant, runId: string, name: string, status: string): Promise<string> {
  const id = tenant.id(name);
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    values (${id}, ${tenant.orgId}, ${tenant.userId}, ${tenant.workspaceId}, ${runId}, ${`${name}.pdf`}, 'application/pdf',
      ${`${tenant.userId}/raw/${id}.pdf`}, ${status})
  `;
  return id;
}

function lifecycle(sql: SqlClient, startWorkflow = vi.fn(async () => {})) {
  return createRunLifecycle({ sql, startWorkflow, failureThreshold: 2 });
}

describe.skipIf(!isLocal)("Run Lifecycle (local Postgres)", () => {
  it("fails a stuck Run with worker-equivalent bookkeeping and dead-letters at the threshold", async () => {
    await withTenant(async (sql, tenant) => {
      const runId = await insertRun(sql, tenant, "run-1", { status: "queued", stage: "queued", stats: { old: true } });
      const done = await insertDocument(sql, tenant, runId, "doc-done", "completed");
      const open = await insertDocument(sql, tenant, runId, "doc-open", "queued");
      const broken = await insertDocument(sql, tenant, runId, "doc-broken", "processing");
      await sql`
        insert into document_run_stage_states (run_id, document_id, stage_name, status)
        values (${runId}, ${broken}, 'parse', 'failed')
      `;

      const failed = await lifecycle(sql).fail(runId, {
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

      // A failed Run fails only Documents with a failed stage and leaves the
      // rest queued so retry can resume them (291b4261, "Keep a Run going when
      // one Document fails").
      const docs = await sql<{ id: string; status: string }[]>`
        select id, status from documents where run_id = ${runId} order by id
      `;
      expect(docs).toEqual([
        { id: broken, status: "failed" },
        { id: done, status: "completed" },
        { id: open, status: "queued" },
      ]);
      const [event] = await sql<{ event_type: string; payload: Record<string, unknown> }[]>`
        select event_type, payload from workspace_run_events where run_id = ${runId}
      `;
      expect(event).toMatchObject({
        event_type: "run.failed",
        payload: { reason: "stale-queued-run-sweep", failureCount: 1, deadLettered: false },
      });

      // A Run that is no longer queued is not failed again by the sweep.
      expect(await lifecycle(sql).fail(runId, { stage: "queued", message: "again", fromStatuses: ["queued"] })).toBeNull();

      // The second failure reaches the poison threshold.
      await sql`update workspace_runs set status = 'processing' where id = ${runId}`;
      const dead = await lifecycle(sql).fail(runId, { stage: "parse", message: "boom", fromStatuses: ["processing"] });
      expect(dead).toMatchObject({ failure_count: 2, control_state: "dead-letter", dead_letter_reason: "boom" });
    });
  });

  it("skips Runs held by an operator control state", async () => {
    await withTenant(async (sql, tenant) => {
      const runId = await insertRun(sql, tenant, "run-p", { status: "queued", stage: "queued", controlState: "paused" });
      const result = await lifecycle(sql).fail(runId, {
        stage: "queued", message: "stale", fromStatuses: ["queued"], skipControlStates: ["paused"],
      });
      expect(result).toBeNull();
      const [row] = await sql<{ status: string }[]>`select status from workspace_runs where id = ${runId}`;
      expect(row.status).toBe("queued");
    });
  });

  it("retries a failed Run from its checkpoints and restarts the workflow", async () => {
    await withTenant(async (sql, tenant) => {
      const runId = await insertRun(sql, tenant, "run-f", {
        status: "failed", stage: "parse", error: "boom", failureCount: 3, controlState: "dead-letter", deadLetterReason: "boom",
      });
      const docA = await insertDocument(sql, tenant, runId, "doc-a", "completed");
      const docB = await insertDocument(sql, tenant, runId, "doc-b", "failed");
      await sql`
        insert into workspace_run_stage_states (run_id, stage_name, status)
        values (${runId}, 'fetch', 'completed'), (${runId}, 'parse', 'failed')
      `;

      const startWorkflow = vi.fn(async () => {});
      const outcome = await lifecycle(sql, startWorkflow).retry({ id: runId, status: "failed", pipeline: defaultPipelineFeatures });

      expect(outcome).toEqual({ status: "resumed", start: { status: "started" } });
      expect(startWorkflow).toHaveBeenCalledWith(runId, defaultPipelineFeatures, { restartExisting: true });
      const [row] = await sql`select status, stage, error, failure_count, control_state, dead_letter_reason from workspace_runs where id = ${runId}`;
      expect(row).toEqual({ status: "queued", stage: "queued", error: null, failure_count: 0, control_state: null, dead_letter_reason: null });
      expect(await sql`select stage_name from workspace_run_stage_states where run_id = ${runId}`).toEqual([{ stage_name: "fetch" }]);
      expect(await sql`select id, status from documents where run_id = ${runId} order by id`).toEqual([
        { id: docA, status: "completed" },
        { id: docB, status: "queued" },
      ]);

      // A concurrent retry that lost the race does not restart again.
      const again = await lifecycle(sql, startWorkflow).retry({ id: runId, status: "failed", pipeline: defaultPipelineFeatures });
      expect(again).toEqual({ status: "not-retryable" });
      expect(startWorkflow).toHaveBeenCalledTimes(1);
    });
  });
});
