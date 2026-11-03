import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user" (id,name,email) values ('terminal-u','U','terminal@example.test');
    insert into organizations (id,name,slug,created_by_user_id,credit_balance_cents)
      values ('terminal-o','O','terminal-o','terminal-u',1000000);
    insert into workspaces (id,org_id,user_id,name) values ('terminal-w','terminal-o','terminal-u','W');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
}, 60_000);
afterAll(async () => { await server?.stop(); await db?.close(); });
async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(url, 60_000, { poolMax: 1 });
  try { return await fn(store); } finally { await store.close(); }
}

describe("late run checkpoints", () => {
  it.each(["cancelled", "failed", "completed"])("refuses completion after external %s while settling usage once", async status => {
    const id = `external-${status}`;
    await db.query(`insert into workspace_runs (id,org_id,user_id,workspace_id,kind,status,stage,pipeline,total_documents)
      values ($1,'terminal-o','terminal-u','terminal-w','upload','processing','embed','{}',0)`, [id]);
    await withStore(async store => {
      const state = await loadRunState(store, id);
      const token = (await db.query<{ execution_generation: string }>("select execution_generation from workspace_runs where id=$1", [id])).rows[0]!.execution_generation;
      const owner = { runId: id, orgId: "terminal-o", workspaceId: "terminal-w", executionGeneration: token };
      state.usageLedger.record({ provider: "openai", model: "text-embedding-3-small", metric: "embedding-tokens", inputTokens: 7, costCents: 0.01, logOutputTokens: false });
      await db.query("update workspace_runs set status=$2, stage=$2 where id=$1", [id, status]);
      for (let i = 0; i < 2; i++) await expect(store.completeRun(state, owner)).rejects.toThrow("ownership");
      expect((await db.query("select status from workspace_runs where id=$1", [id])).rows).toEqual([{ status }]);
      expect((await db.query("select id from run_terminal_receipts where run_id=$1", [id])).rows).toHaveLength(0);
      expect((await db.query("select id from webhook_outbox where payload->>'runId'=$1", [id])).rows).toHaveLength(0);
      expect((await db.query("select id from usage_events where run_id=$1", [id])).rows).toHaveLength(1);
    });
  });
  it.each(["failed", "completed"])("preserves a concurrent %s outcome while settling paid usage", async (terminal) => {
    const id = `terminal-${terminal}`;
    await db.query(`insert into workspace_runs (id,org_id,user_id,workspace_id,kind,status,stage,pipeline,total_documents)
      values ($1,'terminal-o','terminal-u','terminal-w','upload','processing','embed','{}',0)`, [id]);
    const stale = await withStore(store => loadRunState(store, id));
    stale.usageLedger.record({ provider: "openai", model: "text-embedding-3-small", metric: "embedding-tokens", inputTokens: 7, costCents: 0.01, logOutputTokens: false });
    await db.query(`update workspace_runs set status=$2,stage=$2,lease_expires_at=null,last_heartbeat_at=null where id=$1`, [id,terminal]);
    await withStore(store => store.updateProgress(stale));
    const row = await db.query(`select status,stage,lease_expires_at,last_heartbeat_at from workspace_runs where id=$1`, [id]);
    expect(row.rows[0]).toEqual({ status: terminal, stage: terminal, lease_expires_at: null, last_heartbeat_at: null });
    const usage = await db.query<{ count: number }>(`select count(*)::int as count from usage_events where run_id=$1`, [id]);
    expect(usage.rows[0]?.count).toBe(1);
    expect(stale.usageLedger.checkpoint().events).toHaveLength(0);
  });

  it("allows a fresh checkpoint after an explicit retry resets a failed run to queued", async () => {
    await db.exec(`update workspace_runs set status='queued',stage='queued' where id='terminal-failed'`);
    await withStore(async store => {
      const fresh = await loadRunState(store, "terminal-failed");
      fresh.run.status = "processing";
      fresh.stage = "index";
      await store.updateProgress(fresh);
    });
    const row = await db.query(`select status,stage from workspace_runs where id='terminal-failed'`);
    expect(row.rows[0]).toEqual({ status: "processing", stage: "index" });
  });
});

describe("initialization execution fence", () => {
  it("rejects delayed init after failure, cancellation and a newer intent", async () => {
    const id = "init-generation";
    await db.exec(`insert into workspace_runs (id,org_id,user_id,workspace_id,kind,status,stage,pipeline,total_documents)
      values ('init-generation','terminal-o','terminal-u','terminal-w','upload','queued','queued','{}',0)`);
    const token = (await db.query<{ execution_generation: string }>("select execution_generation from workspace_runs where id=$1", [id])).rows[0]!.execution_generation;
    expect(token).toBeTruthy();
    await withStore(async store => {
      const stale = await loadRunState(store, id);
      await store.updateProgress(stale, { executionGeneration: token });
      await store.updateProgress(stale, { executionGeneration: token });
      await db.query("update workspace_runs set status='failed' where id=$1", [id]);
      await expect(store.updateProgress(stale, { executionGeneration: token })).rejects.toThrow("ownership");
      await db.query("update workspace_runs set status='queued', control_state='cancel_requested' where id=$1", [id]);
      await expect(store.updateProgress(stale, { executionGeneration: token })).rejects.toThrow("ownership");
      await db.query("update workspace_runs set control_state=null, execution_generation=gen_random_uuid()::text where id=$1", [id]);
      await expect(store.updateProgress(stale, { executionGeneration: token })).rejects.toThrow("ownership");
      await expect(store.updateProgress(stale, {})).rejects.toThrow("ownership");
      const row = (await db.query<{ status: string }>("select status from workspace_runs where id=$1", [id])).rows[0];
      expect(row?.status).toBe("queued");
    });
  });
});
