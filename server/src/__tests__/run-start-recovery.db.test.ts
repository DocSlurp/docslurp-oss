import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createRunLifecycle } from "../services/run-lifecycle.js";
import { createRunStartRecovery } from "../services/run-start-recovery.js";
import type { SqlClient } from "../db.js";

// Real-Postgres check of run-start recovery (claiming, backoff, SKIP LOCKED),
// run inside a throwaway schema with the real 0029 migration applied. Skipped
// without a local DB:
//   RUN_LIFECYCLE_DATABASE_URL=$DATABASE_URL npx vitest run --project api run-start-recovery.db
const databaseUrl = process.env.RUN_LIFECYCLE_DATABASE_URL ?? "";
const isLocal =
  databaseUrl !== "" && ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname);

const migration = readFileSync(
  fileURLToPath(new URL("../../db/migrations/0029_run_workflow_start_tracking.sql", import.meta.url)),
  "utf8",
);

const temporalDown = new Error(
  "Temporal API client could not connect to Temporal at temporal.example.invalid:7233.\noriginalError=Error: Failed to connect before the deadline",
);

type Clients = { sql: SqlClient; other: SqlClient };

async function withSchema(run: (clients: Clients) => Promise<void>): Promise<void> {
  const schema = `run_start_recovery_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`create schema ${schema}`);
  const connect = () =>
    postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => {}, connection: { search_path: schema } });
  const sql = connect();
  const other = connect();
  try {
    await sql.unsafe(`
      create table workspace_runs (
        id text primary key, user_id text not null, status text not null, stage text not null,
        control_state text, control_requested_at timestamptz, error text,
        stats jsonb not null default '{}', pipeline jsonb not null default '{}',
        failure_count integer not null default 0, dead_lettered_at timestamptz, dead_letter_reason text,
        lease_expires_at timestamptz, last_heartbeat_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
    `);
    for (const statement of migration.split("--> statement-breakpoint")) {
      await sql.unsafe(statement);
    }
    await run({ sql: sql as unknown as SqlClient, other: other as unknown as SqlClient });
  } finally {
    await sql.end();
    await other.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
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

const config = { graceMs: 10_000, batchSize: 25, leaseMs: 30_000 };

function recovery(sql: SqlClient, temporal: ReturnType<typeof fakeTemporal>) {
  const lifecycle = createRunLifecycle({
    sql,
    startWorkflow: temporal.startWorkflow,
    failureThreshold: 3,
    startRetryBackoff: { baseMs: 2_000, maxMs: 60_000 },
  });
  return { lifecycle, recovery: createRunStartRecovery({ sql, lifecycle, config }) };
}

async function insertRun(sql: SqlClient, id: string, values: { ageMs?: number; status?: string; controlState?: string; started?: boolean } = {}) {
  await sql`
    insert into workspace_runs (id, user_id, status, stage, control_state, created_at, workflow_started_at)
    values (
      ${id}, 'user-1', ${values.status ?? "queued"}, 'queued', ${values.controlState ?? null},
      now() - (${values.ageMs ?? 0} * interval '1 millisecond'),
      ${values.started ? sql`now()` : null}
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
    await withSchema(async ({ sql }) => {
      const temporal = fakeTemporal();
      const { lifecycle, recovery: r } = recovery(sql, temporal);
      await insertRun(sql, "run-deferred");

      // Intake right after an app restart: Temporal connect deadline.
      temporal.state.down = true;
      const deferredAt = Date.now();
      await expect(lifecycle.start({ id: "run-deferred", pipeline: {} as never })).resolves.toMatchObject({ status: "deferred" });
      const pending = await runRow(sql, "run-deferred");
      expect(pending.workflow_started_at).toBeNull();
      expect(pending.workflow_start_attempts).toBe(1);
      expect(pending.workflow_start_next_at!.getTime()).toBeGreaterThan(Date.now());

      // Temporal still down: a pass inside the backoff claims nothing, and a
      // forced pass defers again without spending one connect per run.
      expect(await r.sweepOnce()).toMatchObject({ claimed: 0 });
      expect(await r.sweepOnce({ ignoreBackoff: true })).toMatchObject({ claimed: 1, deferred: 1 });
      expect((await runRow(sql, "run-deferred")).workflow_start_attempts).toBe(2);

      // Temporal reachable: the client's connect listener kicks with ignoreBackoff.
      temporal.state.down = false;
      expect(await r.kick({ ignoreBackoff: true })).toMatchObject({ started: 1 });
      expect(temporal.workflows.has("run-deferred")).toBe(true);
      expect(Date.now() - deferredAt).toBeLessThan(5_000);
      const started = await runRow(sql, "run-deferred");
      expect(started.workflow_started_at).not.toBeNull();
      expect(started.workflow_start_next_at).toBeNull();

      // Confirmed starts are never re-issued.
      const calls = temporal.state.startCalls;
      expect(await r.sweepOnce({ ignoreBackoff: true })).toMatchObject({ claimed: 0 });
      expect(temporal.state.startCalls).toBe(calls);
    });
  });

  it("retries on the backoff schedule without a connect event", async () => {
    await withSchema(async ({ sql }) => {
      const temporal = fakeTemporal();
      const { lifecycle, recovery: r } = recovery(sql, temporal);
      await insertRun(sql, "run-backoff");
      temporal.state.down = true;
      await lifecycle.start({ id: "run-backoff", pipeline: {} as never });
      temporal.state.down = false;

      expect(await r.sweepOnce()).toMatchObject({ claimed: 0 });
      // First retry is due after the 2 s base backoff.
      await sql`update workspace_runs set workflow_start_next_at = now() - interval '1 ms' where id = 'run-backoff'`;
      expect(await r.sweepOnce()).toMatchObject({ claimed: 1, started: 1 });
    });
  });

  it("boot pass starts orphaned queued runs and leaves runs that are legitimately waiting", async () => {
    await withSchema(async ({ sql }) => {
      const temporal = fakeTemporal();
      const { recovery: r } = recovery(sql, temporal);
      // Intake request died after creating the run (no start, no deferral marker).
      await insertRun(sql, "run-orphan", { ageMs: 60_000 });
      // Intake still in flight: its own start goes first.
      await insertRun(sql, "run-fresh");
      // Started, waiting for worker slots.
      await insertRun(sql, "run-waiting", { ageMs: 60_000, started: true });
      await insertRun(sql, "run-paused", { ageMs: 60_000, controlState: "paused" });
      await insertRun(sql, "run-processing", { ageMs: 60_000, status: "processing" });

      expect(await r.kick()).toMatchObject({ claimed: 1, started: 1 });
      expect([...temporal.workflows.keys()]).toEqual(["run-orphan"]);
      expect((await runRow(sql, "run-orphan")).workflow_started_at).not.toBeNull();
    });
  });

  it("never double-starts across concurrent app instances", async () => {
    await withSchema(async ({ sql, other }) => {
      const temporal = fakeTemporal();
      temporal.state.delayMs = 20;
      const a = recovery(sql, temporal).recovery;
      const b = recovery(other, temporal).recovery;
      for (let index = 0; index < 40; index += 1) {
        await insertRun(sql, `run-${index}`, { ageMs: 60_000 });
      }

      const [passA, passB] = await Promise.all([a.kick(), b.kick()]);
      expect(passA.started + passB.started).toBe(40);
      expect(temporal.workflows.size).toBe(40);
      // SKIP LOCKED + the claim lease: every run was started exactly once.
      expect(temporal.state.startCalls).toBe(40);
      const [{ pending }] = await sql<{ pending: number }[]>`
        select count(*)::int as pending from workspace_runs where workflow_started_at is null
      `;
      expect(pending).toBe(0);
    });
  });

  it("treats a racing start as already started", async () => {
    await withSchema(async ({ sql }) => {
      const temporal = fakeTemporal();
      const { lifecycle, recovery: r } = recovery(sql, temporal);
      await insertRun(sql, "run-race", { ageMs: 60_000 });
      // The intake start succeeded but its marker write was lost.
      temporal.workflows.set("run-race", Date.now());
      expect(await r.sweepOnce()).toMatchObject({ claimed: 1, started: 1 });
      expect(temporal.workflows.size).toBe(1);
      expect((await runRow(sql, "run-race")).workflow_started_at).not.toBeNull();
      await expect(lifecycle.start({ id: "run-race", pipeline: {} as never })).resolves.toEqual({ status: "already-started" });
    });
  });
});
