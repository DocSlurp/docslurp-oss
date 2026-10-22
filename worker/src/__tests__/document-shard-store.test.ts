import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseOrgDemand, queryWorkerScalerSnapshot } from "@docslurp/shared";
import { Store } from "../db/store.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Document shards of one stage run side by side, each from its own snapshot
 * of the run. Their checkpoints must add to the run row (artifacts, spend),
 * never overwrite each other, and their pending count drives the autoscaler.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('big', 'Big', 'big', 'u1', 64, 1000), ('small', 'Small', 'small', 'u1', 2, 1000)`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('wb', 'big', 'u1', 'B'), ('ws', 'small', 'u1', 'S')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts) values
    ('run-big', 'big', 'u1', 'wb', 'bulk-upload', 'processing', 'document-summary', '{}', '{"doc-0:markdown":"s3://m0"}'),
    ('run-small', 'small', 'u1', 'ws', 'bulk-upload', 'processing', 'document-summary', '{}', '{}')`;
  // Spend from before the shards, counted by the usage_events trigger (0056).
  await sql`insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents)
    values ('ue-prior', 'u1', 'run-big', 'openrouter', 'm', 'page-analysis', 1, 'request', 10)`;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

async function shardState(runId: string, documentIds: string[]): Promise<WorkflowState> {
  const state = WorkflowState.create(await store.loadRun(runId), []);
  state.stage = "embed";
  state.beginShard(documentIds);
  return state;
}

describe("document shard checkpoints", () => {
  it("merge artifacts and add cost from concurrent shards without clobbering", async () => {
    await store.setRunShardDemand("run-big", 2);
    const [a, b] = await Promise.all([shardState("run-big", ["doc-1"]), shardState("run-big", ["doc-2"])]);
    a.artifactLedger.record("doc-1:embeddings", "s3://e1");
    const spend = (state: WorkflowState, costCents: number) => state.usageLedger.enqueue({
      provider: "docslurp", model: "price-card", metric: "ingest-page-fast", amount: 1, unit: "page", costCents,
      metadata: { billable: true, unitCharge: true } });
    expect(a.run.spentCents).toBe(10);
    spend(a, 3);
    b.artifactLedger.record("doc-2:embeddings", "s3://e2");
    spend(b, 4);

    await store.updateProgress(a);
    expect(a.run.spentCents).toBe(13);
    await store.finishShard(b);
    // Each checkpoint refreshes the run-wide figure, other shards' spend included.
    expect(b.run.spentCents).toBe(17);
    a.artifactLedger.record("doc-1:document-summary", "s3://s1");
    spend(a, 1);
    await store.finishShard(a);
    expect(a.run.spentCents).toBe(18);

    const [row] = await sql<{ artifacts: Record<string, string>; spent_cents: string; status: string; stage: string; shard_demand: number }[]>`
      select artifacts, spent_cents, status, stage, shard_demand from workspace_runs where id = 'run-big'`;
    expect(row!.artifacts).toEqual({
      "doc-0:markdown": "s3://m0",
      "doc-1:embeddings": "s3://e1",
      "doc-1:document-summary": "s3://s1",
      "doc-2:embeddings": "s3://e2",
    });
    expect(Number(row!.spent_cents)).toBe(18);
    expect(row!.status).toBe("processing");
    expect(row!.stage).toBe("embed");
    expect(row!.shard_demand).toBe(0);
  });

  it("count a shard's cost once when its documents checkpoint concurrently", async () => {
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts)
      values ('run-cost', 'small', 'u1', 'ws', 'bulk-upload', 'completed', 'index', '{}', '{}')`;
    const state = await shardState("run-cost", ["doc-9"]);
    state.usageLedger.enqueue({ provider: "docslurp", model: "price-card", metric: "ingest-page-rich", amount: 20, unit: "page", costCents: 5,
      metadata: { billable: true, unitCharge: true } });
    // Each delta is taken against the last committed checkpoint, so overlapping
    // checkpoints of one state must not both add it.
    await Promise.all([store.updateProgress(state), store.updateProgress(state), store.finishShard(state)]);
    const [row] = await sql<{ spent_cents: string }[]>`select spent_cents from workspace_runs where id = 'run-cost'`;
    expect(Number(row!.spent_cents)).toBe(5);
    expect(state.run.spentCents).toBe(5);
    const [usage] = await sql<{ cents: string }[]>`select coalesce(sum(cost_cents), 0) as cents from usage_events where run_id = 'run-cost'`;
    expect(Number(usage!.cents)).toBe(5);
  });

  it("turn pending shards into slot demand, capped by the org's slots", async () => {
    await store.setRunShardDemand("run-big", 10);
    await store.setRunShardDemand("run-small", 10);
    const snapshot = await queryWorkerScalerSnapshot(sql, { pageFanout: 128, defaultOrgSlots: 2, loadtestMaxMachines: 125 });
    const demand = Object.fromEntries(parseOrgDemand(snapshot.org_demand).map((org) => [org.orgKey, org.demand]));
    expect(demand).toEqual({ big: 10, small: 2 });

    // The stage's own pass starts once its shards are done.
    const state = WorkflowState.create(await store.loadRun("run-big"), []);
    await store.startRunStage(state, "embed");
    const [row] = await sql<{ shard_demand: number }[]>`select shard_demand from workspace_runs where id = 'run-big'`;
    expect(row!.shard_demand).toBe(0);
  });
});
