import { defaultPipelineFeatures, resetExtractorIdAliasesForTest } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { configureApiExtractorIdAliases } from "../routes/extractors.js";

/**
 * Stored configs that name a renamed extractor, read by the API with DOCSLURP_EXTRACTOR_ID_ALIASES set: the runs it
 * creates or starts carry the canonical id and keep the options, and the alias itself is checked at startup.
 */
const LEGACY = "legacy-pdf";
const ENV = { DOCSLURP_EXTRACTOR_ID_ALIASES: `${LEGACY}:vm-pdf`, DOCSLURP_VM_PDF_INSTALLED: "1" };
const legacy = {
  ...defaultPipelineFeatures,
  documentExtraction: {
    ...defaultPipelineFeatures.documentExtraction,
    order: { pdf: [LEGACY] },
    options: { [LEGACY]: { images: { enabled: true, minWidth: 20, minHeight: 30 } } },
    voting: { enabled: true, secondary: LEGACY },
  },
};

let sql: postgres.Sql;
let stop: () => Promise<void>;
let bulkReprocessDocuments: typeof import("../services/documents.js").bulkReprocessDocuments;
const startWorkflow = vi.fn(async (..._args: unknown[]) => {});

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { resetExtractorIdAliasesForTest(); vi.restoreAllMocks(); startWorkflow.mockClear(); });

describe("API startup with DOCSLURP_EXTRACTOR_ID_ALIASES", () => {
  it("refuses an alias to vm-pdf when the API does not list it", () => {
    expect(() => configureApiExtractorIdAliases({ DOCSLURP_EXTRACTOR_ID_ALIASES: `${LEGACY}:vm-pdf` })).toThrow(/does not serve/);
  });

  it("refuses an unknown target and an alias over a built-in id", () => {
    expect(() => configureApiExtractorIdAliases({ ...ENV, DOCSLURP_EXTRACTOR_ID_ALIASES: `${LEGACY}:no-such-extractor` })).toThrow(/does not serve/);
    expect(() => configureApiExtractorIdAliases({ ...ENV, DOCSLURP_EXTRACTOR_ID_ALIASES: "poppler-text:vm-pdf" })).toThrow(/may not override/);
  });

  it("installs a valid alias", () => {
    expect(configureApiExtractorIdAliases(ENV)).toEqual(new Map([[LEGACY, "vm-pdf"]]));
  });
});

describe("stored legacy-id pipelines under the alias", () => {
  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    stop = pg.stop;
    sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql }));
    vi.doMock("../lib/temporal.js", () => ({
      startPipelineWorkflow: startWorkflow, signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
      isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
    }));
    ({ bulkReprocessDocuments } = await import("../services/documents.js"));
    await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
    await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values ('o', 'O', 'o', 'u', 1000)`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
    await sql`insert into workspaces (id, org_id, user_id, name, pipeline) values ('w', 'o', 'u', 'W', ${sql.json(legacy as unknown as postgres.JSONValue)})`;
  }, 120_000);

  afterAll(async () => { await sql?.end(); await stop?.(); });

  beforeEach(async () => {
    configureApiExtractorIdAliases(ENV);
    await sql`delete from documents`;
    await sql`delete from workspace_runs`;
  });

  const canonical = (pipeline: unknown) => {
    const text = JSON.stringify(pipeline);
    expect(text).not.toContain(LEGACY);
    expect((pipeline as typeof legacy).documentExtraction).toMatchObject({
      order: { pdf: ["vm-pdf"] }, voting: { secondary: "vm-pdf" }, options: { "vm-pdf": { images: { enabled: true, minWidth: 20, minHeight: 30 } } },
    });
  };

  it("reprocessing a document from a pre-deploy run writes the new run with the canonical id and keeps its options", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await sql`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run-old', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', ${sql.json(legacy as unknown as postgres.JSONValue)}, 1, 2)`;
    await sql`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('d', 'o', 'u', 'w', 'run-old', 'd.pdf', 'application/pdf', 'u/raw/d.pdf', 'completed', 2)`;
    const result = await bulkReprocessDocuments(["d"], "u");
    expect(result.failed).toEqual([]);
    const [row] = await sql<{ pipeline: unknown }[]>`select pipeline from workspace_runs where id = ${result.runs[0]!.id}`;
    canonical(row!.pipeline);
    canonical(startWorkflow.mock.calls[0]![1]);
    // Nothing was dropped: the options moved to the canonical key instead.
    expect(errors).not.toHaveBeenCalled();
  });

  it("a run queued before the deploy starts with the canonical id", async () => {
    await sql`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, creation_ready_at)
      values ('q-old', 'o', 'u', 'w', 'bulk-upload', 'queued', 'queued', ${sql.json(legacy as unknown as postgres.JSONValue)}, 0, now())`;
    const { createRunLifecycle } = await import("../services/run-lifecycle.js");
    const { createRunStartRecovery } = await import("../services/run-start-recovery.js");
    const lifecycle = createRunLifecycle({ sql: sql as never, startWorkflow, failureThreshold: 3 });
    const recovery = createRunStartRecovery({ sql: sql as never, lifecycle, config: { batchSize: 25, leaseMs: 30_000 } });
    expect(await recovery.sweepOnce({ ignoreBackoff: true })).toMatchObject({ claimed: 1, started: 1, failed: 0 });
    expect(startWorkflow.mock.calls[0]![0]).toBe("q-old");
    canonical(startWorkflow.mock.calls[0]![1]);
  });

  it("reprocessing a run whose stored pipeline names host PDF parsers, on a vm-pdf deployment, carries none of them", async () => {
    vi.stubEnv("DOCSLURP_VM_PDF_INSTALLED", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const host = { ...defaultPipelineFeatures, documentExtraction: { ...defaultPipelineFeatures.documentExtraction,
        order: { pdf: ["poppler-text", "native-pdf"] }, pages: ["ocr"], enrich: ["poppler-text"], voting: { enabled: true, secondary: "native-pdf" } } };
      await sql`
        insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-host', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', ${sql.json(host as unknown as postgres.JSONValue)}, 1, 2)`;
      await sql`
        insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
        values ('dh', 'o', 'u', 'w', 'run-host', 'dh.pdf', 'application/pdf', 'u/raw/dh.pdf', 'completed', 2)`;
      const result = await bulkReprocessDocuments(["dh"], "u");
      expect(result.failed).toEqual([]);
      const [row] = await sql<{ pipeline: { documentExtraction: Record<string, unknown> } }[]>`select pipeline from workspace_runs where id = ${result.runs[0]!.id}`;
      for (const pipeline of [row!.pipeline, startWorkflow.mock.calls[0]![1] as typeof row.pipeline]) {
        expect(JSON.stringify(pipeline.documentExtraction)).not.toMatch(/poppler-text|native-pdf/);
        expect({ pages: pipeline.documentExtraction.pages, enrich: pipeline.documentExtraction.enrich, voting: pipeline.documentExtraction.voting }).toEqual({ pages: [], enrich: [], voting: { enabled: true, secondary: "next-in-order" } });
        expect((pipeline.documentExtraction.order as Record<string, unknown>).pdf).toBeUndefined();
      }
    } finally { vi.unstubAllEnvs(); }
  });
});
