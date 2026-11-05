import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { authorizeImageFrames } from "../ocr/image-frames.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/*
 * The frame-count spend check against a migrated database and the real spend check: a TIFF's counted frames are Rich pages
 * admission never priced (intake counted one), so the balance is checked for them before any is charged, summed over the
 * run's TIFFs so concurrent documents cannot each fit alone.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const pipeline = JSON.stringify({ ...defaultPipelineFeatures });

beforeAll(async () => {
  db = await createMigratedDatabase();
  // Balances above the 100-credit starter chat reserve: 5 and 10 spendable credits.
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents)
      values ('o-low', 'Low', 'low', 'u1', 8, 105), ('o-ten', 'Ten', 'ten', 'u1', 8, 110);
    insert into workspaces(id, org_id, user_id, name) values ('w-low', 'o-low', 'u1', 'L'), ('w-ten', 'o-ten', 'u1', 'T');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run-low', 'o-low', 'u1', 'w-low', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 1, 1),
             ('run-ten', 'o-ten', 'u1', 'w-ten', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2, 2);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source) values
      ('tiff-40', 'o-low', 'u1', 'w-low', 'run-low', 'deposition.tiff', 'image/tiff', 'raw/t40', 'processing', 1, 'assumed'),
      ('tiff-a', 'o-ten', 'u1', 'w-ten', 'run-ten', 'a.tiff', 'image/tiff', 'raw/ta', 'processing', 1, 'assumed'),
      ('tiff-b', 'o-ten', 'u1', 'w-ten', 'run-ten', 'b.tiff', 'image/tiff', 'raw/tb', 'processing', 1, 'assumed');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  await store?.close();
  await server?.stop();
  await db?.close();
});

async function stateFor(runId: string, documentId: string): Promise<WorkflowState> {
  const state = WorkflowState.create(await store.loadRun(runId), [(await store.loadDocument(documentId))!]);
  state.store = store;
  state.usageLedger.runId = runId;
  return state;
}

const control = async (runId: string) =>
  (await db.query<{ control_state: string | null; pause_reason: string | null }>(`select control_state, pause_reason from workspace_runs where id = '${runId}'`)).rows[0];
const pageCount = async (documentId: string) =>
  (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = '${documentId}'`)).rows[0];

describe("TIFF frame-count spend check", () => {
  it("pauses the run and refuses a 40-frame TIFF a 5-credit balance cannot cover, before any frame is charged", async () => {
    const state = await stateFor("run-low", "tiff-40");
    // 39 Rich frames beyond intake's page: 9.75 credits.
    await expect(authorizeImageFrames(state, "tiff-40", "extract-markdown", 40)).rejects.toMatchObject({ reason: "spend-paused" });
    expect(await control("run-low")).toEqual({ control_state: "paused", pause_reason: "credit_exhausted" });
    expect(await pageCount("tiff-40")).toEqual({ page_count: 40, page_count_source: "counted" });
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich")).toEqual([]);
  }, 60_000);

  it("adds up the run's TIFFs: two 30-frame files that each fit a 10-credit balance cannot together overdraw it", async () => {
    // 29 extra frames each: 7.25 credits, under the balance alone, 14.5 for the two.
    await authorizeImageFrames(await stateFor("run-ten", "tiff-a"), "tiff-a", "extract-markdown", 30);
    expect((await control("run-ten"))!.control_state).toBeNull();
    // tiff-a's frames are counted but not yet charged (its activity has not checkpointed): tiff-b sees them.
    await expect(authorizeImageFrames(await stateFor("run-ten", "tiff-b"), "tiff-b", "extract-markdown", 30)).rejects.toMatchObject({ reason: "spend-paused" });
    expect((await control("run-ten"))!.control_state).toBe("paused");
    expect((await store.countedImageFrames("run-ten")).map((row) => [row.documentId, row.pageCount, row.chargedPages]).sort()).toEqual([["tiff-a", 30, 0], ["tiff-b", 30, 0]]);
    // Scoped to its run.
    expect((await store.countedImageFrames("run-low")).map((row) => row.documentId)).toEqual(["tiff-40"]);
  }, 60_000);
});
