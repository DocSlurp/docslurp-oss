import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Fast bills from the mandatory usage ledger, never from the optional page facts: a page bills Rich only when a Rich
 * read of it was recorded for the run, and every other page bills Fast. Page facts can be disabled, capped at
 * WORKER_PAGE_FACTS_MAX_PAGES, fail to write, or be absent because render-images found no canonical document or
 * unpaged text; none of that changes a Fast charge.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const pipeline = (quality: "fast" | "auto") => JSON.stringify({ ...defaultPipelineFeatures, quality });

/** Fast run documents, one per way page facts go missing or mislead, plus a document a reader actually read. */
const fastDocs = `
  ('f-facts-off', 'o1', 'u1', 'w', 'fast', 'scan.pdf', 'application/pdf', 'raw/f1', 'completed', 3),
  ('f-write-failed', 'o1', 'u1', 'w', 'fast', 'photo.png', 'image/png', 'raw/f2', 'completed', 1),
  ('f-long-scan', 'o1', 'u1', 'w', 'fast', 'catalog.pdf', 'application/pdf', 'raw/f3', 'completed', 305),
  ('f-no-canonical', 'o1', 'u1', 'w', 'fast', 'odd.pdf', 'application/pdf', 'raw/f4', 'completed', 2),
  ('f-unpaged', 'o1', 'u1', 'w', 'fast', 'unpaged.pdf', 'application/pdf', 'raw/f5', 'completed', 3),
  ('f-read', 'o1', 'u1', 'w', 'fast', 'read.pdf', 'application/pdf', 'raw/f6', 'completed', 2)`;

beforeAll(async () => {
  db = await createMigratedDatabase();
  // Probed facts stop at page 300 (WORKER_PAGE_FACTS_MAX_PAGES): pages 1-300 look like scans with no Fast status,
  // which the old facts-based rule billed Rich; pages 301-305 have no facts at all.
  const longScanFacts = Array.from({ length: 300 }, (_, index) => `('f-long-scan', ${index + 1}, 'fast', 0, 1, null)`).join(",");
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000);
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('fast', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${pipeline("fast")}', 6, 316),
             ('auto', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${pipeline("auto")}', 2, 4);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values
      ${fastDocs},
      ('a-pdf', 'o1', 'u1', 'w', 'auto', 'scan.pdf', 'application/pdf', 'raw/a1', 'completed', 3),
      ('a-png', 'o1', 'u1', 'w', 'auto', 'photo.png', 'image/png', 'raw/a2', 'completed', 1);
    insert into document_page_facts (document_id, page_number, run_id, text_bytes, image_count, vision_status) values
      ${longScanFacts},
      ('f-unpaged', 1, 'fast', 0, 1, null),
      ('a-pdf', 1, 'auto', 120, 0, null), ('a-pdf', 2, 'auto', 0, 1, null), ('a-pdf', 3, 'auto', 0, 1, null);
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

describe("Fast page billing from the usage ledger (recordPageBaseFee)", () => {
  it("bills every page Fast unless the ledger recorded a Rich read of it, whatever the page facts say", { timeout: 60_000 }, async () => {
    // A reader (here a vision page analysis) read page 2 of f-read: the ledger charges it Rich as it is read.
    const reading = WorkflowState.create(await store.loadRun("fast"), []);
    reading.usageLedger.record({
      provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric: "page-analysis",
      inputTokens: 900, outputTokens: 300, metadata: { documentId: "f-read", pageNumber: 2 },
    });
    const batch = reading.usageLedger.checkpoint();
    await persistRunUsageEvents({ client: sql(), state: reading, usageEvents: batch.events });
    batch.commit();
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.richPage)).toBe(1);

    const charges = await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("fast"), []));
    // facts-off 3 + write-failed image 1 + long scan 305 + no-canonical 2 + unpaged 3 + f-read's unread page 1.
    expect(charges).toMatchObject({ fastPages: 315, richPages: 1 });
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.fastPage)).toBe(315);
    // Only the recorded read bills Rich.
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.richPage)).toBe(1);
    const { rows } = await db.query<{ documents: Record<string, { fast: number; rich: number }> }>(
      `select metadata -> 'documents' as documents from usage_events where id = 'fast:fast'`,
    );
    expect(rows[0]?.documents).toMatchObject({ "f-read": { fast: 1, rich: 0 }, "f-write-failed": { fast: 1, rich: 0 }, "f-long-scan": { fast: 305, rich: 0 } });

    // A retry charges nothing twice.
    await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("fast"), []));
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.fastPage)).toBe(315);
    expect(await chargedPages("fast", BILLABLE_UNIT_METRICS.richPage)).toBe(1);
  });

  it("bills a scan or an image file Rich only when its read is recorded; an unread one bills Fast (auto)", { timeout: 60_000 }, async () => {
    // Page facts say pages 2 and 3 of a-pdf are scans (no text bytes, an image). That is never what bills Rich.
    const reading = WorkflowState.create(await store.loadRun("auto"), []);
    reading.usageLedger.record({
      provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric: "page-analysis",
      inputTokens: 900, outputTokens: 300, metadata: { documentId: "a-pdf", pageNumber: 2 },
    });
    // The image file was read by OCR (extract-markdown records it like any read).
    reading.usageLedger.chargeRichPage({ documentId: "a-png", pageNumber: 1, readBy: "image-ocr" });
    // A read recorded for a page the document does not have must not cancel a real page's Fast charge.
    reading.usageLedger.chargeRichPage({ documentId: "a-pdf", pageNumber: 99, readBy: "page-analysis" });
    const batch = reading.usageLedger.checkpoint();
    await persistRunUsageEvents({ client: sql(), state: reading, usageEvents: batch.events });
    batch.commit();

    const charges = await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("auto"), []));
    // a-pdf: pages 1 and 3 Fast (page 2 was read); a-png: its one page was read. Nothing bills Rich here.
    expect(charges).toMatchObject({ fastPages: 2, richPages: 2 });
    const { rows } = await db.query<{ documents: Record<string, { fast: number; rich: number }> }>(
      `select metadata -> 'documents' as documents from usage_events where id = 'fast:auto'`,
    );
    expect(rows[0]?.documents).toEqual({ "a-pdf": { fast: 2, rich: 0 } });
  });

  it("bills an unread image file and an unread scan Fast: unknown or unread is never Rich", { timeout: 60_000 }, async () => {
    await db.exec(`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('auto-unread', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '${pipeline("auto")}', 2, 4);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values
        ('u-pdf', 'o1', 'u1', 'w', 'auto-unread', 'scan.pdf', 'application/pdf', 'raw/u1', 'completed', 3),
        ('u-png', 'o1', 'u1', 'w', 'auto-unread', 'photo.png', 'image/png', 'raw/u2', 'completed', 1);
      insert into document_page_facts (document_id, page_number, run_id, text_bytes, image_count) values
        ('u-pdf', 1, 'auto-unread', 0, 1), ('u-pdf', 2, 'auto-unread', 0, 1), ('u-png', 1, 'auto-unread', 0, 1);
    `);
    const charges = await recordPageBaseFee(sql(), WorkflowState.create(await store.loadRun("auto-unread"), []));
    expect(charges).toMatchObject({ fastPages: 4, richPages: 0 });
  });
});
