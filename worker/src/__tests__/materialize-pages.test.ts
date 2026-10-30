import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Sql } from "postgres";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { claimPages, ensurePageRows } from "../deferred/page-ledger.js";
import { materializePageRange, type PageMaterializerDeps, type PageMaterializerOps } from "../deferred/materialize-pages.js";
import { Store } from "../db/store.js";
import type { Document } from "../models.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { VisionOutputRejectedError } from "../tools/vision-stream.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let store: Store;

const LONG = "Quarterly revenue grew steadily across every region this period, driven by subscription renewals and new enterprise contracts.";

const document: Document = {
  id: "d1", userId: "u1", runId: "run-1", filename: "a.pdf", mimeType: "application/pdf",
  sourceKey: "k1", status: "processing", extractionMode: "auto", pageCount: 6,
  createdAt: new Date(), updatedAt: new Date(),
} as Document;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w', 'run-1', 'a.pdf', 'application/pdf', 'k1', 'processing', 6);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
  store = new Store(url, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  // The PGlite socket serves one connection, so the ledger shares the store's pool.
  sql = (store as unknown as { sql: Sql }).sql;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

interface Harness {
  deps: PageMaterializerDeps;
  usage: PipelineUsageEventLedger;
  ocrCalls: number[];
  embedCalls: string[][];
  lanceWrites: Array<{ id: string; text: string }[]>;
  lanceDeletes: string[];
  run: { id: string; orgId: string; userId: string; workspaceId: string };
}

function harness(pageTexts: Record<number, string>, overrides: Partial<PageMaterializerOps> = {}): Harness {
  const usage = new PipelineUsageEventLedger();
  const h = {
    ocrCalls: [] as number[],
    embedCalls: [] as string[][],
    lanceWrites: [] as Array<{ id: string; text: string }[]>,
    lanceDeletes: [] as string[],
    usage,
    run: { id: "run-1", orgId: "o1", userId: "u1", workspaceId: "w" },
  } as unknown as Harness;
  const ops: PageMaterializerOps = {
    async extractText(_doc, range) {
      return Array.from({ length: range.last - range.first + 1 }, (_, i) => pageTexts[range.first + i] ?? "");
    },
    async ocrPage(_doc, page) {
      h.ocrCalls.push(page);
      return { text: `${LONG} scanned page ${page}`, model: "vision-x", provider: "test", inputTokens: 1000, outputTokens: 200, costCents: 2 };
    },
    async embed(args) {
      h.embedCalls.push(args.chunks);
      await args.onRemoteUsage?.({ inputTokens: 111 * h.embedCalls.length, chunks: args.chunks.length, costCents: 1 });
      return { vectors: args.chunks.map(() => [0.1, 0.2, 0.3]), usage: {}, totalTokens: 111 };
    },
    async writeVectors(_uri, _table, records) {
      h.lanceWrites.push(records.map((r) => ({ id: r.id, text: r.text })));
    },
    async deleteVectors(_uri, _table, ids) {
      h.lanceDeletes.push(...ids);
    },
    ...overrides,
  };
  h.deps = {
    sql, store, usage,
    storage: {} as never, runner: {} as never,
    config: { lancedb: { root: "/tmp/none", storageOptions: undefined, params: new URLSearchParams() }, defaultInferenceLane: "balanced", vectorBackends: ["lancedb"] } as unknown as Config,
    ops,
  };
  return h;
}

// The materializer only indexes pages its run holds, so each call claims them first, as runMaterializeRange does.
async function claimAndMaterialize(...args: Parameters<typeof materializePageRange>): ReturnType<typeof materializePageRange> {
  const [, range] = args;
  await claimPages(sql, { documentId: range.documentId, pages: range.pages, runId: range.runId, ttlSeconds: 300, reason: range.reason });
  return await materializePageRange(...args);
}

const input = (h: Harness, pages: number[], pipeline = defaultPipelineFeatures) => ({
  runId: "run-1", documentId: "d1", pages, reason: "query" as const, sessionId: null, maxCredits: 100,
  document, pipeline, run: h.run as never,
});

beforeEach(async () => {
  await db.exec(`delete from document_chunks; delete from document_pages; delete from document_page_states;`);
  await ensurePageRows(sql, "d1", 6);
});

describe("materializePageRange", () => {
  it("uses the text layer and skips OCR for text pages", async () => {
    const h = harness({ 1: LONG, 2: LONG + " second" });
    const result = await claimAndMaterialize(h.deps, input(h, [1, 2]));
    expect(result.indexed).toEqual([1, 2]);
    expect(h.ocrCalls).toEqual([]);
    const states = await db.query<{ state: string }>(`select state from document_page_states where page_number in (1,2)`);
    expect(states.rows.every((r) => r.state === "indexed")).toBe(true);
  });

  it("OCRs a low-text page exactly once and records page-analysis usage", async () => {
    const h = harness({ 1: LONG, 2: "  x \n" });
    const result = await claimAndMaterialize(h.deps, input(h, [1, 2]));
    expect(h.ocrCalls).toEqual([2]);
    expect(result.indexed).toEqual([1, 2]);
    const ledger = (h.usage as unknown as { pending: Array<{ metric: string; unit: string }> }).pending;
    expect(ledger.filter((e) => e.metric === "page-analysis" && e.unit === "page")).toHaveLength(1);
    // Customer credits: the OCR-read page bills Rich, the text-layer page Fast; provider cost is not billed.
    expect(result.costCredits).toBeCloseTo(0.25 + 0.005, 6);
  });

  it("never chunks or writes a PII-blocked page", async () => {
    const h = harness({ 1: LONG, 2: `${LONG} SSN 123-45-6789 is on file for this customer.` });
    const pipeline = {
      ...defaultPipelineFeatures,
      piiPolicy: { ...defaultPipelineFeatures.piiPolicy, enabled: true, patterns: ["ssn"], action: "block_indexing" as const, allowlistPatterns: [] },
    };
    const result = await claimAndMaterialize(h.deps, input(h, [1, 2], pipeline));
    expect(result.blocked).toEqual([2]);
    expect(result.indexed).toEqual([1]);
    const chunks = await db.query<{ page_number: number }>(`select page_number from document_chunks`);
    expect(chunks.rows.every((r) => r.page_number === 1)).toBe(true);
    expect(h.lanceWrites.flat().every((r) => r.id.startsWith("d1:p1:"))).toBe(true);
    expect(h.embedCalls.flat().join(" ")).not.toContain("123-45-6789");
    const state = await db.query<{ state: string }>(`select state from document_page_states where page_number = 2`);
    expect(state.rows[0]!.state).toBe("blocked-pii");
  });

  it("redacts page text when the policy redacts artifacts", async () => {
    const h = harness({ 1: `${LONG} SSN 123-45-6789 on file.` });
    const pipeline = {
      ...defaultPipelineFeatures,
      piiPolicy: { ...defaultPipelineFeatures.piiPolicy, enabled: true, patterns: ["ssn"], action: "redact_artifacts" as const, allowlistPatterns: [] },
    };
    const result = await claimAndMaterialize(h.deps, input(h, [1], pipeline));
    expect(result.indexed).toEqual([1]);
    expect(h.embedCalls.flat().join(" ")).not.toContain("123-45-6789");
  });

  it("is idempotent: re-running a range writes identical chunk ids without duplicates", async () => {
    const h = harness({ 3: LONG, 4: LONG + " more" });
    await claimAndMaterialize(h.deps, input(h, [3, 4]));
    const first = (await db.query<{ id: string }>(`select id from document_chunks order by id`)).rows.map((r) => r.id);
    // Only a run holding the pages publishes: hand them back to the ledger so the replay re-claims them.
    await db.exec(`update document_page_states set state = 'unseen' where document_id = 'd1' and page_number in (3, 4)`);
    await claimAndMaterialize(h.deps, input(h, [3, 4]));
    const second = (await db.query<{ id: string }>(`select id from document_chunks order by id`)).rows.map((r) => r.id);
    expect(second).toEqual(first);
    expect(first[0]).toMatch(/^d1:p3:c0$/);
    expect(h.lanceWrites[1]!.map((r) => r.id)).toEqual(h.lanceWrites[0]!.map((r) => r.id));
    const pages = await db.query(`select 1 from document_pages where document_id = 'd1'`);
    expect(pages.rows).toHaveLength(2);
  });

  it("upserts over the coarse text-layer row (one page-id scheme) instead of duplicating the page", async () => {
    const h = harness({ 2: LONG });
    const [d] = (await db.query<{ run_id: string; user_id: string }>(`select run_id, user_id from documents where id = 'd1'`)).rows;
    await db.exec(`insert into document_pages (id, document_id, run_id, user_id, page_number, text, token_estimate)
      values ('d1-page-0002', 'd1', '${d!.run_id}', '${d!.user_id}', 2, 'coarse raw text', 3)`);
    await claimAndMaterialize(h.deps, input(h, [2]));
    const pages = await db.query<{ id: string; text: string }>(`select id, text from document_pages where document_id = 'd1' and page_number = 2`);
    expect(pages.rows).toEqual([{ id: "d1-page-0002", text: LONG }]);
  });

  it("records one embedding usage event per batch with actual tokens", async () => {
    const h = harness({ 1: LONG, 2: LONG, 3: LONG });
    await claimAndMaterialize(h.deps, input(h, [1, 2, 3]));
    expect(h.embedCalls).toHaveLength(1);
    const events = (h.usage as unknown as { pending: Array<{ metric: string; inputTokens?: number }> }).pending
      .filter((e) => e.metric === "embedding-tokens");
    expect(events).toHaveLength(1);
    expect(events[0]!.inputTokens).toBe(111);
  });

  it("splits embedding into batches of at most 256 chunks", async () => {
    const big = Array.from({ length: 300 }, (_, i) => `# Section ${i}\n\n${LONG} ${i}`).join("\n\n");
    const h = harness({ 1: big });
    await claimAndMaterialize(h.deps, input(h, [1]));
    expect(h.embedCalls.length).toBeGreaterThan(1);
    expect(Math.max(...h.embedCalls.map((c) => c.length))).toBeLessThanOrEqual(256);
  });

  it("marks a page failed when OCR throws and keeps the others", async () => {
    const h = harness({ 1: LONG, 2: "" }, {
      async ocrPage() { throw new Error("vision down"); },
    });
    const result = await claimAndMaterialize(h.deps, input(h, [1, 2]));
    expect(result.indexed).toEqual([1]);
    expect(result.failed).toEqual([{ page: 2, reason: "vision down" }]);
    const state = await db.query<{ state: string; failure_reason: string }>(`select state, failure_reason from document_page_states where page_number = 2`);
    expect(state.rows[0]).toEqual({ state: "failed", failure_reason: "vision down" });
  });

  it("records the summed spend of a page rejected on every attempt in the usage ledger", async () => {
    const rejected = new VisionOutputRejectedError("rejected after 2 attempts", [], 2400, 640, 1.5);
    rejected.route = { model: "vision-x", provider: "openrouter" };
    const h = harness({ 1: LONG, 2: "" }, { async ocrPage() { throw rejected; } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await claimAndMaterialize(h.deps, input(h, [1, 2]));
    expect(result.failed).toEqual([{ page: 2, reason: "rejected after 2 attempts" }]);
    expect(result.costCredits).toBeLessThan(1.5); // the rejected page adds no customer charge; its provider spend stays in metadata
    const events = (h.usage as unknown as { pending: Array<{ metric: string; model: string; inputTokens: number; outputTokens: number; costCents: number; metadata: Record<string, unknown> }> }).pending;
    const event = events.find((e) => e.metric === "page-analysis-attempt");
    expect(event).toMatchObject({ model: "vision-x", inputTokens: 2400, outputTokens: 640, metadata: { outcome: "rejected", billable: false, documentId: "d1", pageNumber: 2 } });
    expect(event!.costCents).toBe(0);
    expect(event!.metadata?.providerCostCents).toBeGreaterThanOrEqual(1.5);
    expect(log.mock.calls.filter(([l]) => String(l).startsWith("[ai-usage]") && String(l).includes("model=vision-x"))).toHaveLength(1);
    log.mockRestore();
  });

  it("removes stale chunk rows when a page re-chunks to fewer chunks", async () => {
    const many = Array.from({ length: 4 }, (_, i) => `# Part ${i}\n\n${LONG} ${i}`).join("\n\n");
    const h = harness({ 1: many });
    await claimAndMaterialize(h.deps, input(h, [1]));
    const before = (await db.query<{ id: string }>(`select id from document_chunks order by id`)).rows.map((r) => r.id);
    expect(before.length).toBeGreaterThan(1);
    const h2 = harness({ 1: LONG });
    await db.exec(`update document_page_states set state = 'unseen' where document_id = 'd1' and page_number = 1`);
    await claimAndMaterialize(h2.deps, input(h2, [1]));
    const after = (await db.query<{ id: string }>(`select id from document_chunks order by id`)).rows.map((r) => r.id);
    expect(after).toEqual(["d1:p1:c0"]);
    expect(h2.lanceDeletes.sort()).toEqual(before.filter((id) => id !== "d1:p1:c0").sort());
  });

  it("reports total spend including failed pages and completed batches", async () => {
    const big = Array.from({ length: 300 }, (_, i) => `# Section ${i}\n\n${LONG} ${i}`).join("\n\n");
    let calls = 0;
    const h = harness({ 1: big, 2: "" , 3: ""}, {
      async ocrPage(_d, page) {
        if (page === 3) throw new Error("vision down");
        return { text: "", model: "v", inputTokens: 10, outputTokens: 1, costCents: 5 };
      },
      async embed(args) {
        calls += 1;
        await args.onRemoteUsage({ inputTokens: 50, chunks: args.chunks.length, costCents: 7 });
        if (calls === 2) throw new Error("embed down");
        return { vectors: args.chunks.map(() => [0.1]), totalTokens: 50 };
      },
    });
    const result = await claimAndMaterialize(h.deps, input(h, [1, 2, 3]));
    // page 2 OCR (empty -> failed) + two embedding batches; page 3 threw before indexing.
    const recorded = (h.usage as unknown as { pending: Array<{ metric: string; costCents: number }> }).pending;
    expect(recorded.filter((e) => e.metric === "embedding-tokens")).toHaveLength(2);
    expect(recorded.filter((e) => e.metric === "page-analysis")).toHaveLength(1);
    // Provider events bill 0; the OCR-read page bills one Rich page even though it then failed.
    expect(recorded.reduce((sum, e) => sum + e.costCents, 0)).toBe(0);
    expect(result.costCredits).toBeCloseTo(0.25, 6);
    expect(result.indexed).toEqual([]);
    expect(result.failed.map((f) => f.page)).toEqual([1, 2, 3]);
  });

  it("derives heading paths from the flat map node shape", async () => {
    await db.exec(`insert into document_maps (document_id, run_id, nodes, search_text) values ('d1', 'run-1',
      '[{"id":"a","title":"Part I","level":1,"parentId":null,"physicalStart":1,"physicalEnd":5},
        {"id":"b","title":"Chapter 2","level":2,"parentId":"a","physicalStart":3,"physicalEnd":4},
        {"id":"c","title":"Front","level":1,"parentId":null,"physicalStart":null,"physicalEnd":null}]'::jsonb, to_tsvector('x'))
      on conflict (document_id) do update set nodes = excluded.nodes`);
    const h = harness({ 3: LONG });
    await claimAndMaterialize(h.deps, input(h, [3]));
    const row = await db.query<{ heading_path: string[] }>(`select heading_path from document_chunks where id = 'd1:p3:c0'`);
    expect(row.rows[0]!.heading_path).toEqual(["Part I", "Chapter 2"]);
    await db.exec(`delete from document_maps`);
  });
});

describe("materializePageRange respects processing quality", () => {
  const fast = { ...defaultPipelineFeatures, quality: "fast" as const };
  const good = { ...defaultPipelineFeatures, quality: "good" as const };
  const reasons = ["query", "full-index"] as const;

  it.each(reasons)("fast (%s) indexes only the text layer and keeps textless pages unread", async (reason) => {
    const h = harness({ 1: LONG, 2: "" });
    const result = await claimAndMaterialize(h.deps, { ...input(h, [1, 2], fast), reason });
    expect(h.ocrCalls).toEqual([]);
    expect(result.indexed).toEqual([1]);
    expect(result.failed).toEqual([{ page: 2, reason: "kept-as-image" }]);
    const ledger = (h.usage as unknown as { pending: Array<{ metric: string }> }).pending;
    expect(ledger.filter((e) => e.metric === "page-analysis")).toEqual([]);
    // No Rich read: only the text-layer page's Fast credit (plus embedding provider cost, 0 credits here).
    expect(result.costCredits).toBeLessThan(0.25);
    const state = await db.query<{ state: string; failure_reason: string | null }>(
      `select state, failure_reason from document_page_states where document_id = 'd1' and page_number = 2`);
    expect(state.rows[0]).toEqual({ state: "failed", failure_reason: "kept-as-image" });
  });

  it.each(reasons)("good (%s) reads every page with vision, text layer or not", async (reason) => {
    const h = harness({ 1: LONG, 2: "" });
    const result = await claimAndMaterialize(h.deps, { ...input(h, [1, 2], good), reason });
    expect(h.ocrCalls.sort()).toEqual([1, 2]);
    expect(result.indexed).toEqual([1, 2]);
    expect(result.costCredits).toBeCloseTo(0.5, 6);
  });
});
