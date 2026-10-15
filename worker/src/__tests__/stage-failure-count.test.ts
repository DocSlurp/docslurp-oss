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
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
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

describe("stage ordinary failure count", () => {
  it("increments on ordinary failures only and survives restarts of the stage", { timeout: 60_000 }, async () => {
    const state = await loadRunState(store, "r1", { hydrate: false });
    expect(await store.failRunStage(state, "extract-markdown", "parser exited 1")).toBe(1);
    // A retry restarts the stage (interruption-free path); the count is kept.
    await store.startRunStage(state, "extract-markdown");
    expect(await store.failRunStage(state, "extract-markdown", "provider 429", { countFailure: false })).toBe(1);
    await store.startRunStage(state, "extract-markdown");
    expect(await store.failRunStage(state, "extract-markdown", "parser exited 1")).toBe(2);
    const rows = await db.query<{ status: string; attempts: number; ordinary: string }>(
      "select status, attempts, stats->>'ordinaryFailures' as ordinary from workspace_run_stage_states where run_id = 'r1'");
    expect(rows.rows[0]).toMatchObject({ status: "failed", ordinary: "2" });
  });
});
