import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Sql } from "postgres";
import { defaultPipelineFeatures, pageCredits } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { recordMaterializedPageFee, recordPageBaseFee } from "../db/page-base-fee.js";
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
    expect(await recordMaterializedPageFee(sql, "m1", "d1", [10, 11], { richPages: new Set([10, 11]) })).toBe(0);
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
          if (!competitor && args[0].join("?").includes("select id, org_id, user_id")) {
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

    it("a concurrent query cannot charge a page Fast while the run that read it is still writing its charge", async () => {
      await reset();
      // m1 has marked page 3 indexed (which reserves its billing decision) but not yet written its charges.
      await claimPages(sql, { documentId: "d1", pages: [3], runId: "m1", ttlSeconds: 300, reason: "query" });
      await markPages(sql, "d1", [3], "indexed", { feeRun: "m1" });
      await runMaterializeRange(ocrDeps(), input("m2", [3]));
      const ledger = new PipelineUsageEventLedger();
      ledger.runId = "m1";
      ledger.chargeRichPage({ documentId: "d1", pageNumber: 3, readBy: "page-analysis" });
      expect(await recordMaterializedPageFee(sql, "m1", "d1", [3], { ledger })).toBeCloseTo(pageCredits("rich", 1), 9);
      expect(ledger.pendingCount).toBe(0);
      expect(await charges()).toEqual([{ run_id: "m1", metric: "ingest-page-rich", page: 3, amount: 1 }]);
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

  it("reports pages still held after the wait budget as failed", async () => {
    await ensurePageRows(sql, "d1", 12);
    await claimPages(sql, { documentId: "d1", pages: [7], runId: "m2", ttlSeconds: 300, reason: "query" });
    const result = await runMaterializeRange(deps({ awaitTimeoutMs: 0 }) as never, input("m1", [7]));
    expect(result.indexed).toEqual([]);
    expect(result.failed).toEqual([{ page: 7, reason: "await-timeout" }]);
  });
});
