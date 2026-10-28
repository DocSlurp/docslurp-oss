import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createRunLifecycle } from "../services/run-lifecycle.js";
import { createRunStartRecovery } from "../services/run-start-recovery.js";
import type { SqlClient } from "../db.js";

// Real-Postgres check of run-start recovery (claiming, backoff, SKIP LOCKED).
// RUN_LIFECYCLE_DATABASE_URL must point at a disposable local database built by
// applying server/db/migrations (pnpm db:migrate); server/db/migrations is the
// only schema source. Each test seeds its own user, organization and workspace
// with unique ids and deletes them afterwards. Recovery sweeps every due Run in
// the database, so do not point this at a database other processes are using.
//   RUN_LIFECYCLE_DATABASE_URL=$DATABASE_URL npx vitest run --project api run-start-recovery.db
const databaseUrl = process.env.RUN_LIFECYCLE_DATABASE_URL ?? "";
const isLocal =
  databaseUrl !== "" && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname);

const temporalDown = new Error(
  "Temporal API client could not connect to Temporal at temporal.example.invalid:7233.\noriginalError=Error: Failed to connect before the deadline",
);

type Tenant = { userId: string; orgId: string; workspaceId: string; runId: (name: string) => string };
type Clients = { sql: SqlClient; other: SqlClient; tenant: Tenant };

async function withTenant(run: (clients: Clients) => Promise<void>): Promise<void> {
  const suffix = randomUUID();
  const tenant: Tenant = {
    userId: `rsr-user-${suffix}`,
    orgId: `rsr-org-${suffix}`,
    workspaceId: `rsr-ws-${suffix}`,
    runId: (name) => `${name}-${suffix}`,
  };
  const connect = () => postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => {} });
  const sql = connect();
  const other = connect();
  try {
    await sql`insert into "user" (id, name, email) values (${tenant.userId}, 'Run start recovery', ${`${tenant.userId}@example.test`})`;
    await sql`insert into organizations (id, name, created_by_user_id) values (${tenant.orgId}, 'Run start recovery', ${tenant.userId})`;
    await sql`insert into org_memberships (org_id, user_id, role) values (${tenant.orgId}, ${tenant.userId}, 'owner')`;
    await sql`insert into workspaces (id, org_id, user_id, name) values (${tenant.workspaceId}, ${tenant.orgId}, ${tenant.userId}, 'Run start recovery')`;
    await run({ sql: sql as unknown as SqlClient, other: other as unknown as SqlClient, tenant });
  } finally {
    // Runs and documents cascade from the workspace.
    await sql`delete from workspaces where id = ${tenant.workspaceId}`;
    await sql`delete from organizations where id = ${tenant.orgId}`;
    await sql`delete from "user" where id = ${tenant.userId}`;
    await sql.end();
    await other.end();
  }
}

/** A fake Temporal: one workflow per id, "already started" on a duplicate, optionally down. */
function fakeTemporal() {
  const workflows = new Map<string, number>();
  const state = { down: false, startCalls: 0, delayMs: 0 };
  const startWorkflow = vi.fn(async (runId: string) => {
    state.startCalls += 1;
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.down) throw temporalDown;
    if (workflows.has(runId)) throw new Error("Workflow execution already started");
    workflows.set(runId, Date.now());
  });
  return { workflows, state, startWorkflow };
}

const config = { batchSize: 25, leaseMs: 30_000 };

function recovery(sql: SqlClient, temporal: ReturnType<typeof fakeTemporal>) {
  const lifecycle = createRunLifecycle({
    sql,
    startWorkflow: temporal.startWorkflow,
    failureThreshold: 3,
    startRetryBackoff: { baseMs: 2_000, maxMs: 60_000 },
  });
  return { lifecycle, recovery: createRunStartRecovery({ sql, lifecycle, config }) };
}

async function insertRun(sql: SqlClient, tenant: Tenant, name: string, values: { ageMs?: number; status?: string; controlState?: string; started?: boolean } = {}) {
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, control_state, created_at, workflow_started_at, creation_ready_at)
    values (
      ${tenant.runId(name)}, ${tenant.orgId}, ${tenant.userId}, ${tenant.workspaceId}, 'bulk-upload',
      ${values.status ?? "queued"}, 'queued', ${values.controlState ?? null},
      now() - (${values.ageMs ?? 0} * interval '1 millisecond'),
      ${values.started ? sql`now()` : null},
      now()
    )
  `;
}

async function runRow(sql: SqlClient, id: string) {
  const [row] = await sql<{
    workflow_started_at: Date | null;
    workflow_start_attempts: number;
    workflow_start_next_at: Date | null;
  }[]>`select workflow_started_at, workflow_start_attempts, workflow_start_next_at from workspace_runs where id = ${id}`;
  return row;
}

vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

describe.skipIf(!isLocal)("run-start recovery (local Postgres)", () => {
  it("starts a deferred run within seconds once Temporal is reachable", async () => {
    await withTenant(async ({ sql, tenant }) => {
      const temporal = fakeTemporal();
      const { lifecycle, recovery: r } = recovery(sql, temporal);
      await insertRun(sql, tenant, "run-deferred");

      // Intake right after an app restart: Temporal connect deadline.
      temporal.state.down = true;
      const deferredAt = Date.now();
      await expect(lifecycle.start({ id: tenant.runId("run-deferred"), pipeline: {} as never })).resolves.toMatchObject({ status: "deferred" });
      const pending = await runRow(sql, tenant.runId("run-deferred"));
      expect(pending.workflow_started_at).toBeNull();
      expect(pending.workflow_start_attempts).toBe(1);
      expect(pending.workflow_start_next_at!.getTime()).toBeGreaterThan(Date.now());

      // Temporal still down: a pass inside the backoff claims nothing, and a
      // forced pass defers again without spending one connect per run.
      expect(await r.sweepOnce()).toMatchObject({ claimed: 0 });
      expect(await r.sweepOnce({ ignoreBackoff: true })).toMatchObject({ claimed: 1, deferred: 1 });
      expect((await runRow(sql, tenant.runId("run-deferred"))).workflow_start_attempts).toBe(2);

      // Temporal reachable: the client's connect listener kicks with ignoreBackoff.
      temporal.state.down = false;
      expect(await r.kick({ ignoreBackoff: true })).toMatchObject({ started: 1 });
      expect(temporal.workflows.has(tenant.runId("run-deferred"))).toBe(true);
      expect(Date.now() - deferredAt).toBeLessThan(5_000);
      const started = await runRow(sql, tenant.runId("run-deferred"));
      expect(started.workflow_started_at).not.toBeNull();
      expect(started.workflow_start_next_at).toBeNull();

      // Confirmed starts are never re-issued.
      const calls = temporal.state.startCalls;
      expect(await r.sweepOnce({ ignoreBackoff: true })).toMatchObject({ claimed: 0 });
      expect(temporal.state.startCalls).toBe(calls);
    });
  });

  it("retries on the backoff schedule without a connect event", async () => {
    await withTenant(async ({ sql, tenant }) => {
      const temporal = fakeTemporal();
      const { lifecycle, recovery: r } = recovery(sql, temporal);
      await insertRun(sql, tenant, "run-backoff");
      temporal.state.down = true;
      await lifecycle.start({ id: tenant.runId("run-backoff"), pipeline: {} as never });
      temporal.state.down = false;

      expect(await r.sweepOnce()).toMatchObject({ claimed: 0 });
      // First retry is due after the 2 s base backoff.
      await sql`update workspace_runs set workflow_start_next_at = now() - interval '1 ms' where id = ${tenant.runId("run-backoff")}`;
      expect(await r.sweepOnce()).toMatchObject({ claimed: 1, started: 1 });
    });
  });

  it("boot pass starts orphaned queued runs and leaves runs that are legitimately waiting", async () => {
    await withTenant(async ({ sql, tenant }) => {
      const temporal = fakeTemporal();
      const { recovery: r } = recovery(sql, temporal);
      // Intake request died after creating the run (no start, no deferral marker).
      await insertRun(sql, tenant, "run-orphan", { ageMs: 60_000 });
      // Creation still in flight: never eligible, regardless of its age.
      await insertRun(sql, tenant, "run-fresh", { ageMs: 60_000 });
      await sql`update workspace_runs set creation_ready_at = null, creation_expires_at = now() + interval '5 minutes' where id = ${tenant.runId("run-fresh")}`;
      // Started, waiting for worker slots.
      await insertRun(sql, tenant, "run-waiting", { ageMs: 60_000, started: true });
      await insertRun(sql, tenant, "run-paused", { ageMs: 60_000, controlState: "paused" });
      await insertRun(sql, tenant, "run-processing", { ageMs: 60_000, status: "processing" });

      expect(await r.kick()).toMatchObject({ claimed: 1, started: 1 });
      expect([...temporal.workflows.keys()]).toEqual([tenant.runId("run-orphan")]);
      expect((await runRow(sql, tenant.runId("run-orphan"))).workflow_started_at).not.toBeNull();
    });
  });

  it("never double-starts across concurrent app instances", async () => {
    await withTenant(async ({ sql, other, tenant }) => {
      const temporal = fakeTemporal();
      temporal.state.delayMs = 20;
      const a = recovery(sql, temporal).recovery;
      const b = recovery(other, temporal).recovery;
      for (let index = 0; index < 40; index += 1) {
        await insertRun(sql, tenant, `run-${index}`, { ageMs: 60_000 });
      }

      const [passA, passB] = await Promise.all([a.kick(), b.kick()]);
      expect(passA.started + passB.started).toBe(40);
      expect(temporal.workflows.size).toBe(40);
      // SKIP LOCKED + the claim lease: every run was started exactly once.
      expect(temporal.state.startCalls).toBe(40);
      const [{ pending }] = await sql<{ pending: number }[]>`
        select count(*)::int as pending from workspace_runs
        where workspace_id = ${tenant.workspaceId} and workflow_started_at is null
      `;
      expect(pending).toBe(0);
    });
  });

  it("treats a racing start as already started", async () => {
    await withTenant(async ({ sql, tenant }) => {
      const temporal = fakeTemporal();
      const { lifecycle, recovery: r } = recovery(sql, temporal);
      await insertRun(sql, tenant, "run-race", { ageMs: 60_000 });
      // The intake start succeeded but its marker write was lost.
      temporal.workflows.set(tenant.runId("run-race"), Date.now());
      expect(await r.sweepOnce()).toMatchObject({ claimed: 1, started: 1 });
      expect(temporal.workflows.size).toBe(1);
      expect((await runRow(sql, tenant.runId("run-race"))).workflow_started_at).not.toBeNull();
      await expect(lifecycle.start({ id: tenant.runId("run-race"), pipeline: {} as never })).resolves.toEqual({ status: "already-started" });
    });
  });
});
