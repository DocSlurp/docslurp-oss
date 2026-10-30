import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres, { type Sql } from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { embedPageImages, PAGE_EMBED_WINDOW, PageEmbedStage, withinCostCap } from "../stages/page-embed.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import type { Document } from "../models.js";
import type { PageImageEmbedder } from "../deferred/page-image-embedders.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;

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
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`delete from document_page_vectors; delete from document_page_states`);
});

const DIMS = 768;
const document = { id: "d1", userId: "u1", runId: "run-1", filename: "a.pdf", mimeType: "application/pdf", pageCount: 6 } as Document;
const run = { id: "run-1", orgId: "o1", workspaceId: "w" };

function fixture() {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  const renderCalls: number[][] = [];
  const png = sharp({ create: { width: 2000, height: 3000, channels: 3, background: "#336699" } }).png().toBuffer();
  const rasters = {
    renderSelectedPages: vi.fn(async (args: { pageNumbers: number[] }) => {
      renderCalls.push(args.pageNumbers);
      const bytes = await png;
      return args.pageNumbers.map((pageNumber) => {
        const artifactKey = `r/page-${pageNumber}.png`;
        objects.set(artifactKey, bytes);
        return { pageNumber, artifactKey, artifactUri: `s3://b/${artifactKey}`, widthPx: 2000, heightPx: 3000, sizeBytes: bytes.length, cacheHit: false, mimeType: "image/png" };
      });
    }),
  };
  const storage = {
    getBytes: async (key: string) => objects.get(key)!,
    deleteKeys: async (keys: string[]) => { for (const k of keys) { deleted.push(k); objects.delete(k); } },
  };
  const jpegs: Uint8Array[] = [];
  const embedder: PageImageEmbedder = {
    provider: "test",
    model: "test-embed",
    estimatedCostCentsPerPage: 0.5,
    dims: DIMS,
    async embedImages(images) {
      jpegs.push(...images.map((i) => i.jpeg));
      return {
        vectors: images.map((_, n) => Float32Array.from({ length: DIMS }, (_v, i) => Math.sin(i * (n + 1)) - 0.1)),
        inputTokens: images.length * 258,
        costCents: images.length * 0.5,
      };
    },
  };
  return { objects, deleted, renderCalls, rasters, storage, embedder, jpegs };
}

describe("embedPageImages", () => {
  it("stores bits/int8 per page, marks the ledger, records usage and removes rasters", async () => {
    const f = fixture();
    const usage = new PipelineUsageEventLedger();
    usage.runId = "run-1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await embedPageImages(
      { sql, rasters: f.rasters, storage: f.storage, embedder: f.embedder, usage },
      { document, pages: [1, 2, 3, 4, 5, 6], run, windowSize: 4 },
    );
    log.mockRestore();
    expect(result.embeddedPages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(f.renderCalls).toEqual([[1, 2, 3, 4], [5, 6]]);

    const rows = await db.query<{ page_number: number; dims: number; bl: number; il: number; scale: number; workspace_id: string; org_id: string }>(
      `select page_number, dims, length(bits) as bl, length(int8) as il, scale, workspace_id, org_id from document_page_vectors order by page_number`,
    );
    expect(rows.rows).toHaveLength(6);
    for (const row of rows.rows) {
      expect(row.dims).toBe(DIMS);
      expect(row.bl).toBe(DIMS / 8);
      expect(row.il).toBe(DIMS);
      expect(row.scale).toBeGreaterThan(0);
      expect([row.workspace_id, row.org_id]).toEqual(["w", "o1"]);
    }
    const states = await db.query<{ embedded_at: unknown; embedding_model: string }>(`select embedded_at, embedding_model from document_page_states`);
    expect(states.rows).toHaveLength(6);
    expect(states.rows.every((s) => s.embedded_at && s.embedding_model === "test-embed")).toBe(true);

    const events = usage.snapshot();
    const embedEvents = events.filter((e) => e.metric === "page-image-embedding");
    expect(embedEvents.map((e) => e.inputTokens)).toEqual([4 * 258, 2 * 258]);
    // Each page embedded as an image bills one Rich page; the embedding tokens bill nothing.
    const rich = events.filter((e) => e.metric === "ingest-page-rich");
    expect(rich).toHaveLength(6);
    expect(rich.reduce((n, e) => n + e.costCents, 0)).toBeCloseTo(6 * 0.25, 10);
    expect(embedEvents.every((e) => e.costCents === 0)).toBe(true);
    // Spend is read from the ledger (and the run's trigger-maintained spent_cents), not a per-run counter.
    expect(usage.pendingBillableCents).toBeGreaterThan(0);

    expect(f.objects.size).toBe(0);
    expect(f.deleted).toHaveLength(6);
    // 2000x3000 raster was downscaled to a 1024 long edge JPEG.
    const meta = await sharp(f.jpegs[0]!).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBe(1024);
  });

  it("never upscales small rasters and upserts idempotently", async () => {
    const f = fixture();
    const small = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#fff" } }).png().toBuffer();
    f.rasters.renderSelectedPages.mockImplementation(async (args: { pageNumbers: number[] }) =>
      args.pageNumbers.map((pageNumber) => {
        f.objects.set(`s/${pageNumber}`, small);
        return { pageNumber, artifactKey: `s/${pageNumber}`, artifactUri: "", widthPx: 300, heightPx: 400, sizeBytes: 1, cacheHit: false, mimeType: "image/png" };
      }),
    );
    const deps = { sql, rasters: f.rasters, storage: f.storage, embedder: f.embedder, usage: new PipelineUsageEventLedger() };
    await embedPageImages(deps, { document, pages: [1], run });
    await embedPageImages(deps, { document, pages: [1], run });
    const meta = await sharp(f.jpegs[0]!).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
    const count = await db.query<{ n: number }>(`select count(*)::int as n from document_page_vectors`);
    expect(count.rows[0]!.n).toBe(1);
  });

  it("does not delete cached rasters owned by other stages", async () => {
    const f = fixture();
    const base = f.rasters.renderSelectedPages;
    f.rasters.renderSelectedPages = vi.fn(async (args: { pageNumbers: number[] }) =>
      (await base(args)).map((r) => ({ ...r, cacheHit: true })),
    );
    await embedPageImages(
      { sql, rasters: f.rasters, storage: f.storage, embedder: f.embedder, usage: new PipelineUsageEventLedger() },
      { document, pages: [1, 2], run },
    );
    expect(f.deleted).toEqual([]);
  });

  it("stops before the first embed when the estimated window cost exceeds the cap", async () => {
    const f = fixture();
    const spy = vi.spyOn(f.embedder, "embedImages");
    const result = await embedPageImages(
      { sql, rasters: f.rasters, storage: f.storage, embedder: f.embedder, usage: new PipelineUsageEventLedger() },
      { document, pages: [1, 2, 3, 4], run, windowSize: 4, canAfford: (cents) => cents <= 0.5 },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(f.renderCalls).toEqual([]);
    expect(result).toMatchObject({ embeddedPages: [], stoppedBy: "cost-cap" });
  });

  it("stops cleanly between windows, keeping finished pages and cleaning up the prefetched render", async () => {
    const f = fixture();
    let allowed = 1;
    const result = await embedPageImages(
      { sql, rasters: f.rasters, storage: f.storage, embedder: f.embedder, usage: new PipelineUsageEventLedger() },
      { document, pages: [1, 2, 3, 4, 5, 6], run, windowSize: 2, canAfford: () => allowed-- > 0 },
    );
    expect(result.embeddedPages).toEqual([1, 2]);
    expect(result.stoppedBy).toBe("cost-cap");
    const n = await db.query<{ n: number }>(`select count(*)::int as n from document_page_vectors`);
    expect(n.rows[0]!.n).toBe(2);
    expect(f.objects.size).toBe(0);
  });

  it("refuses under quality fast: nothing rendered, embedded or charged (M3 backstop)", async () => {
    const f = fixture();
    const spy = vi.spyOn(f.embedder, "embedImages");
    const usage = new PipelineUsageEventLedger();
    usage.runId = "run-fast";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await embedPageImages(
      { sql, rasters: f.rasters, storage: f.storage, embedder: f.embedder, usage },
      { document, pages: [1, 2, 3], run: { ...run, pipeline: { quality: "fast" } } },
    );
    expect(result).toMatchObject({ embeddedPages: [], stoppedBy: "quality-fast" });
    expect(spy).not.toHaveBeenCalled();
    expect(f.renderCalls).toEqual([]);
    expect(usage.pendingCount).toBe(0);
    expect(usage.pendingBillableCents).toBe(0);

    // The stage skips every document under Fast before resolving an embedder.
    const stage = new PageEmbedStage(f.rasters as never, f.storage as never, () => sql, f.embedder);
    const state = { run: { id: "run-fast", pipeline: { quality: "fast", indexingMode: "visual" } }, documents: [document], usageLedger: usage } as never;
    await stage.run(state);
    expect(spy).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("withinCostCap blocks on estimated spend and ignores unset caps", () => {
    const state = (cap: number | null, spent = 0) => ({ run: { spentCents: spent, pipeline: { maxCostCents: cap } }, usageLedger: { pendingBillableCents: 0 } }) as any;
    expect(withinCostCap(state(null), 999)).toBe(true);
    expect(withinCostCap(state(5, 4), 2)).toBe(false);
    expect(withinCostCap(state(5, 4), 1)).toBe(true);
  });

  it("uses a window of 16 by default", () => {
    expect(PAGE_EMBED_WINDOW).toBe(16);
  });
});
