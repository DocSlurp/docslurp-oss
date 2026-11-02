import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { connect } from "@lancedb/lancedb";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Sql } from "postgres";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { claimPages, ensurePageRows } from "../deferred/page-ledger.js";
import { materializePageRange, type PageMaterializerDeps, type PageMaterializerOps } from "../deferred/materialize-pages.js";
import { Store } from "../db/store.js";
import type { Document } from "../models.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { deleteLanceDbRecords, writeLanceDbRecords } from "../stages/lancedb-writer.js";
import { attachVisionServedRoute } from "../lib/vision-pricing.js";
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
      values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1),
             ('run-2', 'o1', 'u1', 'w', 'materialize', 'processing', 'materialize', '{}', 1);
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
  // As WorkflowState sets it: Rich page charges need the run id.
  usage.runId = "run-1";
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
    async ocrPage(_doc, page, ctx) {
      await ctx.gate.admit();
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

const orphanQueue = async () => (await db.query<{ ids: string[] }>(
  `select array(select jsonb_array_elements_text(payload -> 'ids') order by 1) as ids from storage_cleanup_queue where kind = 'vector_rows' order by id`)).rows.map((r) => r.ids);

beforeEach(async () => {
  await db.exec(`delete from document_chunks; delete from document_pages; delete from document_page_states; delete from usage_events; delete from storage_cleanup_queue; delete from vision_run_attempts; delete from vision_org_attempts; delete from vision_admission_tickets; delete from vision_route_overruns;`);
  await ensurePageRows(sql, "d1", 6);
});

describe("materializePageRange", () => {
  it.each([false, true])("bills materialized pages from the immutable run boost snapshot (%s), once", async speedBoost => {
    const runId = `materialized-boost-${speedBoost}`;
    await sql`insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
      values (${runId}, 'o1', 'u1', 'w', 'materialize', 'processing', 'materialize', ${sql.json({ speedBoost })})`;
    const h = harness({ 1: LONG, 2: "" });
    h.run.id = runId;
    h.usage.runId = runId;
    const range = { ...input(h, [1, 2], { ...defaultPipelineFeatures, speedBoost }), runId };
    const first = await claimAndMaterialize(h.deps, range);
    expect(first.costCredits).toBeCloseTo((0.005 + 0.25) * (speedBoost ? 4 : 1), 6);
    const firstRows = await sql`select id, cost_cents, metadata from usage_events where run_id = ${runId}`;
    const billed = firstRows.reduce((sum, row) => sum + Number(row.cost_cents), 0);
    expect(billed).toBeCloseTo(first.costCredits, 6);
    await claimAndMaterialize(h.deps, range);
    const repeated = await sql`select id, cost_cents from usage_events where run_id = ${runId}`;
    expect(repeated.reduce((sum, row) => sum + Number(row.cost_cents), 0)).toBeCloseTo(billed, 6);
    // Provider usage stays in the pipeline ledger and retains actual dollars.
    const usage = h.usage.checkpoint();
    const provider = usage.events.find(event => event.metric === "page-analysis");
    expect(provider?.costCents).toBe(0);
    expect(provider?.metadata?.providerCostCents).toBe(2);
    expect(provider?.inputTokens).toBe(1000);
    expect(provider?.outputTokens).toBe(200);
  });

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

  it("re-running a range republishes the pages under a new id generation, without duplicates", async () => {
    const h = harness({ 3: LONG, 4: LONG + " more" });
    await claimAndMaterialize(h.deps, input(h, [3, 4]));
    const first = (await db.query<{ id: string }>(`select id from document_chunks order by id`)).rows.map((r) => r.id);
    // Only a run holding the pages publishes: hand them back to the ledger so the replay re-claims them.
    await db.exec(`update document_page_states set state = 'unseen' where document_id = 'd1' and page_number in (3, 4)`);
    await claimAndMaterialize(h.deps, input(h, [3, 4]));
    const second = (await db.query<{ id: string }>(`select id from document_chunks order by id`)).rows.map((r) => r.id);
    expect(second).toHaveLength(first.length);
    expect(first[0]).toMatch(/^d1:p3:g[0-9a-f]{12}:c0$/);
    expect(second.some((id) => first.includes(id))).toBe(false);
    expect(h.lanceWrites[1]!.map((r) => r.id).sort()).toEqual(second);
    // The first generation's vectors are stale once the second commits.
    expect(h.lanceDeletes.sort()).toEqual(first);
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
    attachVisionServedRoute(rejected, { runtime: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", provider: "openrouter", model: "vision-x", billing: "openrouter" });
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

  it("refuses OCR once the org's uncharged vision attempts reach the limit, releasing the page for later", async () => {
    // Earlier runs of this org already left the limit's worth of uncharged vision requests.
    vi.stubEnv("VISION_ORG_UNCHARGED_LIMIT_CENTS", "3");
    await db.exec(`insert into vision_org_attempts (id, org_id, weight_cents, settled) values ('a1', 'o1', 1, true), ('a2', 'o1', 1, true), ('a3', 'o1', 1, true)`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({ 1: LONG, 2: "" });
      const result = await claimAndMaterialize(h.deps, input(h, [1, 2]));
      expect(h.ocrCalls).toEqual([]);
      expect(result.indexed).toEqual([1]);
      expect(result.failed).toEqual([{ page: 2, reason: "vision-stopped:org-attempt-limit" }]);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
      await db.exec(`delete from vision_org_attempts`);
    }
  });

  it("a failed vector write fails the pages, publishes no chunk and deletes any partial vector write", async () => {
    const h = harness({ 1: LONG, 2: LONG + " second" }, {
      async writeVectors() { throw new Error("lance unavailable"); },
      async deleteVectors(_uri, _table, ids) { h.lanceDeletes.push(...ids); },
    });
    const result = await claimAndMaterialize(h.deps, input(h, [1, 2]));
    expect(result.indexed).toEqual([]);
    expect(result.failed).toEqual([{ page: 1, reason: "lance unavailable" }, { page: 2, reason: "lance unavailable" }]);
    expect((await db.query(`select 1 from document_chunks where document_id = 'd1'`)).rows).toHaveLength(0);
    expect((await db.query(`select 1 from document_pages where document_id = 'd1'`)).rows).toHaveLength(0);
    expect(h.lanceDeletes).toHaveLength(2);
    expect(h.lanceDeletes.sort()).toEqual([expect.stringMatching(/^d1:p1:g[0-9a-f]{12}:c0$/), expect.stringMatching(/^d1:p2:g[0-9a-f]{12}:c0$/)]);
    const states = await db.query<{ state: string }>(`select state from document_page_states where document_id = 'd1' and page_number in (1, 2)`);
    expect(states.rows.map((r) => r.state)).toEqual(["failed", "failed"]);
  });

  describe("vector ids are generation-specific (round 7 M1, L3, L2)", () => {
    let root: string;
    beforeEach(async () => { root = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "materialize-generation-")); });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });
    const onLance = (h: Harness, overrides: Partial<PageMaterializerOps>) => {
      h.deps = { ...h.deps, config: { ...h.deps.config, lancedb: { ...h.deps.config.lancedb, root } } as Config, ops: { ...h.deps.ops, ...overrides } };
      return h;
    };
    const lanceIds = async (uri: string, table: string) => {
      const db = await connect(uri);
      const t = await db.openTable(table);
      try {
        return new Set((await t.query().select(["id"]).toArray() as Array<{ id: string }>).map((row) => row.id));
      } finally {
        t.close();
        db.close();
      }
    };
    const page1Chunks = async () => (await db.query<{ id: string }>(`select id from document_chunks where document_id = 'd1' and page_number = 1 order by id`)).rows.map((r) => r.id);

    it("a failed write's late cleanup never deletes the vectors a retry republished (real LanceDB)", async () => {
      let target: { uri: string; table: string } | null = null;
      const winner = onLance(harness({ 1: LONG }), {
        async writeVectors(uri, table, records) { target = { uri, table }; await writeLanceDbRecords(uri, table, records); },
        async deleteVectors(uri, table, ids) { await deleteLanceDbRecords(uri, table, ids); },
      });
      const loser = onLance(harness({ 1: LONG }), {
        // The write landed but its acknowledgement did not: the page commits as failed and releases the lock.
        async writeVectors(uri, table, records) { await writeLanceDbRecords(uri, table, records); throw new Error("lance commit lost"); },
        async deleteVectors(uri, table, ids) {
          // The cleanup runs late: run-2 has claimed and republished the page in between.
          const retried = await claimAndMaterialize(winner.deps, { ...input(winner, [1]), runId: "run-2" });
          expect(retried.indexed).toEqual([1]);
          await deleteLanceDbRecords(uri, table, ids);
        },
      });
      const failed = await claimAndMaterialize(loser.deps, input(loser, [1]));
      expect(failed.failed).toEqual([{ page: 1, reason: "lance commit lost" }]);
      const live = await page1Chunks();
      expect(live.length).toBeGreaterThan(0);
      const stored = await lanceIds(target!.uri, target!.table);
      expect(live.every((id) => stored.has(id))).toBe(true);
      const state = await db.query<{ state: string }>(`select state from document_page_states where document_id = 'd1' and page_number = 1`);
      expect(state.rows[0]!.state).toBe("indexed");
    });

    it("an unknown COMMIT outcome (connection lost after COMMIT) keeps the published vectors", async () => {
      const h = harness({ 1: LONG });
      const real = h.deps.sql;
      h.deps = { ...h.deps, sql: new Proxy(real, {
        get(target, key, receiver) {
          if (key !== "begin") return Reflect.get(target, key, receiver);
          return async (...args: unknown[]) => {
            await (target.begin as (...a: unknown[]) => Promise<unknown>)(...args);
            throw new Error("write CONNECTION_CLOSED");
          };
        },
      }) };
      await expect(claimAndMaterialize(h.deps, input(h, [1]))).rejects.toThrow(/CONNECTION_CLOSED/);
      const live = await page1Chunks();
      expect(live.length).toBeGreaterThan(0);
      expect(h.lanceWrites.flat().map((r) => r.id).sort()).toEqual(live);
      expect(h.lanceDeletes).toEqual([]);
      const state = await db.query<{ state: string }>(`select state from document_page_states where document_id = 'd1' and page_number = 1`);
      expect(state.rows[0]!.state).toBe("indexed");
      // The kept ids go to the orphan sweep, which deletes only those no committed chunk row names (round 8 L3).
      expect(await orphanQueue()).toEqual([live]);
    });

    it("materializer vector records carry no LanceDB hydration, so search serves them only through a committed chunk row", async () => {
      const records: Array<Record<string, unknown>> = [];
      const h = harness({ 1: LONG, 2: LONG + " second" }, {
        async writeVectors(_uri, _table, written) { records.push(...(written as unknown as Array<Record<string, unknown>>)); },
      });
      await claimAndMaterialize(h.deps, input(h, [1, 2]));
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(record).not.toHaveProperty("hydration");
        expect(record).not.toHaveProperty("runId");
        expect(record).not.toHaveProperty("pageNumber");
      }
    });
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
    expect(after).toEqual([expect.stringMatching(/^d1:p1:g[0-9a-f]{12}:c0$/)]);
    // Every chunk of the earlier generation is stale.
    expect(h2.lanceDeletes.sort()).toEqual(before);
    expect(await orphanQueue()).toEqual([]);
  });

  it("queues stale vectors whose delete fails for the orphan sweep (round 8 L3)", async () => {
    const many = Array.from({ length: 3 }, (_, i) => `# Part ${i}\n\n${LONG} ${i}`).join("\n\n");
    const h = harness({ 1: many });
    await claimAndMaterialize(h.deps, input(h, [1]));
    const before = (await db.query<{ id: string }>(`select id from document_chunks order by id`)).rows.map((r) => r.id);
    const h2 = harness({ 1: LONG }, { async deleteVectors() { throw new Error("lance unavailable"); } });
    await db.exec(`update document_page_states set state = 'unseen' where document_id = 'd1' and page_number = 1`);
    expect((await claimAndMaterialize(h2.deps, input(h2, [1]))).indexed).toEqual([1]);
    expect(await orphanQueue()).toEqual([before]);
    const [row] = (await db.query<{ org_id: string; payload: Record<string, unknown>; due: boolean }>(
      `select org_id, payload, not_before > now() as due from storage_cleanup_queue where kind = 'vector_rows'`)).rows;
    expect(row).toMatchObject({ org_id: "o1", due: true, payload: { workspaceId: "w", documentId: "d1", dimension: 3 } });
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
    const row = await db.query<{ heading_path: string[] }>(`select heading_path from document_chunks where document_id = 'd1' and page_number = 3 order by chunk_index limit 1`);
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
    // Query: two committed Rich charges. Full index: the run completion fee bills the pages, so the call reports none.
    expect(result.costCredits).toBeCloseTo(reason === "query" ? 0.5 : 0, 6);
  });
});
