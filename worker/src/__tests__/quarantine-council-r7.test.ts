import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { compilePipelinePlan, defaultPipelineFeatures, pipelineStageOrder, quarantineReasonOf, type PipelineFeatures } from "@docslurp/shared";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import { materializePageRange } from "../deferred/materialize-pages.js";
import { renderDocumentPage } from "../deferred/render-page.js";
import { inspectArchive, inspectQuarantineBytes } from "../lib/quarantine-bytes.js";
import { assertParseSourceDecided, originalSourceForQuarantine, PARSE_SOURCE_SCAN_VERSION, resolveDocumentSource, UnscannedParseSourceError, unscannedParseSourceKey } from "../lib/parse-source.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import { PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createStageExecution, loadRunState } from "../pipeline/stage-execution.js";
import { readSourceBytes, resetStagedSourcesForTests, sha256Bytes, stageSourceFile, verifyQuarantineUpload, verifyStagedSource } from "../sandbox/source-integrity.js";
import { QuarantineStage } from "../stages/quarantine.js";
import { resolvePipelineWorkflowStageOrder } from "../temporal/pipeline-workflow-plan.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import type { CommandRunner } from "../tools/runner.js";
import { sourceStorageKey, type ArtifactStore } from "../tools/storage.js";

/**
 * PR #339 council round 7. R7-H1: a document with no parse decision from this build (every document quarantined before
 * it, and every reprocess that reused another run's quarantine) was parsed from its original. Now quarantine re-runs in
 * every partial plan and records its own decision and copy, and nothing parses a document without one: the pipeline,
 * the page renderer, materialization, staging and storage all refuse it. R7-C1: a reprocess no longer points at the source
 * run's copy, which that run's retention purges. R7-L1: a pax global `size` record is refused. R7-L2: the loader keeps the
 * upload's key off the document, so a reader cannot reach it by building a property name.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;
let dir: string;

const fixtures = fileURLToPath(new URL("../../testdata/clam-encrypted/", import.meta.url));
/** The round-6 attack file: a linearized encrypted PDF whose first-page section shows poppler a page qpdf never resolves. */
const attackPdf = readFileSync(path.join(fixtures, "r6-lin-o6-S.pdf"));
const scannedCopy = Buffer.from("%PDF-1.7\n% qpdf --decrypt --qdf copy: the pages the scan read\n");
const config = {
  workerDocConcurrency: 1, workerAdaptiveTuning: false,
  quarantineEnabled: true, quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 3,
  quarantineMaxTotalUncompressedBytes: 1 << 20, quarantineMaxSingleEntryBytes: 1 << 20, quarantineMaxExpansionRatio: 10,
} as Config;
const clean = { status: "clean", engine: "clamscan", signature: null, databaseStatus: "fresh", healthWarnings: [] };

/** In-memory object store recording every read, with the download semantics of the real one (a directory per download). */
function memoryStorage(objects: Map<string, Buffer>) {
  const reads: string[] = [];
  let sequence = 0;
  const read = (key: string) => {
    sourceStorageKey(key); // the real store's key validation: refuses the unscanned key by name
    reads.push(key);
    const bytes = objects.get(key);
    if (!bytes) throw Object.assign(new Error(`NoSuchKey: ${key}`), { name: "NoSuchKey" });
    return bytes;
  };
  const toTemp = async (key: string) => {
    const bytes = read(key);
    const folder = path.join(dir, `docslurp-${sequence++}`);
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "source");
    await writeFile(file, bytes);
    return file;
  };
  const storage = {
    bucket: "b",
    downloadSourceToTempFile: toTemp,
    downloadToTempFile: toTemp,
    getBytes: async (key: string) => read(key),
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putArtifactJson: async () => {},
    deleteKeys: async (keys: string[]) => { for (const key of keys) objects.delete(key); },
    uri: (key: string) => `s3://b/${key}`,
  } as unknown as ArtifactStore;
  return { storage, reads, objects };
}

/** The in-VM decryption, faked: the copy the scan reads. */
function quarantineRunner(): CommandRunner {
  return {
    scanForMalware: async () => clean,
    decryptPdfForScan: async (_source: string, outputDir: string) => {
      const output = path.join(outputDir, "decrypted.pdf");
      await writeFile(output, scannedCopy);
      return { status: "decrypted", path: output, bytes: scannedCopy.length, ms: 3, encrypted: true };
    },
  } as unknown as CommandRunner;
}

/** The real quarantine stage, and for every later stage a parser that stages its source (hash-checked) and logs what it read. */
function pipelineStages(storage: ArtifactStore, runner: CommandRunner = quarantineRunner()) {
  const executed: string[] = [];
  const parsed: Array<{ stage: string; key: string; bytes: Buffer }> = [];
  const stages: Stage[] = pipelineStageOrder.map((name) => name === "quarantine"
    ? new QuarantineStage(runner, storage, config)
    : {
      name,
      async run(state, signal) {
        executed.push(name);
        await runDocuments(state.documents, 1, async (document) => {
          await runDocumentStage(state, document, name, `${document.id}:${name === "embed" ? "embeddings" : name}`, `${name} ready`, async () => {
            const staged = await stageSourceFile(storage, document, "x");
            parsed.push({ stage: name, key: document.sourceKey, bytes: await readFile(staged) });
            return { artifactUri: `s3://b/u1/${state.run.id}/${name}/${document.id}` };
          }, signal);
        });
      },
    });
  return { stages, executed, parsed };
}

async function runWorkflow(stages: Stage[], pipeline: PipelineFeatures, runId: string) {
  const stageOrder = resolvePipelineWorkflowStageOrder({ stageOrder: compilePipelinePlan(pipeline).stageOrder });
  const execution = createStageExecution({ store, stages, config });
  const runtime = { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, heartbeatIntervalMs: 3_600_000 };
  let { artifacts } = await execution.startRun({ runId, executionGeneration: "test-generation", totalStages: stageOrder.length });
  for (const stageName of stageOrder) {
    const result = await execution.runStage({ stageName, runId, totalStages: stageOrder.length, artifacts }, runtime);
    artifacts = { ...artifacts, ...result.artifacts };
  }
  await execution.completeRun({ runId, executionGeneration: "test-generation" });
  return { stageOrder };
}

const pipeline = { ...defaultPipelineFeatures, pageIndex: true };
const ORIGINAL_SHA = sha256Bytes(attackPdf);

/**
 * A completed source run quarantined by an earlier build: its quarantine stats say the PDF was decrypted and scanned clean,
 * but no parse decision or copy was recorded (what every production document looks like at deploy).
 */
async function seedLegacySourceRun() {
  await sql`
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, artifacts, total_documents, pages_total)
    values ('run-src', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed', ${sql.json(pipeline as unknown as postgres.JSONValue)},
      ${sql.json({ "src:markdown": "s3://b/u1/run-src/markdown/src.md", "src:normalizedFormat": "pdf" })}, 1, 2)
  `;
  await sql`
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, source_sha256, status, page_count)
    values ('src', 'o1', 'u1', 'w', 'run-src', 'board-pack.pdf', 'application/pdf', 'raw/a.pdf', ${ORIGINAL_SHA}, 'completed', 2)
  `;
  for (const stage of compilePipelinePlan(pipeline).stageOrder) {
    const stats = stage === "quarantine" ? { pdfDecryptionStatus: "decrypted", pdfDecryptedCopyStatus: "clean" } : {};
    await sql`
      insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, artifact_uri, stats, completed_at)
      values ('run-src', 'src', ${stage}, 'completed', 1, ${`s3://b/u1/run-src/${stage}/src`}, ${sql.json(stats)}, now())
    `;
  }
}

async function seedReprocess(features: PipelineFeatures) {
  await sql`
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total, execution_generation)
    values ('run-re', 'o1', 'u1', 'w', 'bulk-upload', 'queued', 'queued', ${sql.json(features as unknown as postgres.JSONValue)}, 1, 2, 'test-generation')
  `;
  await sql`
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, source_sha256, status, page_count,
      previous_version_id, reused_from_document_id)
    values ('re', 'o1', 'u1', 'w', 'run-re', 'board-pack.pdf', 'application/pdf', 'raw/a.pdf', ${ORIGINAL_SHA}, 'queued', 2, 'src', 'src')
  `;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "quarantine-council-r7-"));
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 10000);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("QUARANTINE_ENABLED", "true");
  vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_SNAPSHOT", "off");
  resetStagedSourcesForTests();
  await sql`delete from usage_events`;
  await sql`delete from document_page_states`;
  await sql`delete from document_chunks`;
  await sql`delete from document_pages`;
  await sql`delete from document_run_stage_states`;
  await sql`delete from documents`;
  await sql`delete from project_runs`;
  return () => { vi.unstubAllEnvs(); };
});

describe("R7-H1: a reprocess re-runs quarantine and parses its own scanned copy, never the original", () => {
  it("restartFromStage format-detect on a document quarantined by an earlier build: quarantine runs, every stage parses this run's copy", async () => {
    await seedLegacySourceRun();
    const features = { ...pipeline, restartFromStage: "format-detect" };
    await seedReprocess(features);
    const { storage, reads, objects } = memoryStorage(new Map([["raw/a.pdf", attackPdf]]));
    const { stages, executed, parsed } = pipelineStages(storage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { stageOrder } = await runWorkflow(stages, features, "run-re").finally(() => warn.mockRestore());

    // Quarantine is never reused: the plan runs it first.
    expect(stageOrder[0]).toBe("quarantine");
    expect(compilePipelinePlan(features).reusedStages).not.toContain("quarantine");
    const copyKey = "u1/run-re/quarantine/re.scanned.pdf";
    expect(objects.get(copyKey)).toEqual(scannedCopy);
    // Every executed parse stage read this run's copy, by its key and its bytes; the upload was read once, by quarantine.
    expect(executed.length).toBeGreaterThan(3);
    expect(new Set(parsed.map((read) => read.key))).toEqual(new Set([copyKey]));
    for (const read of parsed) expect(read.bytes).toEqual(scannedCopy);
    expect(reads.filter((key) => key === "raw/a.pdf")).toHaveLength(1);
    const [row] = await sql<{ parse_source_key: string | null; parse_source_scan_version: number | null }[]>`
      select parse_source_key, parse_source_scan_version from documents where id = 're'`;
    expect(row).toEqual({ parse_source_key: copyKey, parse_source_scan_version: 1 });
    const [state] = await sql<{ reused: boolean }[]>`
      select coalesce((stats->>'reused')::boolean, false) as reused from document_run_stage_states
      where run_id = 'run-re' and document_id = 're' and stage_name = 'quarantine'`;
    expect(state?.reused).toBe(false);
  }, 60_000);

  it("R7-C1: the reprocessed document keeps its own copy after the source run's retention purge", async () => {
    await seedLegacySourceRun();
    const features = { ...pipeline, stageSubset: ["page-index"] };
    await seedReprocess(features);
    const { storage, objects } = memoryStorage(new Map([["raw/a.pdf", attackPdf]]));
    const { stages } = pipelineStages(storage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runWorkflow(stages, features, "run-re").finally(() => warn.mockRestore());

    // The source run expires and its artifacts (and any copy of its own) are purged while the reprocess lives on.
    await sql`update projects set artifact_retention_days = 1 where id = 'w'`;
    await sql`update project_runs set created_at = now() - interval '10 days' where id = 'run-src'`;
    const deleted: string[] = [];
    const purgeStorage = { bucket: "b", deleteKeys: async (keys: string[]) => { deleted.push(...keys); for (const key of keys) objects.delete(key); } } as unknown as ArtifactStore;
    try {
      await (store as unknown as { purgeExpiredArtifacts(storage: ArtifactStore, batchSize: number): Promise<void> }).purgeExpiredArtifacts(purgeStorage, 10);
    } finally {
      await sql`update projects set artifact_retention_days = null where id = 'w'`;
    }
    expect(deleted).toContain("u1/run-src/markdown/src.md");
    expect(deleted.some((key) => key.startsWith("u1/run-re/"))).toBe(false);

    // Deferred materialization and page renders load the document by id: they stage this run's copy, still there.
    const document = await store.loadDocument("re");
    expect(document.sourceKey).toBe("u1/run-re/quarantine/re.scanned.pdf");
    const sources = new PdfSourceCache(storage);
    const cached = await sources.get(document);
    expect(await readFile(cached.path)).toEqual(scannedCopy);
    await sources.clear();
  }, 60_000);

  it("a pipeline stage refuses a document with no decision; a completed quarantine from an earlier build re-runs and decides it", async () => {
    await sql`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, execution_generation)
      values ('run-old', 'o1', 'u1', 'w', 'upload', 'processing', 'format-detect', '{}', 1, null)`;
    await sql`
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, source_sha256, status, page_count)
      values ('old', 'o1', 'u1', 'w', 'run-old', 'board-pack.pdf', 'application/pdf', 'raw/a.pdf', ${ORIGINAL_SHA}, 'processing', 2)`;
    // An in-flight run whose quarantine finished on the earlier build: completed checkpoint, no decision.
    await sql`
      insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, artifact_uri, stats, completed_at)
      values ('run-old', 'old', 'quarantine', 'completed', 1, 's3://b/u1/run-old/quarantine/old.json', '{}'::jsonb, now())`;
    const { storage, reads } = memoryStorage(new Map([["raw/a.pdf", attackPdf]]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A parse stage first (a stage loop resumed past quarantine): the document fails with the public rescan reason.
      const state = await loadRunState(store, "run-old", { totalStages: 2 });
      expect(state.documents[0]?.parseSourceDecision).toBe("unscanned");
      let ran = false;
      await runDocumentStage(state, state.documents[0]!, "format-detect", "old:normalizedFormat", "x", async () => { ran = true; return { artifactUri: "" }; });
      expect(ran).toBe(false);
      const failure = state.documentStage("old", "format-detect");
      expect(failure?.status).toBe("failed");
      expect(quarantineReasonOf(failure?.error)).toBe("quarantine-rescan-required");
      expect(reads).toEqual([]);

      // Quarantine over its earlier build's completed checkpoint runs again and records a decision.
      await sql`delete from document_run_stage_states where document_id = 'old' and stage_name = 'format-detect'`;
      const again = await loadRunState(store, "run-old", { totalStages: 2 });
      await new QuarantineStage(quarantineRunner(), storage, config).run(again);
      expect(reads).toEqual(["raw/a.pdf"]);
      expect(again.documents[0]).toMatchObject({ parseSourceDecision: "scanned-copy", sourceKey: "u1/run-old/quarantine/old.scanned.pdf" });
      expect((await store.loadDocument("old")).parseSourceDecision).toBe("scanned-copy");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }, 60_000);
});

describe("R7-H1: a document quarantined before this build is never read by the page renderer or materialization", () => {
  beforeEach(async () => {
    await sql`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents)
      values ('run-legacy', 'o1', 'u1', 'w', 'upload', 'completed', 'completed', ${sql.json(pipeline as unknown as postgres.JSONValue)}, 1)`;
    await sql`
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, source_sha256, status, page_count)
      values ('legacy', 'o1', 'u1', 'w', 'run-legacy', 'board-pack.pdf', 'application/pdf', 'raw/legacy.pdf', ${ORIGINAL_SHA}, 'completed', 2)`;
  });

  it("the loader hands out no readable key and never the upload's", async () => {
    const document = await store.loadDocument("legacy");
    expect(document.parseSourceDecision).toBe("unscanned");
    expect(JSON.stringify(document)).not.toContain("raw/legacy.pdf");
    for (const key of Reflect.ownKeys(document)) expect(String((document as unknown as Record<PropertyKey, unknown>)[key])).not.toContain("raw/legacy.pdf");
    expect(() => assertParseSourceDecided(document)).toThrow(UnscannedParseSourceError);
    // Storage refuses the key by name, whatever path a reader took to it.
    expect(() => sourceStorageKey(document.sourceKey)).toThrow(UnscannedParseSourceError);
    // Quarantine alone reaches the upload.
    expect(originalSourceForQuarantine(document).sourceKey).toBe("raw/legacy.pdf");
  });

  it("render-page refuses it, final, before any storage read", async () => {
    const { storage, reads } = memoryStorage(new Map([["raw/legacy.pdf", attackPdf]]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(renderDocumentPage({ store, storage, runner: {} as CommandRunner }, { documentId: "legacy", runId: "run-legacy", pageNumber: 1, quality: "reader" } as never))
        .rejects.toMatchObject({ type: "ParseSourceUnscanned", nonRetryable: true });
    } finally {
      error.mockRestore();
    }
    expect(reads).toEqual([]);
  });

  it("materialization fails its pages as source-unscanned before any storage read", async () => {
    const { storage, reads } = memoryStorage(new Map([["raw/legacy.pdf", attackPdf]]));
    // Pages this run claimed (the activity claims before materializing).
    await sql`insert into document_page_states (document_id, page_number, state, claimed_by_run, claim_expires_at)
      values ('legacy', 1, 'claimed', 'run-legacy', now() + interval '5 minutes'), ('legacy', 2, 'claimed', 'run-legacy', now() + interval '5 minutes')`;
    const document = await store.loadDocument("legacy");
    const run = (await loadRunState(store, "run-legacy", { totalStages: 1 })).run;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await materializePageRange(
        { sql, store, storage, runner: {} } as never,
        { documentId: "legacy", runId: "run-legacy", pages: [1, 2], reason: "query", document, pipeline, run } as never,
      );
      expect(result.failed).toEqual([{ page: 1, reason: "source-unscanned" }, { page: 2, reason: "source-unscanned" }]);
    } finally {
      error.mockRestore();
    }
    expect(reads).toEqual([]);
    const pages = await sql<{ state: string; failure_reason: string | null }[]>`
      select state, failure_reason from document_page_states where document_id = 'legacy' order by page_number`;
    expect(pages).toEqual([{ state: "failed", failure_reason: "source-unscanned" }, { state: "failed", failure_reason: "source-unscanned" }]);
  });

  it("the PDF source cache and hash-bound staging refuse it without reading", async () => {
    const { storage, reads } = memoryStorage(new Map([["raw/legacy.pdf", attackPdf]]));
    const document = await store.loadDocument("legacy");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(new PdfSourceCache(storage).get(document)).rejects.toBeInstanceOf(UnscannedParseSourceError);
      await expect(stageSourceFile(storage, document, "x")).rejects.toBeInstanceOf(UnscannedParseSourceError);
      await expect(readSourceBytes(storage, document)).rejects.toBeInstanceOf(UnscannedParseSourceError);
      // A copy of the document (serialized, spread) loses the upload binding: quarantine fails rather than read its key.
      expect(() => originalSourceForQuarantine({ ...document })).toThrow(/no upload binding/);
    } finally {
      error.mockRestore();
    }
    expect(reads).toEqual([]);
  });
});

describe("R7-L2: no reader reaches the upload by building a name at runtime", () => {
  it("a loaded document with a scanned copy carries neither the upload's key nor a property that names it", async () => {
    await sql`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents)
      values ('run-copy', 'o1', 'u1', 'w', 'upload', 'completed', 'completed', '{}', 1)`;
    await sql`
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, source_sha256, status, page_count,
        parse_source_key, parse_source_sha256, parse_source_scan_version)
      values ('copy', 'o1', 'u1', 'w', 'run-copy', 'board-pack.pdf', 'application/pdf', 'raw/copy.pdf', ${ORIGINAL_SHA}, 'completed', 2,
        'u1/run-copy/quarantine/copy.scanned.pdf', ${sha256Bytes(scannedCopy)}, 1)`;
    const document = await store.loadDocument("copy");
    const record = document as unknown as Record<string, unknown>;
    // The reviewer's probe: names assembled at runtime find nothing.
    expect(record[["orig", "inalSour", "ceKey"].join("")]).toBeUndefined();
    expect(record[["source", "key"].join("_")]).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain("raw/copy.pdf");
    expect(Object.getOwnPropertySymbols(document)).toEqual([]);
    expect(document.sourceKey).toBe("u1/run-copy/quarantine/copy.scanned.pdf");
  });

  it("format-detect reads its source only through hash-bound staging; only quarantine downloads an upload", async () => {
    // A tripwire for the read path R7-L2 named: every other staged read is hash-checked against the decided source.
    const root = fileURLToPath(new URL("../", import.meta.url));
    const formatDetect = await readFile(path.join(root, "stages/format-detect.ts"), "utf8");
    expect(formatDetect).not.toMatch(/storage\.(getBytes|downloadSourceToTempFile|downloadToTempFile)\(/);
    expect(formatDetect).toMatch(/stageSourceFile\(/);
    expect(formatDetect).toMatch(/readSourceBytes\(/);
    const offenders: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "__tests__" && entry.name !== "test") await walk(full); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const relative = path.relative(root, full).split(path.sep).join("/");
        if (relative === "tools/storage.ts") continue;
        if (/\.downloadSourceToTempFile\(/.test(await readFile(full, "utf8")) && relative !== "stages/quarantine.ts") offenders.push(relative);
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("R7-L1: a pax global size record is refused", () => {
  const policy = {
    quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 2_000, quarantineMaxArchiveDepth: 12,
    quarantineMaxTotalUncompressedBytes: 512 * 1024 * 1024, quarantineMaxSingleEntryBytes: 128 * 1024 * 1024, quarantineMaxExpansionRatio: 250,
  } as const;
  it("r7-tar-pax-global-size.xlsx (Python's tarfile extracts a ZIP the header sizes hide): refused", () => {
    const bytes = readFileSync(path.join(fixtures, "r7-tar-pax-global-size.xlsx"));
    expect(inspectArchive(bytes, "q3.xlsx", policy)?.issues).toEqual(["archive-nested-inspection-failed"]);
  });
});

describe("R8-L1: an 'original' decision binds parsers to the bytes quarantine scanned, with or without a server hash", () => {
  async function seedNullHashRow() {
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, execution_generation)
      values ('run-swap', 'o1', 'u1', 'w', 'upload', 'processing', 'quarantine', '{}', 1, null)`;
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, source_sha256, status, page_count)
      values ('swap', 'o1', 'u1', 'w', 'run-swap', 'notes.pdf', 'application/pdf', 'raw/swap.pdf', null, 'processing', 1)`;
  }
  const benign = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const plainRunner = { scanForMalware: async () => clean, decryptPdfForScan: async () => ({ status: "not-encrypted", encrypted: false }) } as unknown as CommandRunner;

  it("council P5: a legacy row with no source_sha256, scanned clean, then the object swapped: staging refuses the swapped bytes", async () => {
    await seedNullHashRow();
    const objects = new Map([["raw/swap.pdf", benign]]);
    const { storage } = memoryStorage(objects);
    const quiet = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
    try {
      const scanned = await loadRunState(store, "run-swap", { totalStages: 2 });
      await new QuarantineStage(plainRunner, storage, config).run(scanned);
      expect(scanned.documentStage("swap", "quarantine")?.status).toBe("completed");
      const [row] = await sql`select parse_source_key, parse_source_sha256, parse_source_scan_version from documents where id = 'swap'`;
      expect(row).toEqual({ parse_source_key: null, parse_source_sha256: sha256Bytes(benign), parse_source_scan_version: 1 });

      objects.set("raw/swap.pdf", Buffer.from("%PDF-1.4\n% SWAPPED AFTER SCAN\n%%EOF\n"));
      resetStagedSourcesForTests();
      const later = await loadRunState(store, "run-swap", { totalStages: 2 });
      expect(later.documents[0]).toMatchObject({ parseSourceDecision: "original", sourceKey: "raw/swap.pdf", sourceSha256: sha256Bytes(benign) });
      await expect(stageSourceFile(storage, later.documents[0]!, "x")).rejects.toMatchObject({ name: "SourceIntegrityError" });
      await expect(readSourceBytes(storage, later.documents[0]!)).rejects.toMatchObject({ name: "SourceIntegrityError" });

      // The unswapped bytes still parse.
      objects.set("raw/swap.pdf", benign);
      resetStagedSourcesForTests();
      await expect(stageSourceFile(storage, later.documents[0]!, "x")).resolves.toEqual(expect.any(String));
    } finally {
      quiet.forEach((q) => q.mockRestore());
    }
  }, 60_000);

  it("a current decision without a hash (an interim row), or whose hash is not the upload's, is unscanned and re-quarantines", async () => {
    await seedNullHashRow();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // An interim row (written before 0135 nulled such decisions; the schema now refuses it): resolved, not loaded.
      expect(resolveDocumentSource({ id: "swap", source_key: "raw/swap.pdf", source_sha256: null, parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION }))
        .toEqual({ sourceKey: unscannedParseSourceKey("swap"), sourceSha256: null, parseSourceDecision: "unscanned" });
      await sql`update documents set source_sha256 = ${"e".repeat(64)}, parse_source_sha256 = ${sha256Bytes(benign)}, parse_source_scan_version = 1 where id = 'swap'`;
      expect((await store.loadDocument("swap")).parseSourceDecision).toBe("unscanned");
    } finally {
      quiet.mockRestore();
    }
    // The schema refuses a decision without a scanned-bytes hash for new writes (migration 0135).
    await sql`update documents set source_sha256 = null, parse_source_sha256 = null, parse_source_scan_version = null where id = 'swap'`;
    await expect(sql`update documents set parse_source_scan_version = 1 where id = 'swap'`).rejects.toThrow(/documents_parse_source_hash_check/);
    await expect(sql`update documents set parse_source_scan_version = 1, parse_source_sha256 = 'not-a-hash' where id = 'swap'`).rejects.toThrow(/documents_parse_source_hash_check/);
    await expect(store.setDocumentParseSource("run-swap", "swap", { copy: null, scannedSha256: "" })).rejects.toThrow(/sha256 of the bytes it scanned/);
  });
});

describe("I-1: a document object not built by the loader is unscanned in production", () => {
  it("staging, the PDF source cache and the decision gate refuse an object without a decision field", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { storage, reads } = memoryStorage(new Map([["raw/a.pdf", attackPdf]]));
    const adhoc = { id: "adhoc", sourceKey: "raw/a.pdf", sourceSha256: ORIGINAL_SHA } as never;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(stageSourceFile(storage, adhoc, "x")).rejects.toBeInstanceOf(UnscannedParseSourceError);
      await expect(readSourceBytes(storage, adhoc)).rejects.toBeInstanceOf(UnscannedParseSourceError);
      await expect(new PdfSourceCache(storage).get(adhoc)).rejects.toBeInstanceOf(UnscannedParseSourceError);
      expect(() => assertParseSourceDecided(adhoc)).toThrow(UnscannedParseSourceError);
      expect(() => originalSourceForQuarantine(adhoc)).toThrow(/no upload binding/);
    } finally {
      error.mockRestore();
    }
    expect(reads).toEqual([]);
  });
});

/**
 * Production regression (app deploy rolled back): every upload was refused at quarantine with parse-source-unscanned.
 * The stage verified the upload with verifyStagedSource, whose decision gate treats an object without a decision field as
 * unscanned under NODE_ENV=production (I-1), and originalSourceForQuarantine returns exactly such an object. Every other
 * test here stubs NODE_ENV=test, so none ran the production branch. These run the real stage under NODE_ENV=production.
 */
describe("production: quarantine decides a fresh upload under NODE_ENV=production", () => {
  const benign = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  /**
   * Production inspects the bytes in the parser VM (lib/quarantine.ts inspectInVm, through runner.run). The fake VM runs
   * what the guest's quarantine-inspect.mjs runs and refuses any other command, so nothing else parses on the "host".
   */
  function inVm(runner: CommandRunner): CommandRunner {
    const run = async (plan: { binary: string; args: string[] }) => {
      if (plan.binary !== "node" || !plan.args[0]?.endsWith("quarantine-inspect.mjs")) throw new Error(`unexpected VM command ${plan.binary} ${plan.args[0]}`);
      const options = JSON.parse(await readFile(plan.args[2]!, "utf8")) as { filename: string; policy: Parameters<typeof inspectQuarantineBytes>[2] };
      await writeFile(plan.args[3]!, JSON.stringify(inspectQuarantineBytes(await readFile(plan.args[1]!), options.filename, options.policy)));
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    return Object.assign(Object.create(runner) as CommandRunner, { run });
  }
  const plainRunner = inVm({ scanForMalware: async () => clean, decryptPdfForScan: async () => ({ status: "not-encrypted", encrypted: false }) } as unknown as CommandRunner);

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  async function seedFreshUpload(id: string, key: string, sha: string | null, features: PipelineFeatures = pipeline) {
    await sql`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total, execution_generation)
      values (${`run-${id}`}, 'o1', 'u1', 'w', 'upload', 'queued', 'queued', ${sql.json(features as unknown as postgres.JSONValue)}, 1, 1, 'test-generation')`;
    await sql`
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, source_sha256, status, page_count)
      values (${id}, 'o1', 'u1', 'w', ${`run-${id}`}, 'upload.pdf', 'application/pdf', ${key}, ${sha}, 'queued', 1)`;
  }

  async function decisionRow(id: string) {
    const [row] = await sql<{ parse_source_key: string | null; parse_source_sha256: string | null; parse_source_scan_version: number | null }[]>`
      select parse_source_key, parse_source_sha256, parse_source_scan_version from documents where id = ${id}`;
    return row;
  }

  function quiet() {
    const spies = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
    return () => spies.forEach((spy) => spy.mockRestore());
  }

  it("a plain upload: quarantine completes, records an 'original' decision, and the loaded document is unscanned before it", async () => {
    await seedFreshUpload("fresh", "raw/fresh.pdf", sha256Bytes(benign));
    const { storage, reads } = memoryStorage(new Map([["raw/fresh.pdf", benign]]));
    const restore = quiet();
    try {
      const state = await loadRunState(store, "run-fresh", { totalStages: 2 });
      // The production loader: a fresh upload has no decision until quarantine records one.
      expect(state.documents[0]?.parseSourceDecision).toBe("unscanned");
      await new QuarantineStage(plainRunner, storage, config).run(state);
      const checkpoint = state.documentStage("fresh", "quarantine");
      expect(checkpoint?.error || null).toBeNull();
      expect(checkpoint?.status).toBe("completed");
      expect(state.documents[0]).toMatchObject({ parseSourceDecision: "original", sourceKey: "raw/fresh.pdf", sourceSha256: sha256Bytes(benign) });
      expect(reads).toEqual(["raw/fresh.pdf"]);
    } finally {
      restore();
    }
    expect(await decisionRow("fresh")).toEqual({ parse_source_key: null, parse_source_sha256: sha256Bytes(benign), parse_source_scan_version: 1 });
    expect((await store.loadDocument("fresh")).parseSourceDecision).toBe("original");
  }, 60_000);

  it("an encrypted upload, end to end: quarantine stores its copy and every later stage parses the copy", async () => {
    const features = { ...pipeline };
    await seedFreshUpload("enc", "raw/enc.pdf", ORIGINAL_SHA, features);
    const { storage, reads, objects } = memoryStorage(new Map([["raw/enc.pdf", attackPdf]]));
    const { stages, executed, parsed } = pipelineStages(storage, inVm(quarantineRunner()));
    const restore = quiet();
    try {
      await runWorkflow(stages, features, "run-enc");
    } finally {
      restore();
    }
    const copyKey = "u1/run-enc/quarantine/enc.scanned.pdf";
    expect(objects.get(copyKey)).toEqual(scannedCopy);
    expect(executed.length).toBeGreaterThan(3);
    expect(new Set(parsed.map((read) => read.key))).toEqual(new Set([copyKey]));
    expect(reads.filter((key) => key === "raw/enc.pdf")).toHaveLength(1);
    expect(await decisionRow("enc")).toEqual({ parse_source_key: copyKey, parse_source_sha256: sha256Bytes(scannedCopy), parse_source_scan_version: 1 });
    const [run] = await sql<{ status: string }[]>`select status from project_runs where id = 'run-enc'`;
    expect(run?.status).toBe("completed");
  }, 60_000);

  it("negative: an upload swapped after the server hashed it is refused (source-hash-mismatch) and gets no decision", async () => {
    await seedFreshUpload("swapped", "raw/swapped.pdf", sha256Bytes(benign));
    const { storage } = memoryStorage(new Map([["raw/swapped.pdf", Buffer.from("%PDF-1.4\n% SWAPPED\n%%EOF\n")]]));
    const restore = quiet();
    try {
      const state = await loadRunState(store, "run-swapped", { totalStages: 2 });
      await new QuarantineStage(plainRunner, storage, config).run(state);
      const checkpoint = state.documentStage("swapped", "quarantine");
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/source changed after upload/);
      expect(state.documents[0]?.parseSourceDecision).toBe("unscanned");
      await expect(stageSourceFile(storage, state.documents[0]!, "x")).rejects.toBeInstanceOf(UnscannedParseSourceError);
    } finally {
      restore();
    }
    expect(await decisionRow("swapped")).toEqual({ parse_source_key: null, parse_source_sha256: null, parse_source_scan_version: null });
  }, 60_000);

  it("negative: an upload the scan refuses stays undecided, and a later parse stage refuses it before reading", async () => {
    await seedFreshUpload("bad", "raw/bad.pdf", sha256Bytes(benign));
    const { storage, reads } = memoryStorage(new Map([["raw/bad.pdf", benign]]));
    const infected = inVm({ scanForMalware: async () => ({ ...clean, status: "infected", signature: "Eicar-Test-Signature" }), decryptPdfForScan: async () => ({ status: "not-encrypted", encrypted: false }) } as unknown as CommandRunner);
    const restore = quiet();
    try {
      const state = await loadRunState(store, "run-bad", { totalStages: 2 });
      await new QuarantineStage(infected, storage, config).run(state);
      expect(state.documentStage("bad", "quarantine")?.status).toBe("failed");
      expect(state.documents[0]?.parseSourceDecision).toBe("unscanned");
      reads.length = 0;
      const later = await loadRunState(store, "run-bad", { totalStages: 2 });
      expect(later.documents[0]?.parseSourceDecision).toBe("unscanned");
      let ran = false;
      await runDocumentStage(later, later.documents[0]!, "format-detect", "bad:normalizedFormat", "x", async () => { ran = true; return { artifactUri: "" }; });
      expect(ran).toBe(false);
      await expect(stageSourceFile(storage, later.documents[0]!, "x")).rejects.toBeInstanceOf(UnscannedParseSourceError);
      expect(reads).toEqual([]);
    } finally {
      restore();
    }
    expect(await decisionRow("bad")).toEqual({ parse_source_key: null, parse_source_sha256: null, parse_source_scan_version: null });
  }, 60_000);

  it("negative: a document object the loader did not build (no upload binding, no decision) is refused before any read", async () => {
    await seedFreshUpload("adhoc-q", "raw/adhoc.pdf", sha256Bytes(benign));
    const { storage, reads } = memoryStorage(new Map([["raw/adhoc.pdf", benign]]));
    const restore = quiet();
    try {
      const state = await loadRunState(store, "run-adhoc-q", { totalStages: 2 });
      const loaded = state.documents[0]!;
      // A spread copy loses the binding; dropping its decision field makes it look hand-built.
      const { parseSourceDecision: _dropped, ...rest } = { ...loaded, sourceKey: "raw/adhoc.pdf", sourceSha256: sha256Bytes(benign) };
      state.documents[0] = rest as typeof loaded;
      await new QuarantineStage(plainRunner, storage, config).run(state);
      const checkpoint = state.documentStage("adhoc-q", "quarantine");
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/no upload binding/);
    } finally {
      restore();
    }
    expect(reads).toEqual([]);
    expect(await decisionRow("adhoc-q")).toEqual({ parse_source_key: null, parse_source_sha256: null, parse_source_scan_version: null });
  }, 60_000);

  it("the parsers' gate is unchanged: verifyStagedSource still refuses an undecided object; the quarantine check refuses the unreadable key", () => {
    const restore = quiet();
    try {
      expect(() => verifyStagedSource({ id: "x", sourceKey: "raw/x.pdf", sourceSha256: sha256Bytes(benign) }, sha256Bytes(benign))).toThrow(UnscannedParseSourceError);
      expect(() => verifyStagedSource({ id: "x", sourceKey: "raw/x.pdf", sourceSha256: sha256Bytes(benign), parseSourceDecision: "unscanned" }, sha256Bytes(benign))).toThrow(UnscannedParseSourceError);
      expect(() => verifyQuarantineUpload({ id: "x", sourceKey: unscannedParseSourceKey("x"), sourceSha256: null }, sha256Bytes(benign))).toThrow(UnscannedParseSourceError);
      expect(() => verifyQuarantineUpload({ id: "x", sourceKey: "raw/x.pdf", sourceSha256: sha256Bytes(benign) }, "f".repeat(64))).toThrow(/source changed after upload/);
      expect(() => verifyQuarantineUpload({ id: "x", sourceKey: "raw/x.pdf", sourceSha256: null }, "not-a-hash")).toThrow(/not a sha256/);
      expect(() => verifyQuarantineUpload({ id: "x", sourceKey: "raw/x.pdf", sourceSha256: sha256Bytes(benign) }, sha256Bytes(benign))).not.toThrow();
    } finally {
      restore();
    }
  });

  it("tripwire: only the quarantine stage verifies an upload without a parse decision", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const callers: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "__tests__" && entry.name !== "test") await walk(full); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const relative = path.relative(root, full).split(path.sep).join("/");
        if (relative === "sandbox/source-integrity.ts") continue;
        if (/verifyQuarantineUpload\b/.test(await readFile(full, "utf8"))) callers.push(relative);
      }
    };
    await walk(root);
    expect(callers).toEqual(["stages/quarantine.ts"]);
  });
});
