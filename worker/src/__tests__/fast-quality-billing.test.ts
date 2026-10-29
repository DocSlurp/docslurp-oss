import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Fast bills by what the run observed, not by the mode it declared: a page bills Fast only with a native text layer
 * or when Fast recorded it as kept as an image or left unread. A scanned page that ended up read (no such status),
 * or an image file Fast did not record as kept, bills Rich.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const pipeline = (quality: "fast" | "auto") => JSON.stringify({ ...defaultPipelineFeatures, quality });

beforeAll(async () => {
  db = await createMigratedDatabase();
  const docs = (run: string) => `
    ('${run}-pdf', 'o1', 'u1', 'w', '${run}', 'scan.pdf', 'application/pdf', 'raw/${run}-pdf', 'completed', 3),
    ('${run}-odd-image', 'o1', 'u1', 'w', '${run}', 'scan.xyz', 'image/x-unknown-scan', 'raw/${run}-odd', 'completed', 1),
    ('${run}-png', 'o1', 'u1', 'w', '${run}', 'photo.png', 'image/png', 'raw/${run}-png', 'completed', 1),
    ('${run}-capped', 'o1', 'u1', 'w', '${run}', 'big.pdf', 'application/pdf', 'raw/${run}-capped', 'completed', 2)`;
  const facts = (run: string, fastStatuses: boolean) => `
    ('${run}-pdf', 1, '${run}', 120, 0, null),
    ('${run}-pdf', 2, '${run}', 0, 1, ${fastStatuses ? "'kept-as-image'" : "null"}),
    ('${run}-pdf', 3, '${run}', 0, 1, null),
    ('${run}-odd-image', 1, '${run}', null, null, ${fastStatuses ? "'kept-as-image'" : "null"}),
    ('${run}-capped', 1, '${run}', 0, 1, ${fastStatuses ? "'not-read'" : "null"}),
    ('${run}-capped', 2, '${run}', 0, 1, ${fastStatuses ? "'not-read'" : "null"})`;
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000);
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('fast', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${pipeline("fast")}', 4, 7),
             ('auto', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${pipeline("auto")}', 4, 7);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values
      ${docs("fast")}, ${docs("auto")};
    insert into document_page_facts (document_id, page_number, run_id, text_bytes, image_count, vision_status) values
      ${facts("fast", true)}, ${facts("auto", false)};
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, {
    poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 },
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

const sql = () => (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;

async function chargedPages(runId: string, metric: string): Promise<number> {
  const { rows } = await db.query<{ v: string }>(
    `select coalesce(sum(amount), 0)::text as v from usage_events where run_id = $1 and metric = $2`, [runId, metric],
  );
  return Number(rows[0]?.v ?? 0);
}

describe("Fast page billing by observed outcome (recordPageBaseFee)", () => {
  it("bills Fast only for text-layer pages and pages Fast kept as images or left unread", { timeout: 60_000 }, async () => {
    const charges = await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("fast"), []));
    // pdf: p1 text + p2 kept-as-image Fast, p3 scanned with no Fast status (read anyway) Rich.
    // Unknown image/* MIME kept as image: Fast. PNG with no kept-as-image record: Rich. Capped scans left unread: Fast.
    expect(charges).toMatchObject({ fastPages: 5, richPages: 2 });
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.fastPage)).toBe(5);
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.richPage)).toBe(2);

    // A retry charges nothing twice.
    await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("fast"), []));
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.fastPage)).toBe(5);
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.richPage)).toBe(2);
  });

  it("still bills every scan and image file Rich under auto", { timeout: 60_000 }, async () => {
    const charges = await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("auto"), []));
    // pdf: 2 scans Rich, 1 text Fast; both image files Rich; both capped-document scans Rich.
    expect(charges).toMatchObject({ fastPages: 1, richPages: 6 });
  });
});
