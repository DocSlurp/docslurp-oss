import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Sql } from "postgres";
import { defaultPipelineFeatures, pageCredits } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { billLockedMaterializedPages, lockPageRows, recordMaterializedPageFee, recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { completeMaterializeRun, runMaterializeRange } from "../deferred/materialize-activity.js";
import { claimPages, ensurePageRows, markPages } from "../deferred/page-ledger.js";
import type { PageMaterializerOps } from "../deferred/materialize-pages.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { coerceIndexingModeForFlag } from "../pipeline/stage-execution.js";
import { markPagesIngested, markPagesIngestedIfDeferred } from "../stages/page-index.js";
import { mergeMaterializeResults, splitMaterializeRanges } from "../temporal/materialize-ranges.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: Sql;

const LONG = "Quarterly revenue grew steadily across every region this period, driven by subscription renewals and new enterprise contracts.";

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('up', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{"indexingMode":"map"}', 2),
             ('m1', 'o1', 'u1', 'w', 'materialize', 'processing', 'materialize', '{}', 1),
             ('m2', 'o1', 'u1', 'w', 'materialize', 'processing', 'materialize', '{}', 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, indexing_mode)
      values ('full', 'o1', 'u1', 'w', 'up', 'a.pdf', 'application/pdf', 'k1', 'processing', 3, 'full'),
             ('mapped', 'o1', 'u1', 'w', 'up', 'b.pdf', 'application/pdf', 'k2', 'processing', 5, 'map'),
             ('d1', 'o1', 'u1', 'w', 'up', 'c.pdf', 'application/pdf', 'k3', 'processing', 12, 'map');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  sql = (store as unknown as { sql: Sql }).sql;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("splitMaterializeRanges", () => {
  it("splits [3,4,5,9] into two contiguous ranges", () => {
    expect(splitMaterializeRanges([9, 3, 5, 4, 4])).toEqual([[3, 4, 5], [9]]);
  });
  it("caps range length and drops invalid pages", () => {
    expect(splitMaterializeRanges([0, -1, 1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("merges range results in page order", () => {
    const merged = mergeMaterializeResults([
      { indexed: [9], blocked: [], failed: [], costCredits: 1 },
      { indexed: [3], blocked: [4], failed: [{ page: 5, reason: "x" }], costCredits: 2 },
    ]);
    expect(merged).toEqual({ indexed: [3, 9], blocked: [4], failed: [{ page: 5, reason: "x" }], costCredits: 3 });
  });
});

describe("page charges", () => {
  afterEach(() => { delete process.env.DOCSLURP_DEFERRED_PROFILES; });
  const fast = (pages: number) => (pages * 5) / 1000;

  it("upload runs charge every document's pages as Fast when the flag is off", async () => {
    delete process.env.DOCSLURP_DEFERRED_PROFILES;
    await db.exec(`delete from usage_events where run_id = 'up'`);
    const charges = await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("up"), []));
    expect(charges).toMatchObject({ fastPages: 20, richPages: 0 });
    const rows = await db.query<{ id: string; metric: string; amount: number; cost_cents: number }>(`select id, metric, amount, cost_cents from usage_events where run_id = 'up'`);
    expect(rows.rows.map((r) => [r.id, r.metric, Number(r.amount)])).toEqual([["fast:up", "ingest-page-fast", 20]]);
    expect(Number(rows.rows[0]!.cost_cents)).toBeCloseTo(fast(20), 9);
  });

  it("upload runs charge only full-mode documents when the flag is on", async () => {
    process.env.DOCSLURP_DEFERRED_PROFILES = "1";
    await db.exec(`delete from usage_events where run_id = 'up'`);
    const state = WorkflowState.create(await store.loadRun("up"), []);
    await recordPageBaseFee(sql, state);
    const rows = await db.query<{ amount: number }>(`select amount from usage_events where run_id = 'up'`);
    expect(rows.rows.map((r) => Number(r.amount))).toEqual([3]);
  });

  it("charges pages a vision model read as Rich (once) and the rest Fast, scans and images Rich", async () => {
    delete process.env.DOCSLURP_DEFERRED_PROFILES;
    await db.exec(`
      delete from usage_events where run_id = 'up';
      insert into usage_events (id, user_id, run_id, org_id, workspace_id, provider, model, metric, amount, unit, cost_cents, metadata)
        values ('rich:up:full:1', 'u1', 'up', 'o1', 'w', 'docslurp', 'price-card', 'ingest-page-rich', 1, 'page', 0.25, '{"documentId":"full","pageNumber":1}');
      insert into document_page_facts (document_id, page_number, text_bytes, image_count) values ('mapped', 1, 0, 1), ('mapped', 2, 0, 2);
    `);
    const charges = await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("up"), []));
    // full: 3 pages, 1 read by vision; mapped: 5 pages, 2 scans; d1: 12 text pages.
    expect(charges).toMatchObject({ fastPages: 2 + 3 + 12, richPages: 2 });
    expect(charges.credits).toBeCloseTo(fast(17) + 2 * 0.25, 9);
    await db.exec(`delete from document_page_facts where document_id = 'mapped'; update documents set mime_type = 'image/png' where id = 'full'`);
    await db.exec(`delete from usage_events where run_id = 'up' and id <> 'rich:up:full:1'`);
    const image = await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("up"), []));
    // An image file's pages are read as images: the 2 not yet charged bill Rich.
    expect(image).toMatchObject({ fastPages: 17, richPages: 2 });
    await db.exec(`update documents set mime_type = 'application/pdf' where id = 'full'; delete from usage_events where run_id = 'up'`);
  });

  it("charges each materialized page once per run as Fast, skipping pages OCR already charged Rich", async () => {
    expect(await recordMaterializedPageFee(sql, "m1", "d1", [3, 4, 5])).toBeCloseTo(fast(3), 9);
    expect(await recordMaterializedPageFee(sql, "m1", "d1", [4, 5, 6])).toBeCloseTo(fast(1), 9);
    // Pages with a Rich read recorded for the run are stamped without a Fast charge.
    await db.exec(`insert into usage_events (id, user_id, run_id, org_id, workspace_id, provider, model, metric, amount, unit, cost_cents, metadata)
      values ('rich:m1:d1:10', 'u1', 'm1', 'o1', 'w', 'docslurp', 'price-card', 'ingest-page-rich', 1, 'page', 0, '{"documentId":"d1","pageNumber":10}'),
             ('rich:m1:d1:11', 'u1', 'm1', 'o1', 'w', 'docslurp', 'price-card', 'ingest-page-rich', 1, 'page', 0, '{"documentId":"d1","pageNumber":11}')`);
    expect(await recordMaterializedPageFee(sql, "m1", "d1", [10, 11])).toBe(0);
    await db.exec(`delete from usage_events where id in ('rich:m1:d1:10', 'rich:m1:d1:11')`);
    const rows = await db.query<{ id: string }>(`select id from usage_events where run_id = 'm1' order by id`);
    expect(rows.rows.map((r) => r.id)).toEqual(["m1:d1:3", "m1:d1:4", "m1:d1:5", "m1:d1:6"]);
    const [run] = (await db.query<{ spent_cents: string }>(`select spent_cents from workspace_runs where id = 'm1'`)).rows;
    expect(Number(run!.spent_cents)).toBeCloseTo(fast(4), 9);
  });

  it("never bills a page twice when another run bills it between this run's read and write", async () => {
    await ensurePageRows(sql, "d1", 12);
    await db.exec(`delete from usage_events where metric = 'ingest-page-fast' and run_id in ('m1','m2'); update document_page_states set fee_billed_run = null, fee_billed_at = null where document_id = 'd1'`);
    let competitor: Promise<number> | null = null;
    // Simulates run m2 getting in just before m1 reads its run row (after m1's page-state work): both run
    // inside one transaction here, standing in for the row locks that serialize them in Postgres.
    const total = await sql.begin(async (tx) => {
      const call = (strings: TemplateStringsArray, ...values: unknown[]) => (tx as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...values);
      const proxy: Sql = new Proxy(tx as unknown as Sql, {
        apply: (_target, _this, args: [TemplateStringsArray, ...unknown[]]) => {
          if (!competitor && args[0].join("?").includes("select r.id, coalesce(r.org_id")) {
            competitor = recordMaterializedPageFee({ begin: (fn: (t: unknown) => unknown) => fn(proxy) } as unknown as Sql, "m2", "d1", [7, 8]);
            return competitor.then(() => call(...args));
          }
          return call(...args);
        },
      });
      return await recordMaterializedPageFee({ begin: (fn: (t: unknown) => unknown) => fn(proxy) } as unknown as Sql, "m1", "d1", [7, 8, 9]);
    });
    expect(competitor).not.toBeNull();
    const billed = await db.query<{ page: number; n: number }>(
      `select (metadata->>'page')::int as page, count(*)::int as n from usage_events where metric = 'ingest-page-fast' and run_id in ('m1','m2') group by 1 order by 1`);
    expect(billed.rows).toEqual([{ page: 7, n: 1 }, { page: 8, n: 1 }, { page: 9, n: 1 }]);
    expect(total + (await competitor!)).toBeCloseTo(fast(3), 9);
  });
});

describe("worker run load (round 4 M2)", () => {
  it("loads a run whose stored pipeline has extractor settings the strict schemas reject, with every rejected path gone", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      await db.exec(`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('stale-x', 'o1', 'u1', 'w', 'upload', 'processing', 'extract',
          '{"quality":"fast","documentExtraction":{"options":{"dolphin":{"mode":"page","repoPath":"/tmp/attacker"},"liteparse":{}},"ocr":{"language":"en"}}}', 1)`);
      const run = await store.loadRun("stale-x");
      expect(run.pipeline.quality).toBe("fast");
      expect(run.pipeline.documentExtraction.options).toEqual({ dolphin: { mode: "page" } });
      expect(run.pipeline.documentExtraction.ocr.language).toBe("eng");
      expect(JSON.stringify(run.pipeline)).not.toContain("/tmp/attacker");
      expect(errors.join("\n")).toMatch(/run stale-x.*documentExtraction\.options\.dolphin\.repoPath/);
    } finally {
      console.error = original;
      await db.exec(`delete from workspace_runs where id = 'stale-x'`);
    }
  });
});

describe("flag coercion", () => {
  it("runs map/visual pipelines as full when the flag is off", () => {
    const run = { pipeline: { ...defaultPipelineFeatures, indexingMode: "map" as const } };
    expect(coerceIndexingModeForFlag({ ...run }, false).pipeline.indexingMode).toBe("full");
    expect(coerceIndexingModeForFlag({ ...run }, true).pipeline.indexingMode).toBe("map");
  });
});

describe("worker run start", () => {
  it("coerces a stored map pipeline to full when the flag is off", async () => {
    delete process.env.DOCSLURP_DEFERRED_PROFILES;
    await db.exec(`update workspace_runs set pipeline = '{"indexingMode":"map"}'::jsonb where id = 'up'`);
    let seen: string | undefined;
    const fake = {
      loadRun: (id: string) => store.loadRun(id),
      loadDocumentsForRun: async () => [],
      hydrateState: async (st: WorkflowState) => { seen = (st.run.pipeline as { indexingMode?: string }).indexingMode; },
      seedReusedStageOutputs: async () => ({ unavailable: [], seededDocuments: 0 }),
      updateProgress: async () => {},
      appendEvent: async () => {},
    };
    const exec = createStageExecution({ store: fake as never, stages: [], config: { workerDocConcurrency: 1 } as never });
    await exec.startRun({ runId: "up", totalStages: 1 } as never);
    expect(seen).toBe("full");
    await db.exec(`update workspace_runs set pipeline = '{"indexingMode":"map"}'::jsonb where id = 'up'`);
  });
});

describe("page-index ledger hook", () => {
  it("does not clobber blocked-pii pages or live claims, and labels full-index runs", async () => {
    await db.exec(`delete from document_page_states where document_id = 'mapped'`);
    await ensurePageRows(sql, "mapped", 4);
    await db.exec(`
      update document_page_states set state = 'blocked-pii' where document_id = 'mapped' and page_number = 1;
      update document_page_states set state = 'claimed', claimed_by_run = 'm2', claim_expires_at = now() + interval '5 minutes' where document_id = 'mapped' and page_number = 2;
      update document_page_states set state = 'claimed', claimed_by_run = 'm2', claim_expires_at = now() - interval '1 minute' where document_id = 'mapped' and page_number = 3;`);
    await markPagesIngested(sql, "mapped", 4, "full-index");
    const rows = await db.query<{ page_number: number; state: string; materialized_by: string | null }>(
      `select page_number, state, materialized_by from document_page_states where document_id = 'mapped' order by page_number`);
    expect(rows.rows.map((r) => r.state)).toEqual(["blocked-pii", "claimed", "indexed", "indexed"]);
    expect(rows.rows[3]!.materialized_by).toBe("full-index");
  });

  it("writes ledger rows only for deferred documents (I8)", async () => {
    await db.exec(`delete from document_page_states where document_id in ('full','mapped')`);
    expect(await markPagesIngestedIfDeferred(sql, "full", 3)).toBe(false);
    expect(await markPagesIngestedIfDeferred(sql, "mapped", 5)).toBe(true);
    const rows = await db.query<{ document_id: string; n: number }>(`select document_id, count(*)::int as n from document_page_states where document_id in ('full','mapped') group by 1`);
    expect(rows.rows).toEqual([{ document_id: "mapped", n: 5 }]);
  });

  it("marks ingested pages indexed with materialized_by ingest", async () => {
    await markPagesIngested(sql, "full", 3);
    const rows = await db.query<{ state: string; materialized_by: string }>(`select state, materialized_by from document_page_states where document_id = 'full'`);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((r) => r.state === "indexed" && r.materialized_by === "ingest")).toBe(true);
    const embedded = await db.query<{ n: number }>(`select count(embedded_at)::int as n from document_page_states where document_id = 'full'`);
    expect(embedded.rows[0]!.n).toBe(0);
  });
});

describe("runMaterializeRange activity", () => {
  const ops: Partial<PageMaterializerOps> = {
    async extractText(_d, range) { return Array.from({ length: range.last - range.first + 1 }, () => LONG); },
    async embed(args) { return { vectors: args.chunks.map(() => [0.1, 0.2, 0.3]), totalTokens: 10 } as never; },
    async writeVectors() {},
    async deleteVectors() {},
  };
  const deps = (extra: object = {}) => ({
    store, sql,
    materializer: { storage: {} as never, runner: {} as never, ops,
      config: { lancedb: { root: "/tmp/none", storageOptions: undefined, params: new URLSearchParams() }, defaultInferenceLane: "balanced", vectorBackends: ["lancedb"] } as never },
    ...extra,
  });
  const input = (runId: string, pages: number[]) => ({ runId, documentId: "d1", pages, reason: "query" as const, sessionId: null, maxCredits: 100 });

  beforeEach(async () => {
    await db.exec(`delete from document_chunks; delete from document_pages; delete from document_page_states; delete from usage_events where run_id in ('m1','m2');`);
  });

  it("renews the run's lease while pages materialize so only a dead worker leaves it stale", async () => {
    await ensurePageRows(sql, "d1", 12);
    await db.exec(`update workspace_runs set status = 'processing', lease_expires_at = now() - interval '1 hour' where id = 'm1'`);
    let leaseLiveMidRun: boolean | null = null;
    const probing: Partial<PageMaterializerOps> = {
      ...ops,
      async extractText(d, range) {
        await new Promise((resolve) => setTimeout(resolve, 100)); // let the fire-and-forget renewal land
        leaseLiveMidRun = (await db.query<{ live: boolean }>(`select lease_expires_at > now() as live from workspace_runs where id = 'm1'`)).rows[0]!.live;
        return ops.extractText!(d, range);
      },
    };
    const base = deps({ heartbeat: () => {} }) as { materializer: Record<string, unknown> };
    await runMaterializeRange({ ...base, materializer: { ...base.materializer, ops: probing } } as never, input("m1", [1, 2]));
    expect(leaseLiveMidRun).toBe(true);
    await completeMaterializeRun(sql, "m1", { indexed: [1, 2], blocked: [], failed: [], costCredits: 0 });
    const [done] = (await db.query<{ lease_expires_at: string | null }>(`select lease_expires_at from workspace_runs where id = 'm1'`)).rows;
    expect(done!.lease_expires_at).toBeNull();
    await db.exec(`update workspace_runs set status = 'processing', stage = 'materialize' where id = 'm1'`);
  });

  it("never shortens a longer lease when renewing", async () => {
    await ensurePageRows(sql, "d1", 12);
    await db.exec(`update workspace_runs set status = 'processing', lease_expires_at = now() + interval '2 hours' where id = 'm1'`);
    await runMaterializeRange(deps({ heartbeat: () => {} }) as never, input("m1", [1]));
    const [run] = (await db.query<{ long: boolean }>(`select lease_expires_at > now() + interval '90 minutes' as long from workspace_runs where id = 'm1'`)).rows;
    expect(run!.long).toBe(true);
    await db.exec(`update workspace_runs set status = 'processing', stage = 'materialize', lease_expires_at = null where id = 'm1'`);
  });

  describe("document deleted while pages materialize", () => {
    const seedDoomed = async (id: string) => {
      await db.exec(`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, indexing_mode)
        values ('${id}', 'o1', 'u1', 'w', 'up', '${id}.pdf', 'application/pdf', 'k-${id}', 'completed', 6, 'map')`);
    };
    const usageRows = async () => (await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'm2' and metric = 'ingest-page-fast'`)).rows[0]!.n;

    it("stops cleanly, without throwing or billing, when the document is already gone", async () => {
      await db.exec(`update workspace_runs set status = 'processing' where id = 'm2'`);
      const result = await runMaterializeRange(deps() as never, { ...input("m2", [1, 2, 3]), documentId: "never-existed" });
      expect(result.indexed).toEqual([]);
      expect(result.failed).toEqual([1, 2, 3].map((page) => ({ page, reason: "document-deleted" })));
      expect(await usageRows()).toBe(0);
      await completeMaterializeRun(sql, "m2", result);
      expect((await db.query<{ status: string }>(`select status from workspace_runs where id = 'm2'`)).rows[0]!.status).toBe("completed");
    });

    it("stops cleanly and bills nothing for unwritten pages when the document is deleted mid-run", async () => {
      await seedDoomed("doomed");
      await db.exec(`update workspace_runs set status = 'processing' where id = 'm2'`);
      const deleting: Partial<PageMaterializerOps> = {
        ...ops,
        async extractText(d, range) {
          await db.exec(`delete from documents where id = 'doomed'`);
          return ops.extractText!(d, range);
        },
      };
      const base = deps() as { materializer: Record<string, unknown> };
      const result = await runMaterializeRange({ ...base, materializer: { ...base.materializer, ops: deleting } } as never, { ...input("m2", [1, 2]), documentId: "doomed" });
      expect(result.indexed).toEqual([]);
      expect(result.failed).toEqual([1, 2].map((page) => ({ page, reason: "document-deleted" })));
      expect(await usageRows()).toBe(0);
      await completeMaterializeRun(sql, "m2", result);
      expect((await db.query<{ status: string }>(`select status from workspace_runs where id = 'm2'`)).rows[0]!.status).toBe("completed");
      expect((await db.query(`select 1 from document_page_states where document_id = 'doomed'`)).rows).toHaveLength(0);
    });
  });

  it("materializes claimed pages, bills them and reflects peer-held pages after they finish", async () => {
    await ensurePageRows(sql, "d1", 12);
    // m2 holds page 4 under an unexpired claim.
    await claimPages(sql, { documentId: "d1", pages: [4], runId: "m2", ttlSeconds: 300, reason: "query" });
    let polls = 0;
    const result = await runMaterializeRange(deps({
      sleep: async () => {
        polls += 1;
        await db.exec(`update document_page_states set state = 'indexed', claimed_by_run = null, claim_expires_at = null where document_id = 'd1' and page_number = 4`);
      },
    }) as never, input("m1", [3, 4, 5]));
    expect(result.indexed).toEqual([3, 4, 5]);
    expect(result.failed).toEqual([]);
    expect(polls).toBe(1);
    const fees = await db.query<{ id: string }>(`select id from usage_events where run_id = 'm1' and metric = 'ingest-page-fast' order by id`);
    expect(fees.rows.map((r) => r.id)).toEqual(["m1:d1:3", "m1:d1:4", "m1:d1:5"]);
    await completeMaterializeRun(sql, "m1", result);
    const [run] = (await db.query<{ status: string; pages_processed: number }>(`select status, pages_processed from workspace_runs where id = 'm1'`)).rows;
    expect(run).toEqual({ status: "completed", pages_processed: 3 });
  });

  it("stamps the ledger when it bills, so a later run never re-bills (C3) and text indexing never sets embedded_at (M4)", async () => {
    await ensurePageRows(sql, "d1", 12);
    await runMaterializeRange(deps() as never, input("m1", [3, 4]));
    const rows = await db.query<{ page_number: number; fee_billed_run: string | null; embedded_at: string | null }>(
      `select page_number, fee_billed_run, embedded_at from document_page_states where document_id = 'd1' and page_number in (3,4) order by page_number`);
    expect(rows.rows.map((r) => r.fee_billed_run)).toEqual(["m1", "m1"]);
    expect(rows.rows.map((r) => r.embedded_at)).toEqual([null, null]);
    // A second run touching the same indexed pages (and a direct re-bill attempt) charges nothing.
    await runMaterializeRange(deps() as never, input("m2", [3, 4, 5]));
    expect(await recordMaterializedPageFee(sql, "m2", "d1", [3, 4])).toBe(0);
    const fees = await db.query<{ id: string }>(`select id from usage_events where metric = 'ingest-page-fast' and run_id in ('m1','m2') order by id`);
    expect(fees.rows.map((r) => r.id)).toEqual(["m1:d1:3", "m1:d1:4", "m2:d1:5"]);
    await db.exec(`delete from usage_events where run_id = 'm2'`);
  });

  it("reclaims pages whose peer claim expired while waiting", async () => {
    await ensurePageRows(sql, "d1", 12);
    await claimPages(sql, { documentId: "d1", pages: [8], runId: "m2", ttlSeconds: 300, reason: "query" });
    const result = await runMaterializeRange(deps({
      sleep: async () => { await db.exec(`update document_page_states set claim_expires_at = now() - interval '1 second' where document_id = 'd1' and page_number = 8`); },
    }) as never, input("m1", [8]));
    expect(result.indexed).toEqual([8]);
    const fees = await db.query<{ id: string }>(`select id from usage_events where run_id = 'm1' and metric = 'ingest-page-fast'`);
    expect(fees.rows.map((r) => r.id)).toEqual(["m1:d1:8"]);
  });

  it("does not bill pages a full-index run already paid for", async () => {
    await ensurePageRows(sql, "d1", 12);
    await markPagesIngested(sql, "d1", 12, "full-index");
    const result = await runMaterializeRange(deps() as never, input("m1", [2, 3]));
    expect(result.indexed).toEqual([2, 3]);
    const fees = await db.query(`select id from usage_events where run_id = 'm1' and metric = 'ingest-page-fast'`);
    expect(fees.rows).toHaveLength(0);
  });

  it("labels pages of a full-index run", async () => {
    await db.exec(`update workspace_runs set kind = 'full-index' where id = 'm2'`);
    await runMaterializeRange(deps() as never, input("m2", [9]));
    const [row] = (await db.query<{ materialized_by: string }>(`select materialized_by from document_page_states where document_id = 'd1' and page_number = 9`)).rows;
    expect(row!.materialized_by).toBe("full-index");
    await db.exec(`update workspace_runs set kind = 'materialize' where id = 'm2'; delete from usage_events where run_id = 'm2'`);
  });

  it("applies the source document's ingest pipeline when the materialize run row carries none (C1)", async () => {
    // An app-style insert with the empty default pipeline, as the unfixed client wrote it.
    await db.exec(`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('m-empty', 'o1', 'u1', 'w', 'materialize', 'processing', 'materialize', '{}', 1);
      update workspace_runs set pipeline = '{"indexingMode":"map","privacyMode":"local-only","embedding":{"profile":"cheapest-local"},
        "piiPolicy":{"enabled":true,"patterns":["ssn"],"action":"block_indexing"}}'::jsonb where id = 'up';`);
    const seen: Array<{ privacyMode: string; profile: string }> = [];
    const piiOps: Partial<PageMaterializerOps> = {
      ...ops,
      async extractText(_d, range) {
        return Array.from({ length: range.last - range.first + 1 }, (_, i) => (range.first + i === 2 ? `${LONG} SSN 123-45-6789` : LONG));
      },
      async embed(args) { seen.push({ privacyMode: args.pipeline.privacyMode, profile: args.profile.model }); return { vectors: args.chunks.map(() => [0.1, 0.2, 0.3]), totalTokens: 1 } as never; },
    };
    const d = deps();
    d.materializer.ops = piiOps;
    const result = await runMaterializeRange(d as never, input("m-empty", [1, 2]));
    await db.exec(`update workspace_runs set pipeline = '{"indexingMode":"map"}'::jsonb where id = 'up'`);
    expect(result.blocked).toEqual([2]);
    expect(result.indexed).toEqual([1]);
    expect(seen[0]?.privacyMode).toBe("local-only");
    expect(seen[0]?.profile).toContain("MiniLM");
  });

  it("refuses to run on defaults when neither the run nor its source carries a pipeline", async () => {
    await db.exec(`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('m-bare', 'o1', 'u1', 'w', 'materialize', 'processing', 'materialize', '{}', 1),
               ('up-bare', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, indexing_mode)
        values ('bare', 'o1', 'u1', 'w', 'up-bare', 'z.pdf', 'application/pdf', 'kz', 'processing', 2, 'map');`);
    await expect(runMaterializeRange(deps() as never, { ...input("m-bare", [1]), documentId: "bare" })).rejects.toThrow(/refusing to run on defaults/);
  });

  it("charges a page's base fee once across query materialization and a later full index (I6)", async () => {
    process.env.DOCSLURP_DEFERRED_PROFILES = "1";
    await db.exec(`
      delete from usage_events where run_id in ('fi'); delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('fi', 'o1', 'u1', 'w', 'full-index', 'processing', 'extract', '{"indexingMode":"full"}', 1);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, previous_version_id, indexing_mode)
        values ('d1-full', 'o1', 'u1', 'w', 'fi', 'c.pdf', 'application/pdf', 'k3', 'processing', 12, 'd1', 'full');`);
    await ensurePageRows(sql, "d1", 12);
    await runMaterializeRange(deps() as never, input("m1", [3, 4, 5]));
    await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("fi"), []));
    const total = await db.query<{ amount: string }>(`select amount from usage_events where metric = 'ingest-page-fast' and run_id in ('m1', 'fi')`);
    expect(total.rows.map((r) => Number(r.amount)).reduce((a, b) => a + b, 0)).toBe(12);
    delete process.env.DOCSLURP_DEFERRED_PROFILES;
    await db.exec(`delete from usage_events where run_id = 'fi'; delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';`);
  });

  describe("pages a model read (M1: one charge per page, Rich or Fast)", () => {
    // Page 3 has no text layer, so Auto sends it to OCR; the rest have one.
    const ocrOps: Partial<PageMaterializerOps> = {
      ...ops,
      async extractText(_d, range) { return Array.from({ length: range.last - range.first + 1 }, (_, i) => (range.first + i === 3 ? "" : LONG)); },
      async ocrPage(_d, page) { return { text: `${LONG} scanned page ${page}`, model: "vision-x", provider: "test", inputTokens: 100, outputTokens: 50, costCents: 1 }; },
    };
    const ocrDeps = (extra: object = {}) => {
      const base = deps(extra) as { materializer: Record<string, unknown> };
      return { ...base, materializer: { ...base.materializer, ops: ocrOps } } as never;
    };
    const charges = async () => (await db.query<{ run_id: string; metric: string; page: number; amount: number }>(`
      select run_id, metric, coalesce(metadata->>'page', metadata->>'pageNumber')::int as page, amount::float8 as amount
      from usage_events where metric in ('ingest-page-fast', 'ingest-page-rich')
        and run_id in ('m1', 'm2', 'fi') and coalesce(metadata->>'documentId', '') = 'd1'
      order by page, run_id, metric`)).rows;
    const reset = async () => {
      await db.exec(`update documents set materialization_generation = 0, source_materialization_blocked = false`);
      await db.exec(`update workspace_runs set status = 'processing', stage = 'materialize', kind = 'materialize' where id in ('m1', 'm2')`);
      await ensurePageRows(sql, "d1", 12);
    };

    it("stamps an OCR-read page with its Rich charge, so a later query charges it nothing", async () => {
      await reset();
      await runMaterializeRange(ocrDeps(), input("m1", [3, 4]));
      const stamps = await db.query<{ page_number: number; fee_billed_run: string | null }>(
        `select page_number, fee_billed_run from document_page_states where document_id = 'd1' and page_number in (3, 4) order by 1`);
      expect(stamps.rows).toEqual([{ page_number: 3, fee_billed_run: "m1" }, { page_number: 4, fee_billed_run: "m1" }]);
      await runMaterializeRange(ocrDeps(), input("m2", [3, 4, 5]));
      expect(await charges()).toEqual([
        { run_id: "m1", metric: "ingest-page-rich", page: 3, amount: 1 },
        { run_id: "m1", metric: "ingest-page-fast", page: 4, amount: 1 },
        { run_id: "m2", metric: "ingest-page-fast", page: 5, amount: 1 },
      ]);
    });

    it("a retried attempt charges nothing twice, with or without the earlier attempt's stamp", async () => {
      await reset();
      await runMaterializeRange(ocrDeps(), input("m1", [3, 4]));
      await runMaterializeRange(ocrDeps(), input("m1", [3, 4]));
      // An attempt that persisted its Rich read but crashed before stamping: the retry finds the read and skips Fast.
      await db.exec(`update document_page_states set fee_billed_run = null, fee_billed_at = null where document_id = 'd1' and page_number = 3`);
      await runMaterializeRange(ocrDeps(), input("m1", [3]));
      expect(await charges()).toEqual([
        { run_id: "m1", metric: "ingest-page-rich", page: 3, amount: 1 },
        { run_id: "m1", metric: "ingest-page-fast", page: 4, amount: 1 },
      ]);
    });

    it("a concurrent query waits on a page whose reader has not committed its charges (it is still claimed)", async () => {
      await reset();
      // m1 read page 3 but has not committed: the page is still claimed by m1, never indexed without its charge.
      await claimPages(sql, { documentId: "d1", pages: [3], runId: "m1", ttlSeconds: 300, reason: "query" });
      const waiting = await runMaterializeRange(ocrDeps({ awaitTimeoutMs: 0 }), input("m2", [3]));
      expect(waiting.failed).toEqual([{ page: 3, reason: "await-timeout" }]);
      await runMaterializeRange(ocrDeps(), input("m1", [3]));
      await runMaterializeRange(ocrDeps(), input("m2", [3]));
      expect(await charges()).toEqual([{ run_id: "m1", metric: "ingest-page-rich", page: 3, amount: 1 }]);
    });

    describe("a failed billing transaction (M1 crash window, L1 stale stamps)", () => {
      // Stands in for a crash or a database error after the pages turned indexed but before their charges
      // committed: the trigger fails the transaction at the first charge insert.
      const failFeesFor = async (runId: string) => {
        await db.exec(`
          create or replace function test_fail_fees() returns trigger language plpgsql as $$
          begin
            if new.run_id = '${runId}' and new.metric in ('ingest-page-fast', 'ingest-page-rich') then
              raise exception 'injected fee write failure';
            end if;
            return new;
          end $$;
          drop trigger if exists test_fail_fees on usage_events;
          create trigger test_fail_fees before insert on usage_events for each row execute function test_fail_fees();`);
      };
      const stopFailing = async () => { await db.exec(`drop trigger if exists test_fail_fees on usage_events`); };
      const pageRows = async () => (await db.query<{ page_number: number; state: string; fee_billed_run: string | null }>(
        `select page_number, state, fee_billed_run from document_page_states where document_id = 'd1' and page_number in (3, 4) order by 1`)).rows;
      afterEach(stopFailing);

      it("rolls the indexed transition back with the charges, and the retry charges the Rich read once, never Fast", async () => {
        await reset();
        await failFeesFor("m1");
        await expect(runMaterializeRange(ocrDeps(), input("m1", [3, 4]))).rejects.toThrow(/injected fee write failure/);
        // Nothing committed: the pages are still m1's claim, unstamped and uncharged.
        expect(await pageRows()).toEqual([
          { page_number: 3, state: "claimed", fee_billed_run: null },
          { page_number: 4, state: "claimed", fee_billed_run: null },
        ]);
        expect(await charges()).toEqual([]);
        await stopFailing();
        // The retry re-claims its own pages, reads page 3 again and commits Rich for it with the stamps.
        const retry = await runMaterializeRange(ocrDeps(), input("m1", [3, 4]));
        expect(retry.indexed).toEqual([3, 4]);
        await runMaterializeRange(ocrDeps(), input("m2", [3, 4]));
        expect(await pageRows()).toEqual([
          { page_number: 3, state: "indexed", fee_billed_run: "m1" },
          { page_number: 4, state: "indexed", fee_billed_run: "m1" },
        ]);
        expect(await charges()).toEqual([
          { run_id: "m1", metric: "ingest-page-rich", page: 3, amount: 1 },
          { run_id: "m1", metric: "ingest-page-fast", page: 4, amount: 1 },
        ]);
      });

      it("a run whose fee write fails for good leaves the pages to a later run, which bills them exactly once", async () => {
        await reset();
        await failFeesFor("m1");
        await expect(runMaterializeRange(ocrDeps(), input("m1", [3, 4]))).rejects.toThrow(/injected fee write failure/);
        await expect(runMaterializeRange(ocrDeps(), input("m1", [3, 4]))).rejects.toThrow(/injected fee write failure/);
        // m1 gives up; its claim expires and m2 takes the pages.
        await db.exec(`update document_page_states set claim_expires_at = now() - interval '1 second' where document_id = 'd1' and page_number in (3, 4)`);
        expect((await runMaterializeRange(ocrDeps(), input("m2", [3, 4]))).indexed).toEqual([3, 4]);
        await runMaterializeRange(ocrDeps(), input("m2", [3, 4]));
        expect(await charges()).toEqual([
          { run_id: "m2", metric: "ingest-page-rich", page: 3, amount: 1 },
          { run_id: "m2", metric: "ingest-page-fast", page: 4, amount: 1 },
        ]);
      });

      it("a later run takes over a page stamped by a run that recorded no charge for it, and bills it once", async () => {
        await reset();
        // A stale stamp: m1 is recorded as the page's billing decision but never charged it (an older worker
        // stamped before charging, then lost the write; or the run was cancelled).
        await db.exec(`update document_page_states set state = 'indexed', materialized_by = 'query', fee_billed_run = 'm1', fee_billed_at = now()
          where document_id = 'd1' and page_number = 4;
          update workspace_runs set status = 'cancelled' where id = 'm1'`);
        await runMaterializeRange(ocrDeps(), input("m2", [4]));
        await runMaterializeRange(ocrDeps(), input("m2", [4]));
        await runMaterializeRange(ocrDeps(), input("m1", [4]));
        expect(await charges()).toEqual([{ run_id: "m2", metric: "ingest-page-fast", page: 4, amount: 1 }]);
        const [row] = (await db.query<{ fee_billed_run: string }>(`select fee_billed_run from document_page_states where document_id = 'd1' and page_number = 4`)).rows;
        expect(row!.fee_billed_run).toBe("m2");
      });

      describe("stale-stamp takeover (round 5 M2): only a stamping run that can no longer commit loses its page", () => {
        const stampUncharged = async () => {
          await db.exec(`update document_page_states set state = 'indexed', materialized_by = 'query', fee_billed_run = 'm1', fee_billed_at = now()
            where document_id = 'd1' and page_number = 4`);
        };
        // m1 read page 4 with a model; its Rich charge is still buffered in its usage ledger.
        const m1Ledger = () => {
          const ledger = new PipelineUsageEventLedger();
          ledger.runId = "m1";
          ledger.chargeRichPage({ documentId: "d1", pageNumber: 4, readBy: "ocr", model: "vision-x" });
          return ledger;
        };

        it("an active owner with a pending Rich charge keeps its page: no Fast charge from the later run", async () => {
          await reset();
          await db.exec(`update workspace_runs set lease_expires_at = now() + interval '10 minutes' where id = 'm1'`);
          await stampUncharged();
          const ledger = m1Ledger();
          await runMaterializeRange(ocrDeps(), input("m2", [4]));
          expect(await recordMaterializedPageFee(sql, "m2", "d1", [4])).toBe(0);
          // m1 then persists its Rich read with its stamp.
          await recordMaterializedPageFee(sql, "m1", "d1", [4], { ledger });
          expect(ledger.snapshot()).toEqual([]);
          expect(await charges()).toEqual([{ run_id: "m1", metric: "ingest-page-rich", page: 4, amount: 1 }]);
          expect((await pageRows()).find((r) => r.page_number === 4)?.fee_billed_run).toBe("m1");
        });

        it.each([
          ["terminal", `update workspace_runs set status = 'cancelled' where id = 'm1'`],
          ["lease-expired", `update workspace_runs set status = 'processing', lease_expires_at = now() - interval '1 second' where id = 'm1'`],
        ])("a %s owner loses its page, and its late Rich charge is dropped, not added", async (_label, ownerSql) => {
          await reset();
          await stampUncharged();
          await db.exec(ownerSql);
          const ledger = m1Ledger();
          await runMaterializeRange(ocrDeps(), input("m2", [4]));
          // The original run wakes up and tries to persist its buffered Rich read: m2 owns the page now.
          expect(await recordMaterializedPageFee(sql, "m1", "d1", [4], { ledger })).toBe(0);
          expect(ledger.snapshot()).toEqual([]);
          expect(await charges()).toEqual([{ run_id: "m2", metric: "ingest-page-fast", page: 4, amount: 1 }]);
          expect((await pageRows()).find((r) => r.page_number === 4)?.fee_billed_run).toBe("m2");
        });
      });

      it("a run that stalled past its claim TTL neither indexes nor bills the page another run took (round 5 L1)", async () => {
        await reset();
        let stalled = false;
        // m1 OCRs page 3 slowly: meanwhile its claim expires and m2 claims, reads and bills the page.
        const stallingOps: Partial<PageMaterializerOps> = {
          ...ocrOps,
          async ocrPage(d, page, ...rest) {
            if (!stalled) {
              stalled = true;
              await db.exec(`update document_page_states set claim_expires_at = now() - interval '1 second' where document_id = 'd1' and page_number = 3`);
              const peer = await runMaterializeRange(ocrDeps(), input("m2", [3]));
              expect(peer.indexed).toEqual([3]);
            }
            return await ocrOps.ocrPage!(d, page, ...rest);
          },
        };
        const base = deps() as { materializer: Record<string, unknown> };
        const late = await runMaterializeRange({ ...base, materializer: { ...base.materializer, ops: stallingOps } } as never, input("m1", [3]));
        expect(late.indexed).toEqual([]);
        expect(await charges()).toEqual([{ run_id: "m2", metric: "ingest-page-rich", page: 3, amount: 1 }]);
        const [row] = (await db.query<{ state: string; fee_billed_run: string | null; claimed_by_run: string | null }>(
          `select state, fee_billed_run, claimed_by_run from document_page_states where document_id = 'd1' and page_number = 3`)).rows;
        expect(row).toEqual({ state: "indexed", fee_billed_run: "m2", claimed_by_run: null });
      });

      it("a stamp whose run charged the page is never taken over", async () => {
        await reset();
        await runMaterializeRange(ocrDeps(), input("m1", [3, 4]));
        expect(await recordMaterializedPageFee(sql, "m2", "d1", [3, 4])).toBe(0);
        expect((await pageRows()).map((r) => r.fee_billed_run)).toEqual(["m1", "m1"]);
      });
    });

    describe("publication is fenced on the claim (round 6 M1, M2)", () => {
      // Every page has a text layer; Good (m1) still sends each page to vision, Auto (m2) indexes the text layer.
      const VISION = "VISION-READ";
      const tracked = () => {
        const writes: Record<string, string[]> = {};
        const deletes: Record<string, string[]> = {};
        const opsFor = (runId: string, onOcr?: () => Promise<void>): Partial<PageMaterializerOps> => ({
          ...ops,
          async ocrPage(_d, page) {
            await onOcr?.();
            return { text: `${LONG} ${VISION} page ${page}`, model: "vision-x", provider: "test", inputTokens: 100, outputTokens: 50, costCents: 1 };
          },
          async writeVectors(_uri, _table, records) { (writes[runId] ??= []).push(...records.map((r) => r.id)); },
          async deleteVectors(_uri, _table, ids) { (deletes[runId] ??= []).push(...ids); },
        });
        const depsFor = (runId: string, onOcr?: () => Promise<void>) => {
          const base = deps() as { materializer: Record<string, unknown> };
          return { ...base, materializer: { ...base.materializer, ops: opsFor(runId, onOcr) } } as never;
        };
        return { writes, deletes, depsFor };
      };
      const page3 = async () => ({
        text: (await db.query<{ text: string }>(`select text from document_pages where document_id = 'd1' and page_number = 3`)).rows.map((r) => r.text),
        chunks: (await db.query<{ id: string; text: string }>(`select id, text from document_chunks where document_id = 'd1' and page_number = 3 order by id`)).rows,
        state: (await db.query<{ state: string; fee_billed_run: string | null; claimed_by_run: string | null }>(
          `select state, fee_billed_run, claimed_by_run from document_page_states where document_id = 'd1' and page_number = 3`)).rows[0],
      });
      const credits = async () => Number((await db.query<{ c: string }>(`select coalesce(sum(cost_cents), 0) as c from usage_events
        where metric in ('ingest-page-fast', 'ingest-page-rich') and run_id in ('m1', 'm2') and metadata->>'documentId' = 'd1'`)).rows[0]!.c);
      const expire = async () => {
        await db.exec(`update document_page_states set claim_expires_at = now() - interval '1 second' where document_id = 'd1' and page_number = 3`);
      };
      beforeEach(async () => {
        await reset();
        await db.exec(`update workspace_runs set pipeline = '{"quality":"good"}' where id = 'm1';
          update workspace_runs set pipeline = '{"quality":"auto"}' where id = 'm2'`);
      });
      afterEach(async () => {
        await db.exec(`update workspace_runs set pipeline = '{}' where id in ('m1', 'm2')`);
      });

      it("Good m1 stalls in OCR, Auto m2 indexes the text layer and bills Fast: m1 publishes nothing and upgrades the charge to Rich once", async () => {
        const t = tracked();
        let peer = false;
        const late = await runMaterializeRange(t.depsFor("m1", async () => {
          if (peer) return;
          peer = true;
          await expire();
          expect((await runMaterializeRange(t.depsFor("m2"), input("m2", [3]))).indexed).toEqual([3]);
        }), input("m1", [3]));
        expect(late).toMatchObject({ indexed: [], failed: [] });
        const after = await page3();
        // The winner's content stands: page text, chunks and vectors are m2's text layer.
        expect(after.text).toEqual([LONG]);
        expect(after.chunks.length).toBeGreaterThan(0);
        expect(after.chunks.every((c) => !c.text.includes(VISION))).toBe(true);
        expect(after.state).toEqual({ state: "indexed", fee_billed_run: "m2", claimed_by_run: null });
        expect(t.writes.m1 ?? []).toEqual([]);
        expect(t.deletes.m1 ?? []).toEqual([]);
        expect(t.writes.m2).toEqual(after.chunks.map((c) => c.id));
        // One charge: m2's Fast decision plus m1's upgrade of the difference = one Rich page.
        expect(await charges()).toEqual([
          { run_id: "m1", metric: "ingest-page-rich", page: 3, amount: 1 },
          { run_id: "m2", metric: "ingest-page-fast", page: 3, amount: 1 },
        ]);
        expect(await credits()).toBeCloseTo(pageCredits("rich", 1), 9);
        // Replaying m1 changes nothing (the upgrade id is per page).
        await runMaterializeRange(t.depsFor("m1"), input("m1", [3]));
        expect(await credits()).toBeCloseTo(pageCredits("rich", 1), 9);
      });

      it("when the winner commits after the lost read, the winner's one decision is Rich (no Fast, no upgrade)", async () => {
        const t = tracked();
        let peer = false;
        await runMaterializeRange(t.depsFor("m1", async () => {
          if (peer) return;
          peer = true;
          await expire();
          // m2 claims page 3 and is still working when m1 finishes.
          await claimPages(sql, { documentId: "d1", pages: [3], runId: "m2", ttlSeconds: 300, reason: "query" });
        }), input("m1", [3]));
        expect((await page3()).chunks).toEqual([]);
        expect(await charges()).toEqual([]);
        expect((await runMaterializeRange(t.depsFor("m2"), input("m2", [3]))).indexed).toEqual([3]);
        expect((await page3()).chunks.every((c) => !c.text.includes(VISION))).toBe(true);
        expect(await charges()).toEqual([{ run_id: "m2", metric: "ingest-page-rich", page: 3, amount: 1 }]);
        expect(await credits()).toBeCloseTo(pageCredits("rich", 1), 9);
        expect(t.writes.m1 ?? []).toEqual([]);
      });

      it("the new holder fails the page and m1 resumes: m1 publishes nothing; when m1 re-claims and publishes, one Rich charge", async () => {
        const t = tracked();
        let peer = false;
        const late = await runMaterializeRange(t.depsFor("m1", async () => {
          if (peer) return;
          peer = true;
          await expire();
          await claimPages(sql, { documentId: "d1", pages: [3], runId: "m2", ttlSeconds: 300, reason: "query" });
          await markPages(sql, "d1", [3], "failed", { failureReason: "embedding failed", claimedBy: "m2" });
        }), input("m1", [3]));
        expect(late.indexed).toEqual([]);
        const after = await page3();
        expect(after.chunks).toEqual([]);
        expect(after.text).toEqual([]);
        expect(after.state).toMatchObject({ state: "failed", fee_billed_run: null });
        expect(t.writes.m1 ?? []).toEqual([]);
        expect(await charges()).toEqual([]);
        // The m1 retry re-claims the failed page, reads it and publishes its own content: exactly one Rich charge.
        expect((await runMaterializeRange(t.depsFor("m1"), input("m1", [3]))).indexed).toEqual([3]);
        expect((await page3()).chunks.every((c) => c.text.includes(VISION))).toBe(true);
        expect(await charges()).toEqual([{ run_id: "m1", metric: "ingest-page-rich", page: 3, amount: 1 }]);
        expect(await credits()).toBeCloseTo(pageCredits("rich", 1), 9);
      });

      it("a run that lost its page never deletes the winner's chunks (stale-chunk cleanup is fenced)", async () => {
        const t = tracked();
        // m2 publishes page 3 as two chunks first.
        const twoParts = `# One\n\n${LONG}\n\n# Two\n\n${LONG} again`;
        const m2Deps = t.depsFor("m2") as { materializer: { ops: Partial<PageMaterializerOps> } };
        m2Deps.materializer.ops = { ...m2Deps.materializer.ops, async extractText(_d, range) { return Array.from({ length: range.last - range.first + 1 }, () => twoParts); } };
        let peer = false;
        await runMaterializeRange(t.depsFor("m1", async () => {
          if (peer) return;
          peer = true;
          await expire();
          await runMaterializeRange(m2Deps as never, input("m2", [3]));
        }), input("m1", [3]));
        const after = await page3();
        expect(after.chunks.length).toBe(t.writes.m2!.length);
        expect(after.chunks.map((c) => c.id)).toEqual(t.writes.m2);
        expect(t.deletes.m1 ?? []).toEqual([]);
      });

      it("vectors written under the lock are deleted when the publication rolls back", async () => {
        const t = tracked();
        await db.exec(`
          create or replace function test_fail_fees() returns trigger language plpgsql as $$
          begin
            if new.run_id = 'm1' and new.metric in ('ingest-page-fast', 'ingest-page-rich') then raise exception 'injected fee write failure'; end if;
            return new;
          end $$;
          drop trigger if exists test_fail_fees on usage_events;
          create trigger test_fail_fees before insert on usage_events for each row execute function test_fail_fees();`);
        try {
          await expect(runMaterializeRange(t.depsFor("m1"), input("m1", [3]))).rejects.toThrow(/injected fee write failure/);
        } finally {
          await db.exec(`drop trigger if exists test_fail_fees on usage_events`);
        }
        expect(t.writes.m1!.length).toBeGreaterThan(0);
        expect(t.deletes.m1).toEqual(t.writes.m1);
        expect((await page3()).chunks).toEqual([]);
        expect((await page3()).state).toMatchObject({ state: "claimed", claimed_by_run: "m1" });
      });

      describe("a page that failed after a charged read keeps its one charge (round 7 L1)", () => {
        const withOps = (runId: string, t: ReturnType<typeof tracked>, extra: Partial<PageMaterializerOps>, onOcr?: () => Promise<void>) => {
          const d = t.depsFor(runId, onOcr) as { materializer: { ops: Partial<PageMaterializerOps> } };
          d.materializer.ops = { ...d.materializer.ops, ...extra };
          return d as never;
        };
        const embedDown: Partial<PageMaterializerOps> = { async embed() { throw new Error("embedding provider down"); } };
        const readState = async () => (await db.query<{ state: string; fee_billed_run: string | null; read_billed_run: string | null; kept: boolean }>(
          `select state, fee_billed_run, read_billed_run, read_text is not null as kept from document_page_states where document_id = 'd1' and page_number = 3`)).rows[0];
        const m1Rich = [{ run_id: "m1", metric: "ingest-page-rich", page: 3, amount: 1 }];

        it("Good m1 reads, embedding fails: one Rich charge; Auto m2 indexes the kept read with no Fast charge", async () => {
          const t = tracked();
          const first = await runMaterializeRange(withOps("m1", t, embedDown), input("m1", [3]));
          expect(first.failed).toEqual([{ page: 3, reason: "embedding provider down" }]);
          expect(await charges()).toEqual(m1Rich);
          expect(await readState()).toMatchObject({ state: "failed", read_billed_run: "m1", kept: true });
          expect((await runMaterializeRange(t.depsFor("m2"), input("m2", [3]))).indexed).toEqual([3]);
          // m2 published m1's read (no text-layer re-extraction of a page already read) and charged nothing.
          expect((await page3()).chunks.every((c) => c.text.includes(VISION))).toBe(true);
          expect(await charges()).toEqual(m1Rich);
          expect(await credits()).toBeCloseTo(pageCredits("rich", 1), 9);
          expect(await readState()).toMatchObject({ state: "indexed", fee_billed_run: "m2", read_billed_run: "m1", kept: false });
        });

        it("a Good retry (the same run, or another) reuses the kept read: no model call, no second Rich", async () => {
          const t = tracked();
          await runMaterializeRange(withOps("m1", t, embedDown), input("m1", [3]));
          let reads = 0;
          const failedAgain = await runMaterializeRange(withOps("m1", t, embedDown, async () => { reads += 1; }), input("m1", [3]));
          expect(failedAgain.failed).toEqual([{ page: 3, reason: "embedding provider down" }]);
          await db.exec(`update workspace_runs set pipeline = '{"quality":"good"}' where id = 'm2'`);
          expect((await runMaterializeRange(t.depsFor("m2", async () => { reads += 1; }), input("m2", [3]))).indexed).toEqual([3]);
          expect(reads).toBe(0);
          expect(await charges()).toEqual(m1Rich);
          expect(await credits()).toBeCloseTo(pageCredits("rich", 1), 9);
        });

        it("an empty read is the page's one charge; a later read that indexes it adds none", async () => {
          const t = tracked();
          const empty = await runMaterializeRange(withOps("m1", t, {
            async ocrPage() { return { text: "  ", model: "vision-x", provider: "test", inputTokens: 100, outputTokens: 1, costCents: 1 }; },
          }), input("m1", [3]));
          expect(empty.failed).toEqual([{ page: 3, reason: "empty-page" }]);
          expect(await readState()).toMatchObject({ state: "failed", read_billed_run: "m1", kept: false });
          await db.exec(`update workspace_runs set pipeline = '{"quality":"good"}' where id = 'm2'`);
          expect((await runMaterializeRange(t.depsFor("m2"), input("m2", [3]))).indexed).toEqual([3]);
          expect((await page3()).chunks.every((c) => c.text.includes(VISION))).toBe(true);
          // m2's own Rich read of the page stays provider usage.
          expect(await charges()).toEqual(m1Rich);
          expect(await readState()).toMatchObject({ state: "indexed", fee_billed_run: "m2" });
        });

        it("a lost read (model_read_run) plus an owner whose read then failed bill one Rich, not two", async () => {
          const t = tracked();
          await db.exec(`update workspace_runs set pipeline = '{"quality":"good"}' where id = 'm2'`);
          let peer = false;
          // m1 stalls in OCR; m2 takes the page, reads it and fails on embedding. m1 resumes having lost the page.
          const late = await runMaterializeRange(t.depsFor("m1", async () => {
            if (peer) return;
            peer = true;
            await expire();
            expect((await runMaterializeRange(withOps("m2", t, embedDown), input("m2", [3]))).failed).toEqual([{ page: 3, reason: "embedding provider down" }]);
          }), input("m1", [3]));
          expect(late).toMatchObject({ indexed: [], failed: [] });
          const recorded = (await db.query<{ model_read_run: string | null; read_billed_run: string | null }>(
            `select model_read_run, read_billed_run from document_page_states where document_id = 'd1' and page_number = 3`)).rows[0];
          expect(recorded).toEqual({ model_read_run: "m1", read_billed_run: "m2" });
          // m1 retries and publishes: m2's read already paid the page, so neither m1's read nor model_read_run adds a charge.
          expect((await runMaterializeRange(t.depsFor("m1"), input("m1", [3]))).indexed).toEqual([3]);
          expect(await charges()).toEqual([{ run_id: "m2", metric: "ingest-page-rich", page: 3, amount: 1 }]);
          expect(await credits()).toBeCloseTo(pageCredits("rich", 1), 9);
          // A recovery pass on the stamped page finds nothing to take over.
          await db.exec(`update workspace_runs set status = 'completed' where id = 'm1'`);
          expect(await recordMaterializedPageFee(sql, "m2", "d1", [3])).toBe(0);
          await db.exec(`update workspace_runs set status = 'processing' where id = 'm1'`);
        });

        it("a PII-blocked read keeps no text, and a later full index does not charge the page again", async () => {
          process.env.DOCSLURP_DEFERRED_PROFILES = "1";
          const t = tracked();
          await db.exec(`
            update workspace_runs set pipeline = '{"quality":"good","piiPolicy":{"enabled":true,"patterns":["ssn"],"action":"block_indexing","allowlistPatterns":[]}}' where id = 'm1';
            delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';
            insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
              values ('fi', 'o1', 'u1', 'w', 'full-index', 'processing', 'extract', '{"indexingMode":"full"}', 1);
            insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, previous_version_id, indexing_mode)
              values ('d1-full', 'o1', 'u1', 'w', 'fi', 'c.pdf', 'application/pdf', 'k3', 'processing', 12, 'd1', 'full');`);
          try {
            const blocked = await runMaterializeRange(withOps("m1", t, {
              async ocrPage(_d, page) { return { text: `${LONG} SSN 123-45-6789 page ${page}`, model: "vision-x", provider: "test", inputTokens: 100, outputTokens: 50, costCents: 1 }; },
            }), input("m1", [3]));
            expect(blocked.blocked).toEqual([3]);
            expect(await readState()).toMatchObject({ state: "blocked-pii", read_billed_run: "m1", kept: false });
            expect(await charges()).toEqual(m1Rich);
            const full = await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("fi"), []));
            // 12 pages - page 3 (paid by m1's read) = 11 Fast.
            expect(full).toMatchObject({ fastPages: 11, richPages: 0 });
          } finally {
            delete process.env.DOCSLURP_DEFERRED_PROFILES;
            await db.exec(`delete from usage_events where run_id = 'fi'; delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';`);
          }
        });

        describe("round 8: a kept read never outlives retention, a PII policy or its charge", () => {
          const costOf = async () => Number((await db.query<{ c: string | null }>(
            `select cost_credits::float8 as c from document_page_states where document_id = 'd1' and page_number = 3`)).rows[0]!.c ?? 0);

          it.each(["retention", "correction"])("does not republish an in-flight kept read invalidated by %s", async (kind) => {
            const t = tracked();
            await runMaterializeRange(withOps("m1", t, embedDown), input("m1", [3]));
            expect(await readState()).toMatchObject({ kept: true });
            try {
              const late = await runMaterializeRange(withOps("m2", t, {
                async embed(args) {
                  if (kind === "retention") {
                    await db.exec(`update workspaces set artifact_retention_days = 1 where id = 'w';
                      update workspace_runs set status = 'completed', created_at = now() - interval '3 days' where id = 'up'`);
                    await (store as unknown as { purgeExpiredArtifacts(storage: unknown, batchSize: number): Promise<void> })
                      .purgeExpiredArtifacts({ bucket: "b", deleteKeys: async () => {} }, 10);
                  } else {
                    await db.exec(`update documents set materialization_generation = materialization_generation + 1, source_materialization_blocked = true where id = 'd1';
                      update document_page_states set read_text = null where document_id = 'd1';
                      delete from document_chunks where document_id = 'd1'; delete from document_pages where document_id = 'd1'`);
                  }
                  return ops.embed!(args);
                },
              }), input("m2", [3]));
              expect(late.indexed).toEqual([]);
              expect((await page3()).chunks).toEqual([]);
              expect((await page3()).text).toEqual([]);
              expect(t.writes.m2 ?? []).toEqual([]);
              expect(await readState()).toMatchObject({ kept: false });
              expect(await charges()).toEqual(m1Rich);
            } finally {
              await db.exec(`update workspaces set artifact_retention_days = null where id = 'w';
                update workspace_runs set status = 'processing', created_at = now(), artifacts_purged_at = null where id = 'up'`);
            }
          });

          it.each([
            ["retention", false], ["retention", true], ["correction", false], ["correction", true],
          ])("does not publish or retain fresh OCR after %s (embedding fails: %s)", async (kind, embeddingFails) => {
            const t = tracked();
            await db.exec(`update workspace_runs set pipeline = '{"quality":"good"}' where id = 'm2'`);
            try {
              const late = await runMaterializeRange(withOps("m2", t, {
                async embed(args) {
                  if (kind === "retention") {
                    await db.exec(`update workspaces set artifact_retention_days = 1 where id = 'w';
                      update workspace_runs set status = 'completed', created_at = now() - interval '3 days' where id = 'up'`);
                    await (store as unknown as { purgeExpiredArtifacts(storage: unknown, batchSize: number): Promise<void> })
                      .purgeExpiredArtifacts({ bucket: "b", deleteKeys: async () => {} }, 10);
                  } else {
                    await db.exec(`update documents set materialization_generation = materialization_generation + 1, source_materialization_blocked = true where id = 'd1';
                      update document_page_states set read_text = null where document_id = 'd1';
                      delete from document_chunks where document_id = 'd1'; delete from document_pages where document_id = 'd1'`);
                  }
                  if (embeddingFails) throw new Error("embedding provider down");
                  return ops.embed!(args);
                },
              }), input("m2", [3]));
              expect(late.indexed).toEqual([]);
              expect((await page3()).chunks).toEqual([]);
              expect((await page3()).text).toEqual([]);
              expect(t.writes.m2 ?? []).toEqual([]);
              expect(await readState()).toMatchObject({ kept: false });
              expect(await charges()).toEqual([]);
              expect(late.failed).toEqual([{ page: 3, reason: "source-content-invalidated" }]);
            } finally {
              await db.exec(`update workspaces set artifact_retention_days = null where id = 'w';
                update workspace_runs set status = 'processing', created_at = now(), artifacts_purged_at = null where id = 'up'`);
            }
          });

          it("keeps provider usage but drops revoked OCR charges when refusal marking fails", async () => {
            const t = tracked();
            await db.exec(`create function reject_revoked_page() returns trigger language plpgsql as $$
              begin if NEW.failure_reason = 'source-content-invalidated' then raise exception 'refusal write failed'; end if; return NEW; end $$;
              create trigger reject_revoked_page before update on document_page_states for each row execute function reject_revoked_page()`);
            try {
              await expect(runMaterializeRange(withOps("m1", t, {
                async embed(args) {
                  await db.exec(`update documents set materialization_generation = materialization_generation + 1,
                    source_materialization_blocked = true where id = 'd1'`);
                  return ops.embed!(args);
                },
              }), input("m1", [3]))).rejects.toThrow("refusal write failed");
              expect(await charges()).toEqual([]);
              expect((await page3()).chunks).toEqual([]);
              expect(await readState()).toMatchObject({ kept: false });
              expect((await db.query(`select id from usage_events where run_id = 'm1' and metric = 'page-analysis'`)).rows.length).toBe(1);
            } finally {
              await db.exec(`drop trigger reject_revoked_page on document_page_states; drop function reject_revoked_page()`);
            }
          });

          it("retention purge clears the kept read: a later query publishes none of it and charges nothing again (M1)", async () => {
            const t = tracked();
            await runMaterializeRange(withOps("m1", t, embedDown), input("m1", [3]));
            expect(await readState()).toMatchObject({ state: "failed", read_billed_run: "m1", kept: true });
            await db.exec(`update workspaces set artifact_retention_days = 1 where id = 'w';
              update workspace_runs set status = 'completed', created_at = now() - interval '3 days' where id = 'up'`);
            try {
              await (store as unknown as { purgeExpiredArtifacts(storage: unknown, batchSize: number): Promise<void> })
                .purgeExpiredArtifacts({ bucket: "b", deleteKeys: async () => {} }, 10);
              expect(await readState()).toMatchObject({ state: "failed", read_billed_run: "m1", kept: false });
              // Belt and braces: a kept read of a purged run is never reused even if one survived.
              await db.exec(`update document_page_states set read_text = 'PURGED ${VISION}' where document_id = 'd1' and page_number = 3`);
              const later = await runMaterializeRange(t.depsFor("m2"), input("m2", [3]));
              expect(later.indexed).toEqual([]);
              expect(later.failed).toEqual([{ page: 3, reason: "source-content-invalidated" }]);
              expect((await page3()).chunks).toEqual([]);
              expect((await page3()).chunks.some((c) => c.text.includes(VISION))).toBe(false);
              expect(await charges()).toEqual(m1Rich);
              // m2 charged nothing (m1's read paid the page): it reports no credits for it.
              expect(later.costCredits).toBe(0);
            } finally {
              await db.exec(`update workspaces set artifact_retention_days = null where id = 'w';
                update workspace_runs set status = 'processing', created_at = now(), artifacts_purged_at = null where id = 'up'`);
            }
          });

          it("a redacted read is not kept, so a later block_indexing policy blocks the page instead of indexing it (M2)", async () => {
            const t = tracked();
            const ssn = (page: number) => ({ text: `${LONG} SSN 123-45-6789 ${VISION} page ${page}`, model: "vision-x", provider: "test", inputTokens: 100, outputTokens: 50, costCents: 1 });
            await db.exec(`update workspace_runs set pipeline = '{"quality":"good","piiPolicy":{"enabled":true,"patterns":["ssn"],"action":"redact_artifacts","allowlistPatterns":[]}}' where id = 'm1';
              update workspace_runs set pipeline = '{"quality":"good","piiPolicy":{"enabled":true,"patterns":["ssn"],"action":"block_indexing","allowlistPatterns":[]}}' where id = 'm2'`);
            const first = await runMaterializeRange(withOps("m1", t, { ...embedDown, async ocrPage(_d, page) { return ssn(page); } }), input("m1", [3]));
            expect(first.failed).toEqual([{ page: 3, reason: "embedding provider down" }]);
            // The read is the page's one charge, but its redacted text is not kept.
            expect(await readState()).toMatchObject({ state: "failed", read_billed_run: "m1", kept: false });
            let reads = 0;
            const second = await runMaterializeRange(withOps("m2", t, { async ocrPage(_d, page) { reads += 1; return ssn(page); } }), input("m2", [3]));
            // m2 re-read the page under the policy in force and blocked it.
            expect(reads).toBe(1);
            expect(second.blocked).toEqual([3]);
            expect(second.indexed).toEqual([]);
            expect((await page3()).chunks).toEqual([]);
            expect(await readState()).toMatchObject({ state: "blocked-pii", kept: false });
            expect(await charges()).toEqual(m1Rich);
          });

          it("a clean read is kept and reused; a page whose stored read now matches the PII policy is blocked and its read cleared (M2)", async () => {
            const t = tracked();
            await runMaterializeRange(withOps("m1", t, embedDown), input("m1", [3]));
            expect(await readState()).toMatchObject({ kept: true });
            await db.exec(`update document_page_states set read_text = read_text || ' SSN 123-45-6789' where document_id = 'd1' and page_number = 3;
              update workspace_runs set pipeline = '{"quality":"good","piiPolicy":{"enabled":true,"patterns":["ssn"],"action":"block_indexing","allowlistPatterns":[]}}' where id = 'm2'`);
            const blocked = await runMaterializeRange(t.depsFor("m2"), input("m2", [3]));
            expect(blocked.blocked).toEqual([3]);
            expect(await readState()).toMatchObject({ state: "blocked-pii", read_billed_run: "m1", kept: false });
          });

          it("a failed read with no Rich charge behind it is not recorded as the page's charge (L1)", async () => {
            const t = tracked();
            // A failed read whose Rich charge the ledger never buffered (or already dropped): no pending event, none committed.
            await sql.begin(async (tx) => {
              await lockPageRows(tx as never, "d1", [3]);
              const outcome = await billLockedMaterializedPages(tx as never, {
                runId: "m1", documentId: "d1", requested: [], moved: new Set(), ledger: new PipelineUsageEventLedger(),
                failedReads: new Map([[3, "unbacked read"]]),
              });
              expect(outcome).toMatchObject({ inserted: 0, credits: 0 });
            });
            expect(await readState()).toMatchObject({ read_billed_run: null, kept: false });
            // The page stays undecided: the run that indexes it bills it (Fast here), so it is never left unpaid.
            expect((await runMaterializeRange(t.depsFor("m2"), input("m2", [3]))).indexed).toEqual([3]);
            expect(await charges()).toEqual([{ run_id: "m2", metric: "ingest-page-fast", page: 3, amount: 1 }]);
          });

          it("reports credits from committed decisions: the read is 0.25 once, the prepaid retry 0 (L2)", async () => {
            const t = tracked();
            const first = await runMaterializeRange(withOps("m1", t, embedDown), input("m1", [3]));
            expect(first.costCredits).toBeCloseTo(pageCredits("rich", 1), 9);
            const retry = await runMaterializeRange(t.depsFor("m2"), input("m2", [3]));
            expect(retry.indexed).toEqual([3]);
            expect(retry.costCredits).toBe(0);
            // The server sums page cost_credits deltas into creditsSpent: the prepaid page adds none.
            expect(await costOf()).toBe(0);
            // An empty read pays the page and keeps no text, so a Good retry reads it again with the model: that read is
            // provider usage, and the retry (and the page) report no credits for it.
            await db.exec(`delete from document_chunks; delete from document_pages; delete from document_page_states;
              delete from usage_events where run_id in ('m1', 'm2'); update workspace_runs set pipeline = '{"quality":"good"}' where id = 'm2'`);
            await reset();
            const empty = await runMaterializeRange(withOps("m1", t, {
              async ocrPage() { return { text: "  ", model: "vision-x", provider: "test", inputTokens: 100, outputTokens: 1, costCents: 1 }; },
            }), input("m1", [3]));
            expect(empty.costCredits).toBeCloseTo(pageCredits("rich", 1), 9);
            const reread = await runMaterializeRange(t.depsFor("m2"), input("m2", [3]));
            expect(reread.indexed).toEqual([3]);
            expect(reread.costCredits).toBe(0);
            expect(await costOf()).toBe(0);
            expect(await credits()).toBeCloseTo(pageCredits("rich", 1), 9);
            // A page this run decides Fast reports exactly the Fast charge, not its embedding cost.
            await db.exec(`update workspace_runs set pipeline = '{"quality":"auto"}' where id = 'm2'`);
            const fast = await runMaterializeRange(t.depsFor("m2"), input("m2", [5]));
            expect(fast.costCredits).toBeCloseTo(pageCredits("fast", 1), 9);
            expect(Number((await db.query<{ c: number }>(`select cost_credits::float8 as c from document_page_states where document_id = 'd1' and page_number = 5`)).rows[0]!.c))
              .toBeCloseTo(pageCredits("fast", 1), 9);
          });
        });
      });
    });

    it("two queries racing for the same scanned page charge it once", async () => {
      await reset();
      await Promise.all([runMaterializeRange(ocrDeps({ sleep: async () => {} }), input("m1", [3])), runMaterializeRange(ocrDeps({ sleep: async () => {} }), input("m2", [3]))]);
      const rows = await charges();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ metric: "ingest-page-rich", page: 3, amount: 1 });
    });

    it("a later full index charges neither the Rich-read page nor the Fast pages again", async () => {
      process.env.DOCSLURP_DEFERRED_PROFILES = "1";
      await reset();
      await db.exec(`
        delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';
        insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
          values ('fi', 'o1', 'u1', 'w', 'full-index', 'processing', 'extract', '{"indexingMode":"full"}', 1);
        insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, previous_version_id, indexing_mode)
          values ('d1-full', 'o1', 'u1', 'w', 'fi', 'c.pdf', 'application/pdf', 'k3', 'processing', 12, 'd1', 'full');`);
      try {
        await runMaterializeRange(ocrDeps(), input("m1", [3, 4]));
        await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("fi"), []));
        const fast = await db.query<{ amount: string }>(`select amount from usage_events where metric = 'ingest-page-fast' and run_id in ('m1', 'fi')`);
        expect(fast.rows.map((r) => Number(r.amount)).reduce((a, b) => a + b, 0)).toBe(11);
        const rich = await db.query<{ amount: string }>(`select amount from usage_events where metric = 'ingest-page-rich' and run_id in ('m1', 'fi')`);
        expect(rich.rows.map((r) => Number(r.amount))).toEqual([1]);
      } finally {
        delete process.env.DOCSLURP_DEFERRED_PROFILES;
        await db.exec(`delete from usage_events where run_id = 'fi'; delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';`);
      }
    });
  });

  it("a full index charges a page whose query stamp is stale instead of treating it as paid (round 5 I1)", async () => {
    process.env.DOCSLURP_DEFERRED_PROFILES = "1";
    await db.exec(`
      delete from usage_events where run_id in ('m1', 'fi'); delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('fi', 'o1', 'u1', 'w', 'full-index', 'processing', 'extract', '{"indexingMode":"full"}', 1);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, previous_version_id, indexing_mode)
        values ('d1-full', 'o1', 'u1', 'w', 'fi', 'c.pdf', 'application/pdf', 'k3', 'processing', 12, 'd1', 'full');`);
    try {
      await ensurePageRows(sql, "d1", 12);
      await db.exec(`update workspace_runs set status = 'processing' where id = 'm1'`);
      await runMaterializeRange(deps() as never, input("m1", [3]));
      // Page 4: stamped by m1, which charged nothing for it and then failed.
      await db.exec(`update document_page_states set state = 'indexed', materialized_by = 'query', fee_billed_run = 'm1' where document_id = 'd1' and page_number = 4;
        update workspace_runs set status = 'failed' where id = 'm1'`);
      const charges = await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("fi"), []));
      // 12 pages - page 3 (paid by the query) = 11 Fast; the stale page 4 is not treated as paid.
      expect(charges).toMatchObject({ fastPages: 11, richPages: 0 });
    } finally {
      delete process.env.DOCSLURP_DEFERRED_PROFILES;
      await db.exec(`delete from usage_events where run_id = 'fi'; delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';
        update workspace_runs set status = 'processing' where id = 'm1'`);
    }
  });

  it("a full index subtracts a query-paid page it read again only once (no page left unbilled)", async () => {
    process.env.DOCSLURP_DEFERRED_PROFILES = "1";
    await db.exec(`
      delete from usage_events where run_id in ('m1', 'fi'); delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('fi', 'o1', 'u1', 'w', 'full-index', 'processing', 'extract', '{"indexingMode":"full"}', 1);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, previous_version_id, indexing_mode)
        values ('d1-full', 'o1', 'u1', 'w', 'fi', 'c.pdf', 'application/pdf', 'k3', 'processing', 12, 'd1', 'full');`);
    try {
      await ensurePageRows(sql, "d1", 12);
      await runMaterializeRange(deps() as never, input("m1", [3, 4]));
      // The full index reads page 3 again with a model (charged Rich as it is read).
      await db.exec(`insert into usage_events (id, user_id, run_id, org_id, workspace_id, provider, model, metric, amount, unit, cost_cents, metadata)
        values ('rich:fi:d1-full:3', 'u1', 'fi', 'o1', 'w', 'docslurp', 'price-card', 'ingest-page-rich', 1, 'page', 0.25, '{"documentId":"d1-full","pageNumber":3}')`);
      const charges = await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("fi"), []));
      // 12 pages - page 4 (paid by the query, not read again) - page 3 (Rich read by this run) = 10 Fast.
      expect(charges).toMatchObject({ fastPages: 10, richPages: 0 });
    } finally {
      delete process.env.DOCSLURP_DEFERRED_PROFILES;
      await db.exec(`delete from usage_events where run_id = 'fi'; delete from documents where id = 'd1-full'; delete from workspace_runs where id = 'fi';`);
    }
  });

  it("reports pages still held after the wait budget as failed", async () => {
    await ensurePageRows(sql, "d1", 12);
    await claimPages(sql, { documentId: "d1", pages: [7], runId: "m2", ttlSeconds: 300, reason: "query" });
    const result = await runMaterializeRange(deps({ awaitTimeoutMs: 0 }) as never, input("m1", [7]));
    expect(result.indexed).toEqual([]);
    expect(result.failed).toEqual([{ page: 7, reason: "await-timeout" }]);
  });
});
