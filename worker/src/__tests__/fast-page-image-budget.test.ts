import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The per-run Fast page-image render cap is one Postgres budget shared by every worker process: concurrent workers
 * never grant more than the cap in total, and a document's grant survives a worker restart, so shards and retries
 * reuse it instead of spending the budget again.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let port: number;
const stores: Store[] = [];

const DOCUMENTS = 12;

function worker(): Store {
  const store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, {
    poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 },
  });
  stores.push(store);
  return store;
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  const documents = Array.from({ length: DOCUMENTS }, (_, index) =>
    `('d${index}', 'o1', 'u1', 'w', 'run', 'd${index}.pdf', 'application/pdf', 'raw/d${index}', 'processing', 40)`).join(",");
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000);
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'render-images', '{}', ${DOCUMENTS}, ${DOCUMENTS * 40});
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values ${documents};
  `);
  // Several connections, like several worker processes; PGlite serializes them, transactions included.
  const served = await serveOnRandomPort(db, { maxConnections: 8 });
  server = served.server;
  port = served.port;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  for (const store of stores) await store.close();
  await server?.stop();
  await db?.close();
});

describe("Fast page-image render budget (Postgres, shared by workers)", () => {
  it("never grants more than the per-run cap across concurrent workers", { timeout: 60_000 }, async () => {
    const workers = [worker(), worker(), worker()];
    const grants = await Promise.all(Array.from({ length: DOCUMENTS }, (_, index) =>
      workers[index % workers.length]!.reserveFastPageImageRenders({ runId: "run", documentId: `d${index}`, wanted: 10, perRun: 45 })));
    expect(grants.reduce((sum, granted) => sum + granted, 0)).toBe(45);
    expect(grants.every((granted) => granted >= 0 && granted <= 10)).toBe(true);
    const { rows } = await db.query<{ used: number }>(`select used from run_fast_page_image_budgets where run_id = 'run'`);
    expect(rows[0]?.used).toBe(45);

    // Shards and retries of a document on any worker get its grant back without spending more.
    for (const [index, granted] of grants.entries()) {
      expect(await workers[(index + 1) % workers.length]!.reserveFastPageImageRenders({ runId: "run", documentId: `d${index}`, wanted: 10, perRun: 45 }))
        .toBe(granted);
    }
    expect((await db.query<{ used: number }>(`select used from run_fast_page_image_budgets where run_id = 'run'`)).rows[0]?.used).toBe(45);
  });

  it("keeps grants across a worker restart", { timeout: 60_000 }, async () => {
    const before = worker();
    const { rows } = await db.query<{ document_id: string; granted: number }>(
      `select document_id, granted from run_fast_page_image_grants where run_id = 'run' and granted > 0 order by document_id limit 1`,
    );
    const granted = rows[0]!;
    await before.close();
    stores.splice(stores.indexOf(before), 1);

    const restarted = worker();
    // The restarted worker sees the stored grant, and a document new to it finds the budget already spent.
    expect(await restarted.reserveFastPageImageRenders({ runId: "run", documentId: granted.document_id, wanted: 10, perRun: 45 })).toBe(granted.granted);
    await db.exec(`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('late', 'o1', 'u1', 'w', 'run', 'late.pdf', 'application/pdf', 'raw/late', 'processing', 5)`);
    expect(await restarted.reserveFastPageImageRenders({ runId: "run", documentId: "late", wanted: 5, perRun: 45 })).toBe(0);
  });
});
