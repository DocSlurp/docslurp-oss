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
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
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
  it("rejects stale generations and terminal owners without changing persisted progress", { timeout: 60000 }, async () => {
    const owner = { runId: "r1", orgId: "o1", workspaceId: "w", executionGeneration: "A" };
    await db.exec("update workspace_runs set execution_generation = 'A' where id = 'r1'");
    const stale = await loadRunState(store, "r1", { hydrate: false });
    await db.exec("update workspace_runs set execution_generation = 'B' where id = 'r1'");
    const snapshot = async () => ({
      run: (await db.query("select * from workspace_runs where id = 'r1'")).rows,
      stages: (await db.query("select * from workspace_run_stage_states")).rows,
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
      await db.exec("update workspace_runs set " + change + " where id = 'r1'");
      const beforeTerminal = await snapshot();
      await expect(store.startRunStage(stale, "vision-extract", current)).rejects.toThrow("ownership");
      await expect(store.pageTasks.enqueueWithPayload(tasks, undefined, current)).rejects.toThrow("ownership");
      expect(await snapshot()).toEqual(beforeTerminal);
    }
  });
});
