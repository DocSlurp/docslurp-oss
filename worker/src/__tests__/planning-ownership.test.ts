import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** OP-07: ordinary stage failures are counted in the checkpoint, not from Temporal attempts. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots) values ('o1', 'Org', 'org', 'u1', 8);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r1', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'extract-markdown', '${JSON.stringify(defaultPipelineFeatures)}', 0, 0);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});


describe("planning ownership", () => {
  it("retries payload enqueue without replacing payloads or completed task state", async () => {
    await db.exec("update project_runs set execution_generation = 'A' where id = 'r1'");
    await db.exec(`insert into documents(id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
      values ('d1', 'o1', 'u1', 'w', 'r1', 'test.pdf', 'application/pdf', 'raw/test.pdf', 'processing')`);
    const owner = { runId: "r1", orgId: "o1", projectId: "w", executionGeneration: "A" };
    const tasks = Array.from({ length: 101 }, (_, index) => ({ runId: "r1", documentId: "d1", pageNumber: index + 1 } as import("../temporal/shared.js").VisionPageTask));
    await store.pageTasks.enqueue(tasks, owner);
    expect(await store.pageTasks.enqueueWithPayload(tasks, () => {}, owner)).toBe(101);
    await db.exec("update page_work_tasks set status = 'completed', result = '{\"text\":\"done\"}', attempts = 1 where page_number = 1");
    const before = (await db.query("select * from page_work_tasks order by page_number")).rows;
    expect(await store.pageTasks.enqueueWithPayload(tasks, () => {}, owner)).toBe(101);
    expect((await db.query("select * from page_work_tasks order by page_number")).rows).toEqual(before);
    expect(await store.pageTasks.loadBatch("r1", 0, 101)).toEqual(tasks);
  });

  it("settles billed receipts once while rejecting stale planner progress", async () => {
    await db.exec("update project_runs set execution_generation = 'A' where id = 'r1'");
    const state = await loadRunState(store, "r1", { hydrate: false });
    state.usageLedger.enqueue({ provider: "docslurp", model: "rich", metric: "ingest-page-rich", amount: 1,
      unit: "page", costCents: 2, metadata: { unitCharge: true } });
    await db.exec("update project_runs set execution_generation = 'B' where id = 'r1'");
    const progress = async () => (await db.query("select status, stage, artifacts, stats, pages_processed, execution_generation from project_runs where id = 'r1'")).rows;
    const before = await progress();
    const owner = { runId: "r1", orgId: "o1", projectId: "w", executionGeneration: "A" };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(store.startRunStage(state, "vision-extract", owner)).rejects.toThrow("ownership");
      expect(await progress()).toEqual(before);
      expect((await db.query("select * from project_run_stage_states")).rows).toEqual([]);
      const receipts = (await db.query("select cost_cents, org_id, project_id from usage_events where run_id = 'r1'")).rows;
      expect(receipts).toEqual([{ cost_cents: "2.000000000000", org_id: "o1", project_id: "w" }]);
      expect(Number((await db.query<{ spent_cents: string }>("select spent_cents from project_runs where id = 'r1'")).rows[0]!.spent_cents)).toBe(2);
      expect(Number((await db.query<{ credits: string }>("select sum(credits) as credits from credit_debits_pending where run_id = 'r1'")).rows[0]!.credits)).toBe(2);
      expect(state.usageLedger.checkpoint().events).toHaveLength(0);
    }
  });

  it("rejects stale generations and terminal owners without changing persisted progress", { timeout: 60000 }, async () => {
    const owner = { runId: "r1", orgId: "o1", projectId: "w", executionGeneration: "A" };
    await db.exec("update project_runs set execution_generation = 'A' where id = 'r1'");
    const stale = await loadRunState(store, "r1", { hydrate: false });
    await db.exec("update project_runs set execution_generation = 'B' where id = 'r1'");
    const snapshot = async () => ({
      run: (await db.query("select * from project_runs where id = 'r1'")).rows,
      stages: (await db.query("select * from project_run_stage_states")).rows,
      tasks: (await db.query("select * from page_work_tasks")).rows,
    });
    const tasks = [{ runId: "r1", documentId: "absent", pageNumber: 1 }] as import("../temporal/shared.js").VisionPageTask[];
    const before = await snapshot();
    await expect(store.startRunStage(stale, "vision-extract", owner)).rejects.toThrow("ownership");
    await expect(store.pageTasks.enqueue(tasks, owner)).rejects.toThrow("ownership");
    await expect(store.pageTasks.enqueueWithPayload(tasks, undefined, owner)).rejects.toThrow("ownership");
    expect(await snapshot()).toEqual(before);
    const current = { ...owner, executionGeneration: "B" };
    await store.startRunStage(await loadRunState(store, "r1", { hydrate: false }), "vision-extract", current);
    await store.startRunStage(await loadRunState(store, "r1", { hydrate: false }), "vision-extract", current);
    for (const change of ["status = 'completed'", "status = 'processing', control_state = 'cancel_requested'"]) {
      await db.exec("update project_runs set " + change + " where id = 'r1'");
      const beforeTerminal = await snapshot();
      await expect(store.startRunStage(stale, "vision-extract", current)).rejects.toThrow("ownership");
      await expect(store.pageTasks.enqueueWithPayload(tasks, undefined, current)).rejects.toThrow("ownership");
      expect(await snapshot()).toEqual(beforeTerminal);
    }
  });
});
