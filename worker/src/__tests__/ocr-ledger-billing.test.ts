import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures, pageCredits } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** Scanned pages OCR'd by an extractor bill Rich per page exactly once, across a retried checkpoint and a new attempt's ledger. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('scan', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${JSON.stringify(defaultPipelineFeatures)}', 1, 5);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('scan-pdf', 'o1', 'u1', 'w', 'scan', 'scan.pdf', 'application/pdf', 'raw/s', 'completed', 5);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

const sql = () => (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;

describe("scanned PDF pages OCR'd by Kreuzberg", () => {
  it("bills 3 OCR'd pages Rich and the other 2 Fast, once, across a retry", async () => {
    const attempt = async () => {
      const state = WorkflowState.create(await store.loadRun("scan"), []);
      for (const pageNumber of [2, 3, 5]) state.usageLedger.chargeRichPage({ documentId: "scan-pdf", pageNumber, readBy: "pdf-ocr", model: "kreuzberg" });
      const batch = state.usageLedger.checkpoint();
      await persistRunUsageEvents({ client: sql(), state, usageEvents: batch.events });
      batch.commit();
    };
    await attempt();
    await attempt(); // the activity retried: a new ledger records the same reads under the same ids
    const rich = await db.query<{ n: string; credits: string }>(
      `select coalesce(sum(amount), 0)::text as n, coalesce(sum(cost_cents), 0)::text as credits from usage_events where run_id = 'scan' and metric = $1`, [BILLABLE_UNIT_METRICS.richPage]);
    expect(Number(rich.rows[0]!.n)).toBe(3);
    const charges = await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("scan"), []));
    expect(charges).toMatchObject({ fastPages: 2, richPages: 3 });
    const fast = await db.query<{ credits: string }>(`select coalesce(sum(cost_cents), 0)::text as credits from usage_events where run_id = 'scan' and metric = $1`, [BILLABLE_UNIT_METRICS.fastPage]);
    expect(Number(rich.rows[0]!.credits)).toBeCloseTo(pageCredits("rich", 3));
    expect(Number(fast.rows[0]!.credits)).toBeCloseTo(pageCredits("fast", 2));
  }, 60_000);
});
