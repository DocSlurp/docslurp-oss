import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DocumentAsset } from "@docslurp/shared";

import {
  DOCUMENT_ASSET_RESUME_CAP, DOCUMENT_ASSET_RESUME_TOTAL_CAP, DocumentAssetLedgerError, flushAssetLedger, ledgerWriteForFailedFigures, ledgerWriteForNoFigures,
  ledgerWriteForStoredFigures, listResumableDocuments, writeDocumentAssetLedger,
  type DocumentAssetLedgerScope, type DocumentAssetLedgerWrite, type LedgerAsset, type PendingAssetLedgerWrite,
} from "../db/document-asset-ledger.js";
import { Store } from "../db/store.js";
import { downloadDopplerImagesDir, readDopplerFigureDir, readLedgerSpill, storeDopplerFigures } from "../extractors/doppler-figures.js";

/** A spilled write as rows in memory, each owned file with the key the store gave it (for tests that bend one row). */
async function inMemory(write: DocumentAssetLedgerWrite, root = "ua/run-a/doppler/doc-a/images/"): Promise<DocumentAssetLedgerWrite & { assets: LedgerAsset[] }> {
  const rows: LedgerAsset[] = [];
  for await (const row of readLedgerSpill((write.assets as { spill: string }).spill)) rows.push({ ...row, storageKey: row.status === "extracted" ? `${root}${row.linkPath!.slice("images/".length)}` : null });
  return { ...write, assets: rows };
}
import { v2Manifest, v3ShardText, v3Text, writeShardedFolder, writeV2Folder, writeV3Folder, V2_SETTINGS_SHA, V2_SOURCE_SHA } from "../test/doppler-manifest-v2.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// The asset ledger (migration 0141) through the worker's real Store over a migrated database: org-scoped writes,
// idempotent re-runs and resumes, refusals that write nothing, stale runs that write nothing, and no way for one
// organization to touch another's rows.
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;
let work: string;

const A: DocumentAssetLedgerScope = { orgId: "org-a", projectId: "proj-a", documentId: "doc-a", runId: "run-a" };
const B: DocumentAssetLedgerScope = { orgId: "org-b", projectId: "proj-b", documentId: "doc-b", runId: "run-b" };
const USERS: Record<string, string> = { "doc-a": "ua", "doc-b": "ub", "doc-orphan": "ua", doc_w: "ua" };

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub');
    insert into projects(id, org_id, user_id, name) values ('proj-a', 'org-a', 'ua', 'A'), ('proj-a2', 'org-a', 'ua', 'A2'), ('proj-b', 'org-b', 'ub', 'B');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, created_at) values
      ('run-a-old', 'org-a', 'ua', 'proj-a', 'upload', 'completed', 'completed', '{}', 1, now() - interval '2 hours'),
      ('run-a', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1, now() - interval '1 hour'),
      ('run-a-new', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1, now()),
      ('run-b', 'org-b', 'ub', 'proj-b', 'upload', 'processing', 'extract', '{}', 1, now());
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 3),
      ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'processing', 3),
      ('doc_w', 'org-a', 'ua', 'proj-a', 'run-a', 'w.pdf', 'application/pdf', 'kw', 'processing', 3),
      ('doc-orphan', null, 'ua', 'proj-a', 'run-a', 'c.pdf', 'application/pdf', 'kc', 'processing', 3);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  work = await mkdtemp(path.join(tmpdir(), "asset-ledger-test-"));
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql`delete from document_assets`;
  await sql`delete from document_extraction_levels`;
  await sql`delete from document_extraction_shards`;
  await sql`update documents set run_id = 'run-a' where id in ('doc-a', 'doc_w')`;
});

/** An in-memory object store, as the worker's ArtifactStore is used by the figure step and a resume. */
function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putJson: async (key: string, value: unknown) => { objects.set(key, Buffer.from(JSON.stringify(value))); },
    getBytes: async (key: string) => { const value = objects.get(key); if (!value) throw new Error("NoSuchKey"); return value; },
    uri: (key: string) => `s3://b/${key}`,
  };
}

/** Read, store (in memory) and build the ledger write for a v2 folder, as the figure step does. */
async function figureWrite(scope: DocumentAssetLedgerScope, options: { partial?: boolean; resume?: boolean; v2?: boolean; mutate?: (m: ReturnType<typeof v2Manifest>) => void; storage?: ReturnType<typeof memoryStorage> } = {}): Promise<DocumentAssetLedgerWrite> {
  const built = v2Manifest({ partial: options.partial });
  options.mutate?.(built);
  const dir = await mkdtemp(path.join(work, "figures-"));
  // Version 3 (manifest.jsonl), unless the test asks for the legacy version 2 shape.
  if (options.v2) await writeV2Folder(dir, built.manifest, built.files);
  else await writeV3Folder(dir, v3Text(built.manifest), built.files);
  const partial = !built.manifest.complete;
  const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: partial ? "partial" : "complete" });
  const stored = await storeDopplerFigures({
    storage: options.storage ?? memoryStorage(), document: { id: scope.documentId, userId: USERS[scope.documentId] ?? "ua", runId: scope.runId },
    runId: scope.runId, figures: set, markdown: "",
  });
  const pending = ledgerWriteForStoredFigures({
    set, stored,
    outcome: { status: partial ? "partial" : "extracted", exitCode: partial ? 5 : 0, build: "doppler-1.4.0+g1a2b3c4" },
  });
  return complete(scope, pending, options.resume);
}

const complete = (scope: DocumentAssetLedgerScope, pending: PendingAssetLedgerWrite, resume?: boolean): DocumentAssetLedgerWrite =>
  ({ scope, level: { ...pending.level, markdownComplete: true }, assets: pending.assets, ...(resume ? { resume: true } : {}), ...(pending.levelOnly ? { levelOnly: true } : {}) });

const assets = async (documentId: string) => sql<Array<Record<string, unknown>>>`
  select asset_id, org_id, project_id, status, reason, resumable, source, file_of, link_path, storage_key is not null as stored
  from document_assets where document_id = ${documentId} order by asset_id`;
const level = async (documentId: string) => (await sql<Array<Record<string, unknown>>>`
  select org_id, run_id, images_status, images_exit_code, manifest_version, doppler_build, markdown_complete, manifest_key, manifest_sha256,
    source_sha256, settings_sha256, resumes, last_cut_page, deadline_ms, assets_total, assets_extracted, assets_not_extracted,
    assets_unlinked, assets_resumable, source_copy, source_decode, source_render, asset_bytes::float8 as asset_bytes
  from document_extraction_levels where document_id = ${documentId}`)[0];

describe("writing the ledger", () => {
  it("writes every image, its object and box, and the extraction level with counts per status and source", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A));
    expect(await assets("doc-a")).toEqual([
      { asset_id: "p1.1", org_id: "org-a", project_id: "proj-a", status: "extracted", reason: null, resumable: false, source: "render", file_of: "p1.1", link_path: "images/page-0001/image-001.webp", stored: true },
      { asset_id: "p1.g1", org_id: "org-a", project_id: "proj-a", status: "extracted", reason: null, resumable: false, source: "render", file_of: "p1.g1", link_path: "images/page-0001/figure-001.svg", stored: true },
      { asset_id: "p2.1", org_id: "org-a", project_id: "proj-a", status: "not-extracted", reason: "repeat", resumable: false, source: null, file_of: "p1.1", link_path: "images/page-0001/image-001.webp", stored: false },
      { asset_id: "p2.2", org_id: "org-a", project_id: "proj-a", status: "unlinked", reason: null, resumable: false, source: null, file_of: null, link_path: null, stored: false },
      { asset_id: "p3.1", org_id: "org-a", project_id: "proj-a", status: "extracted", reason: null, resumable: false, source: "copy", file_of: "p3.1", link_path: "images/page-0003/image-001.jpg", stored: true },
    ]);
    expect(await sql`select asset_id, storage_key, obj_num, obj_gen, bbox from document_assets where document_id = 'doc-a' and asset_id in ('p1.1', 'p1.g1') order by asset_id`).toEqual([
      { asset_id: "p1.1", storage_key: "ua/run-a/doppler/doc-a/images/page-0001/image-001.webp", obj_num: 12, obj_gen: 0, bbox: [10, 20, 110, 220] },
      { asset_id: "p1.g1", storage_key: "ua/run-a/doppler/doc-a/images/page-0001/figure-001.svg", obj_num: null, obj_gen: null, bbox: [10, 20, 110, 220] },
    ]);
    expect(await level("doc-a")).toMatchObject({
      org_id: "org-a", run_id: "run-a", images_status: "complete", images_exit_code: 0, doppler_build: "doppler-1.4.0+g1a2b3c4",
      markdown_complete: true, manifest_key: "ua/run-a/doppler/doc-a/images/manifest.jsonl", manifest_version: 3, source_sha256: V2_SOURCE_SHA,
      settings_sha256: V2_SETTINGS_SHA, resumes: 0, last_cut_page: null, deadline_ms: 121_500, assets_total: 5, assets_extracted: 3,
      assets_not_extracted: 1, assets_unlinked: 1, assets_resumable: 0, source_copy: 1, source_decode: 0, source_render: 2,
    });
    expect((await level("doc-a"))!.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await level("doc-a"))!.asset_bytes).toBeGreaterThan(0);
  });

  it("--scan-pages copy (Doppler #39): an uncopyable background scan is ledgered unlinked with reason scan-not-copyable", async () => {
    const copyMode = ({ manifest }: ReturnType<typeof v2Manifest>) => {
      manifest.scan_pages = "copy";
      Object.assign(manifest.images.find((e) => e.id === "p2.2")!, { fate: "background", reason: "scan-not-copyable" });
    };
    await store.writeDocumentAssetLedger(await figureWrite(A, { mutate: copyMode }));
    expect(await sql`select asset_id, fate, status, reason, file_of, link_path, storage_key from document_assets where document_id = 'doc-a' and asset_id = 'p2.2'`).toEqual([
      { asset_id: "p2.2", fate: "background", status: "unlinked", reason: "scan-not-copyable", file_of: null, link_path: null, storage_key: null },
    ]);
    expect(await level("doc-a")).toMatchObject({ images_status: "complete", assets_total: 5, assets_unlinked: 1, assets_not_extracted: 1, assets_resumable: 0 });
    // The same write again changes nothing.
    expect(await store.writeDocumentAssetLedger(await figureWrite(A, { mutate: copyMode }))).toMatchObject({ upserted: 0, removed: 0 });
  });

  it("is idempotent: the same write twice changes no row (unchanged rows are skipped)", async () => {
    const write = await figureWrite(A);
    expect(await store.writeDocumentAssetLedger(write)).toMatchObject({ upserted: 5, removed: 0 });
    const first = await sql`select asset_id, updated_at::text from document_assets where document_id = 'doc-a' order by asset_id`;
    expect(await store.writeDocumentAssetLedger(write)).toMatchObject({ upserted: 0, removed: 0 });
    expect(await sql`select asset_id, updated_at::text from document_assets where document_id = 'doc-a' order by asset_id`).toEqual(first);
    expect(await level("doc-a")).toMatchObject({ assets_total: 5 });
  });

  it("a partial run (exit 5) is resumable; a resume updates the same rows in place and the host counts it", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true }));
    expect(await level("doc-a")).toMatchObject({ images_status: "resumable", images_exit_code: 5, assets_resumable: 1, last_cut_page: 3, resumes: 0 });
    expect((await assets("doc-a")).find((row) => row.asset_id === "p3.2")).toMatchObject({ status: "not-extracted", reason: "budget", resumable: true, stored: false });
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toMatchObject([{ documentId: "doc-a", projectId: "proj-a", assetsResumable: 1, lastCutPage: 3, sourceSha256: V2_SOURCE_SHA, resumes: 0 }]);

    // The resume extracted p3.2: same ids, new status. The manifest claims 7 resumes; the host counts 1.
    const resumed = await figureWrite(A, {
      resume: true, partial: true,
      mutate: ({ manifest, files }) => {
        const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
        bytes.writeUInt32LE(bytes.length - 8, 4);
        files.set("page-0003/image-002.webp", bytes);
        const entry = manifest.images.find((e) => e.id === "p3.2")!;
        Object.assign(entry, { status: "extracted", reason: undefined, resumable: undefined, source: "render", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: 10, height: 10 });
        manifest.resumes = 7;
        manifest.resumable = false;
        manifest.complete = true;
        manifest.batches[1] = { pages: [3, 3], status: "ok" };
        manifest.totals.extracted += 1;
        manifest.totals.not_extracted -= 1;
        manifest.totals.bytes += bytes.length;
        manifest.totals.batches_cut = 0;
      },
    });
    const before = (await sql<{ created_at: string }[]>`select created_at::text from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`)[0]!.created_at;
    await store.writeDocumentAssetLedger(resumed);
    expect(await level("doc-a")).toMatchObject({ images_status: "complete", resumes: 1, assets_resumable: 0, assets_extracted: 4 });
    expect((await assets("doc-a")).find((row) => row.asset_id === "p3.2")).toMatchObject({ status: "extracted", resumable: false, stored: true });
    expect((await sql<{ created_at: string }[]>`select created_at::text from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`)[0]!.created_at).toBe(before);
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
  });

  // DOCUMENT_ASSET_RESUME_CAP (the backstop, 64) writes in a row: an explicit timeout, never the 5 s default.
  it("a hostile manifest that reports resumes:0 and stays resumable forever leaves the queue at the host's cap", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true }));
    for (let i = 1; i <= DOCUMENT_ASSET_RESUME_CAP; i += 1) {
      expect(await listResumableDocuments(sql, { orgId: "org-a" })).toHaveLength(1);
      // Every resume hands back the same partial manifest, resumes: 0.
      await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true, resume: true }));
      expect(await level("doc-a")).toMatchObject({ images_status: "resumable", resumes: i });
    }
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
    await expect(store.writeDocumentAssetLedger(await figureWrite(A, { partial: true, resume: true }))).rejects.toMatchObject({ rule: "resume-cap" });
    // A fresh run (not a resume) starts the count again.
    await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true }));
    expect(await level("doc-a")).toMatchObject({ resumes: 0 });
  }, 60_000);

  it("a version 1 folder maps into the ledger with what it has", async () => {
    const dir = await mkdtemp(path.join(work, "v1-"));
    await cp(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-figures"), dir, { recursive: true });
    const set = await readDopplerFigureDir(dir, { pageCount: 5, expect: "complete" });
    const stored = await storeDopplerFigures({ storage: memoryStorage(), document: { id: "doc-a", userId: "ua", runId: "run-a" }, runId: "run-a", figures: set, markdown: "" });
    await store.writeDocumentAssetLedger(complete(A, ledgerWriteForStoredFigures({ set, stored, outcome: { status: "extracted" } })));
    expect((await assets("doc-a")).map((row) => [row.asset_id, row.status, row.reason, row.file_of, row.link_path, row.stored])).toEqual([
      ["p3.1", "extracted", null, "p3.1", null, true],
      ["p3.g2", "extracted", null, "p3.g2", null, true],
      ["p4.1", "not-extracted", "repeat", "p3.1", null, false],
      ["p5.2", "not-extracted", "error", null, null, false],
      ["p5.g1", "extracted", null, "p5.g1", null, true],
    ]);
    expect(await level("doc-a")).toMatchObject({ images_status: "complete", manifest_version: 1, images_exit_code: null, source_sha256: null, assets_total: 5, assets_extracted: 3, source_render: 3 });
  });

  it("a failed step never deletes stored figures: rows kept, status honest; with nothing stored it is `failed`", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A));
    const before = await assets("doc-a");
    await store.writeDocumentAssetLedger(complete(A, ledgerWriteForFailedFigures({ outcome: { exitCode: 6 } })));
    expect(await assets("doc-a")).toEqual(before);
    expect(await level("doc-a")).toMatchObject({ images_status: "partial", images_exit_code: 6, assets_total: 5 });
    await store.writeDocumentAssetLedger(complete(B, ledgerWriteForFailedFigures({ outcome: { exitCode: 6 } })));
    expect(await level("doc-b")).toMatchObject({ images_status: "failed", images_exit_code: 6, assets_total: 0 });
  });

  it("committed Markdown without a figure step leaves the resume queue (MEDIUM-3), keeping the rows but not as current", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true }));
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toHaveLength(1);
    const before = await assets("doc-a");
    await store.writeDocumentAssetLedger(complete(A, ledgerWriteForNoFigures("disabled")));
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
    expect(await assets("doc-a")).toEqual(before);
    expect(await level("doc-a")).toMatchObject({ images_status: "disabled", assets_total: 0, asset_bytes: 0 });
    await store.writeDocumentAssetLedger(complete(A, ledgerWriteForNoFigures("none")));
    expect(await level("doc-a")).toMatchObject({ images_status: "none" });
    // A later figure pass makes rows current again.
    await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true }));
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toHaveLength(1);
  });
});

describe("a 5,000-page document (MEDIUM-7)", () => {
  /** Two images per page (a page scan and an unlinked watermark): 10,000 rows, ten insert batches. */
  function syntheticBook(pages: number, runId: string): LedgerAsset[] {
    const rows: LedgerAsset[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const p = String(page).padStart(4, "0");
      rows.push({
        assetId: `p${page}.1`, pageNumber: page, kind: "picture", fate: "page-scan", status: "extracted", reason: null, resumable: false,
        source: "copy", format: "jpg", bytes: 1_000_000 + page, sha256: createHash("sha256").update(String(page)).digest("hex"), width: 1700, height: 2200,
        repeatOf: null, fallback: null, linkPath: `images/page-${p}/image-001.jpg`, fileOf: `p${page}.1`, obj: [page + 4, 0], bbox: [0, 0, 612, 792],
        storageKey: `ua/${runId}/doppler/doc-a/images/page-${p}/image-001.jpg`,
      });
      rows.push({
        assetId: `p${page}.2`, pageNumber: page, kind: "picture", fate: "watermark", status: "unlinked", reason: null, resumable: false,
        source: null, format: null, bytes: null, sha256: null, width: null, height: null, repeatOf: null, fallback: null, linkPath: null,
        fileOf: null, obj: [3, 0], bbox: [100, 100, 500, 140], storageKey: null,
      });
    }
    return rows;
  }
  const level5000 = (assets: LedgerAsset[]): DocumentAssetLedgerWrite => ({
    scope: A, assets,
    level: { markdownComplete: true, imagesStatus: "complete", imagesExitCode: 0, manifestVersion: 2, dopplerBuild: null, run: null, manifest: null },
  });

  it("writes in many batches, skips unchanged rows on a re-run, and prunes a large removed set", async () => {
    const book = syntheticBook(5000, "run-a");
    let started = Date.now();
    expect(await store.writeDocumentAssetLedger(level5000(book))).toMatchObject({ upserted: 10_000, removed: 0 });
    const firstMs = Date.now() - started;
    expect(await level("doc-a")).toMatchObject({ assets_total: 10_000, assets_extracted: 5000, assets_unlinked: 5000, source_copy: 5000 });
    started = Date.now();
    expect(await store.writeDocumentAssetLedger(level5000(book))).toMatchObject({ upserted: 0, removed: 0 });
    const unchangedMs = Date.now() - started;
    // The watermark went away on a re-run: 5,000 rows pruned in the same transaction.
    expect(await store.writeDocumentAssetLedger(level5000(book.filter((row) => row.fate !== "watermark")))).toMatchObject({ upserted: 0, removed: 5000 });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from document_assets where document_id = 'doc-a'`)[0]!.n).toBe(5000);
    console.log(`[asset-ledger-test] 10,000 rows: first write ${firstMs} ms, unchanged re-run ${unchangedMs} ms (PGlite)`);
  }, 120_000);
});

describe("runs: only the document's current run writes (MEDIUM-5)", () => {
  it("refuses a run of another organization (cross-org run id), and the database refuses it written directly", async () => {
    await expect(store.writeDocumentAssetLedger(await figureWrite({ ...A, runId: "run-b" }))).rejects.toMatchObject({ rule: "scope-mismatch" });
    expect(await level("doc-a")).toBeUndefined();
    await expect(sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id) values ('doc-a', 'org-a', 'proj-a', 'run-b')`)
      .rejects.toMatchObject({ code: "23503" });
    await expect(sql`insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status)
      values ('doc-a', 'org-a', 'proj-a', 'run-b', 'p2.2', 2, 'picture', 'furniture', 'unlinked')`).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a superseded run: the document moved to a newer run", async () => {
    const write = await figureWrite(A);
    await sql`update documents set run_id = 'run-a-new' where id = 'doc-a'`;
    await expect(store.writeDocumentAssetLedger(write)).rejects.toMatchObject({ rule: "stale-write" });
    expect(await assets("doc-a")).toEqual([]);
  });

  it("refuses an older run finishing late, after a newer run wrote the level", async () => {
    await sql`update documents set run_id = 'run-a-new' where id = 'doc-a'`;
    await store.writeDocumentAssetLedger(await figureWrite({ ...A, runId: "run-a-new" }));
    const newer = await assets("doc-a");
    // The document's run is put back (a race in which the old run still looks current): the order of runs decides.
    await sql`update documents set run_id = 'run-a-old' where id = 'doc-a'`;
    await expect(store.writeDocumentAssetLedger(await figureWrite({ ...A, runId: "run-a-old" }))).rejects.toMatchObject({ rule: "stale-write" });
    expect(await assets("doc-a")).toEqual(newer);
    expect(await level("doc-a")).toMatchObject({ run_id: "run-a-new" });
  });

  it("a deleted run leaves the rows with no run, never another scope", async () => {
    await sql`update documents set run_id = 'run-a-new' where id = 'doc-a'`;
    await store.writeDocumentAssetLedger(await figureWrite({ ...A, runId: "run-a-new" }));
    await sql`update documents set run_id = 'run-a' where id = 'doc-a'`;
    await sql`delete from project_runs where id = 'run-a-new'`;
    expect(await level("doc-a")).toMatchObject({ run_id: null, org_id: "org-a" });
    expect((await sql<{ run_id: string | null }[]>`select distinct run_id from document_assets where document_id = 'doc-a'`)).toEqual([{ run_id: null }]);
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents) values ('run-a-new', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1)`;
  });
});

describe("tenant isolation", () => {
  it("org B cannot write rows for org A's document, and A's rows stay as they were", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A));
    const before = await assets("doc-a");
    const forged = await figureWrite({ ...B, documentId: "doc-a" });
    await expect(store.writeDocumentAssetLedger(forged)).rejects.toMatchObject({ rule: "scope-mismatch" });
    // Same organization, wrong project: refused too.
    await expect(store.writeDocumentAssetLedger(await figureWrite({ ...A, projectId: "proj-a2" }))).rejects.toMatchObject({ rule: "scope-mismatch" });
    expect(await assets("doc-a")).toEqual(before);
    expect(await level("doc-a")).toMatchObject({ org_id: "org-a" });
  });

  it("a key under another organization's root is refused, compared exactly (LOW-4)", async () => {
    const write = await inMemory(await figureWrite(A));
    const swap = (from: string, to: string) => ({ ...write, assets: write.assets.map((asset) => asset.storageKey ? { ...asset, storageKey: asset.storageKey.replace(from, to) } : asset) });
    // Another tenant's root with this document's folder and the right path: only an exact comparison catches it.
    await expect(store.writeDocumentAssetLedger(swap("ua/run-a/", "ub/run-b/"))).rejects.toMatchObject({ rule: "key-mismatch" });
    await expect(store.writeDocumentAssetLedger(swap("ua/run-a/", "x/ua/run-a/"))).rejects.toMatchObject({ rule: "key-mismatch" });
    await expect(store.writeDocumentAssetLedger({ ...write, level: { ...write.level, manifest: { key: "ub/run-b/doppler/doc-a/images/manifest.json", sha256: "f".repeat(64) } } }))
      .rejects.toMatchObject({ rule: "key-mismatch" });
    expect(await assets("doc-a")).toEqual([]);
  });

  it("a document without an organization can have no rows", async () => {
    await expect(store.writeDocumentAssetLedger(await figureWrite({ ...A, documentId: "doc-orphan" }))).rejects.toMatchObject({ rule: "scope-mismatch" });
    const pendingAssetLedger = new Map([["doc-a", ledgerWriteForNoFigures("none")]]);
    const outcomes = await flushAssetLedger({ run: { id: "run-a", orgId: null, projectId: "proj-a" }, pendingAssetLedger, artifactLedger: { readDocument: () => undefined } },
      () => { throw new Error("never written"); });
    expect(outcomes.get("doc-a")).toBe("no-scope");
  });

  it("the database refuses a row whose organization is not its document's, or a key outside its own folder", async () => {
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status)
      values ('doc-a', 'org-b', 'proj-b', 'p1.1', 1, 'picture', 'block', 'unlinked')`).rejects.toMatchObject({ code: "23503" });
    await expect(sql`insert into document_extraction_levels (document_id, org_id, project_id) values ('doc-a', 'org-b', 'proj-a')`)
      .rejects.toMatchObject({ code: "23503" });
    const insert = (documentId: string, key: string) => sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, source, format, bytes, sha256, width, height, file_of, storage_key, storage_state)
      values (${documentId}, 'org-a', 'proj-a', 'p1.1', 1, 'picture', 'block', 'extracted', 'render', 'webp', 10, ${"e".repeat(64)}, 1, 1, 'p1.1', ${key}, 'stored')`;
    await expect(insert("doc-a", "ub/run-b/doppler/doc-b/images/page-0001/image-001.webp")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("doc-a", "ua/run-a/doppler/doc-a/images/page-0001/image-002.webp")).rejects.toMatchObject({ code: "23514" });
    // An extracted row always has a storage state (pending or stored); `none` is refused (migration 0156).
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, source, format, bytes, sha256, width, height, file_of, storage_key, storage_state)
      values ('doc-a', 'org-a', 'proj-a', 'p1.1', 1, 'picture', 'block', 'extracted', 'render', 'webp', 10, ${"e".repeat(64)}, 1, 1, 'p1.1', 'ua/run-a/doppler/doc-a/images/page-0001/image-001.webp', 'none')`)
      .rejects.toMatchObject({ code: "23514" });
    // A document id with a LIKE wildcard (`_`) matches only itself: `docXw` is another document's folder.
    await expect(insert("doc_w", "ua/run-a/doppler/docXw/images/page-0001/image-001.webp")).rejects.toMatchObject({ code: "23514" });
    await insert("doc_w", "ua/run-a/doppler/doc_w/images/page-0001/image-001.webp");
    // A page scan may pass 8 MiB only as a copy or decode; a picture never.
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, source, format, bytes, sha256, width, height, file_of, storage_key, storage_state)
      values ('doc-a', 'org-a', 'proj-a', 'p1.1', 1, 'picture', 'block', 'extracted', 'render', 'webp', 9000000, ${"e".repeat(64)}, 1, 1, 'p1.1', 'ua/run-a/doppler/doc-a/images/page-0001/image-001.webp', 'stored')`)
      .rejects.toMatchObject({ code: "23514" });
  });

  it("the database takes scan-not-copyable only on an unlinked background picture or mask (migration 0150)", async () => {
    const unlinked = (id: string, fate: string, reason: string | null) => sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason)
      values ('doc-a', 'org-a', 'proj-a', ${id}, 1, 'picture', ${fate}, 'unlinked', ${reason})`;
    await unlinked("p1.1", "background", "scan-not-copyable");
    await unlinked("p1.2", "furniture", null);
    await expect(unlinked("p1.3", "furniture", "scan-not-copyable")).rejects.toMatchObject({ code: "23514" });
    await expect(unlinked("p1.3", "page-scan", "scan-not-copyable")).rejects.toMatchObject({ code: "23514" });
    await expect(unlinked("p1.3", "background", "min_side")).rejects.toMatchObject({ code: "23514" });
    await expect(unlinked("p1.3", "background", "scan_not_copyable")).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason)
      values ('doc-a', 'org-a', 'proj-a', 'p1.3', 1, 'picture', 'background', 'not-extracted', 'scan-not-copyable')`).rejects.toMatchObject({ code: "23514" });
    await sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason)
      values ('doc-a', 'org-a', 'proj-a', 'p1.3', 1, 'picture', 'block', 'not-extracted', 'min_side')`;
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason)
      values ('doc-a', 'org-a', 'proj-a', 'p1.4', 1, 'picture', 'block', 'not-extracted', null)`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason, source, format, bytes, sha256, width, height, file_of, storage_key)
      values ('doc-a', 'org-a', 'proj-a', 'p1.4', 1, 'picture', 'background', 'extracted', 'scan-not-copyable', 'render', 'webp', 10, ${"e".repeat(64)}, 1, 1, 'p1.4', 'ua/run-a/doppler/doc-a/images/page-0001/image-004.webp')`)
      .rejects.toMatchObject({ code: "23514" });
    // A background mask (a layered scan's stencil) is allowed; a vector never; nor a repeat or another image's file.
    await sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason)
      values ('doc-a', 'org-a', 'proj-a', 'p1.5', 1, 'mask', 'background', 'unlinked', 'scan-not-copyable')`;
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason)
      values ('doc-a', 'org-a', 'proj-a', 'p1.g1', 1, 'vector', 'background', 'unlinked', 'scan-not-copyable')`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason, repeat_of)
      values ('doc-a', 'org-a', 'proj-a', 'p1.6', 1, 'picture', 'background', 'unlinked', 'scan-not-copyable', 'p1.1')`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason, file_of)
      values ('doc-a', 'org-a', 'proj-a', 'p1.6', 1, 'picture', 'background', 'unlinked', 'scan-not-copyable', 'p1.1')`).rejects.toMatchObject({ code: "23514" });
    // Every constraint 0150 added or replaced is validated, not only enforced on later writes.
    expect(await sql`select conname, convalidated from pg_constraint where conrelid = 'document_assets'::regclass
      and conname in ('document_assets_reason_check', 'document_assets_status_reason_check', 'document_assets_scan_not_copyable_fate_check',
        'document_assets_scan_not_copyable_file_check') order by conname`).toEqual([
      { conname: "document_assets_reason_check", convalidated: true },
      { conname: "document_assets_scan_not_copyable_fate_check", convalidated: true },
      { conname: "document_assets_scan_not_copyable_file_check", convalidated: true },
      { conname: "document_assets_status_reason_check", convalidated: true },
    ]);
    // An existing row cannot be moved into a forbidden combination either.
    await expect(sql`update document_assets set fate = 'furniture' where document_id = 'doc-a' and asset_id = 'p1.1'`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`update document_assets set status = 'not-extracted' where document_id = 'doc-a' and asset_id = 'p1.1'`).rejects.toMatchObject({ code: "23514" });
  });

  it("pages left to the host's page image are read for the asking organization's document only", async () => {
    const insert = (documentId: string, orgId: string, projectId: string, id: string, page: number, fate: string, status: string, reason: string | null, link: string | null = null, runId = orgId === "org-a" ? "run-a" : "run-b") =>
      sql`insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason, format, link_path)
        values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${id}, ${page}, 'picture', ${fate}, ${status}, ${reason}, ${link ? "jpg" : null}, ${link})`;
    // The current levels of each document's run (rows of another run, or of a non-current level, never count).
    await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status)
      values ('doc-a', 'org-a', 'proj-a', 'run-a', true, 'partial'), ('doc-b', 'org-b', 'proj-b', 'run-b', true, 'partial')
      on conflict (document_id) do update set run_id = excluded.run_id, assets_current = true`;
    await insert("doc-a", "org-a", "proj-a", "p1.1", 1, "page-scan", "not-extracted", "copy", "images/page-0001/image-001.jpg");
    await insert("doc-a", "org-a", "proj-a", "p2.1", 2, "background", "unlinked", "scan-not-copyable");
    await insert("doc-a", "org-a", "proj-a", "p2.2", 2, "background", "unlinked", "scan-not-copyable");
    await insert("doc-a", "org-a", "proj-a", "p3.1", 3, "block", "not-extracted", "copy", "images/page-0003/image-001.jpg");
    await insert("doc-a", "org-a", "proj-a", "p3.2", 3, "furniture", "unlinked", null);
    await insert("doc-b", "org-b", "proj-b", "p3.3", 3, "background", "unlinked", "scan-not-copyable");
    expect(await store.listHostPageImagePages({ orgId: "org-a", documentId: "doc-a" })).toEqual([1, 2]);
    expect(await store.listHostPageImagePages({ orgId: "org-b", documentId: "doc-b" })).toEqual([3]);
    // Another organization's id with this document's id selects nothing; a missing scope is refused.
    expect(await store.listHostPageImagePages({ orgId: "org-b", documentId: "doc-a" })).toEqual([]);
    expect(await store.listHostPageImagePages({ orgId: "org-a", documentId: "doc-b" })).toEqual([]);
    await expect(store.listHostPageImagePages({ orgId: "", documentId: "doc-a" })).rejects.toBeInstanceOf(DocumentAssetLedgerError);
    await expect(store.listHostPageImagePages({ orgId: "org-a", documentId: "doc-a' or 1=1 --" })).rejects.toBeInstanceOf(DocumentAssetLedgerError);
    // An earlier run's rows (kept until a newer full write) never decide this run's page images (core #357 with #376).
    await sql`delete from document_assets where document_id = 'doc-a'`;
    await insert("doc-a", "org-a", "proj-a", "p2.1", 2, "background", "unlinked", "scan-not-copyable", null, "run-a-old");
    expect(await store.listHostPageImagePages({ orgId: "org-a", documentId: "doc-a" })).toEqual([]);
    // Nor do a non-current level's.
    await insert("doc-a", "org-a", "proj-a", "p2.2", 2, "background", "unlinked", "scan-not-copyable");
    expect(await store.listHostPageImagePages({ orgId: "org-a", documentId: "doc-a" })).toEqual([2]);
    await sql`update document_extraction_levels set assets_current = false where document_id = 'doc-a'`;
    expect(await store.listHostPageImagePages({ orgId: "org-a", documentId: "doc-a" })).toEqual([]);
  });

  it("the resume queue lists only the asking organization's documents", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true }));
    await store.writeDocumentAssetLedger(await figureWrite(B, { partial: true }));
    expect((await listResumableDocuments(sql, { orgId: "org-a" })).map((row) => row.documentId)).toEqual(["doc-a"]);
    expect((await listResumableDocuments(sql, { orgId: "org-b" })).map((row) => row.documentId)).toEqual(["doc-b"]);
    expect(await listResumableDocuments(sql, { orgId: "org-a", projectId: "proj-b" })).toEqual([]);
    await expect(listResumableDocuments(sql, { orgId: "" })).rejects.toBeInstanceOf(DocumentAssetLedgerError);
  });
});

describe("refused writes write nothing", () => {
  it("rows outside the closed vocabulary or with free text", async () => {
    const write = await inMemory(await figureWrite(A));
    const bad = (patch: Record<string, unknown>) => ({ ...write, assets: write.assets.map((asset, i) => (i === 0 ? { ...asset, ...patch } : asset)) }) as DocumentAssetLedgerWrite;
    for (const patch of [
      { fate: "Quarterly earnings beat" }, { reason: "<script>" }, { linkPath: "javascript:alert(1)" }, { assetId: "p1.1; drop table" },
      { bytes: 1e12 }, { width: Number.POSITIVE_INFINITY }, { storageKey: null }, { bbox: [0, 0, 1] }, { obj: [-1, 0] },
      { bytes: 9 * 1024 * 1024 }, { source: "decode", format: "jpg" },
    ]) {
      await expect(store.writeDocumentAssetLedger(bad(patch))).rejects.toMatchObject({ rule: "invalid-assets" });
    }
    // scan-not-copyable only on an unlinked background image (rows: p1.1 extracted, p2.1 not-extracted, p2.2 unlinked).
    const badAt = (id: string, patch: Record<string, unknown>) => ({ ...write, assets: write.assets.map((asset) => (asset.assetId === id ? { ...asset, ...patch } : asset)) }) as DocumentAssetLedgerWrite;
    for (const [id, patch] of [
      ["p1.1", { reason: "scan-not-copyable" }], ["p2.1", { reason: "scan-not-copyable" }], ["p2.2", { reason: "scan-not-copyable" }],
      ["p2.2", { fate: "background", reason: "min_side" }], ["p2.2", { fate: "background", reason: "other" }],
      ["p2.2", { fate: "background", reason: "scan-not-copyable", repeatOf: "p1.1" }], ["p2.2", { repeatOf: "p1.1" }],
    ] as const) {
      await expect(store.writeDocumentAssetLedger(badAt(id, patch))).rejects.toMatchObject({ rule: "invalid-assets" });
    }
    await expect(store.writeDocumentAssetLedger({ ...write, assets: [...write.assets, write.assets[0]!] })).rejects.toMatchObject({ rule: "invalid-assets" });
    await expect(store.writeDocumentAssetLedger({ ...write, assets: Array.from({ length: 131_073 }, (_, i) => ({ ...write.assets[3]!, assetId: `p2.${i + 10}` })) })).rejects.toMatchObject({ rule: "invalid-assets" });
    await expect(store.writeDocumentAssetLedger({ ...write, level: { ...write.level, dopplerBuild: "x y" } })).rejects.toMatchObject({ rule: "invalid-level" });
    await expect(store.writeDocumentAssetLedger({ ...write, level: { ...write.level, imagesStatus: "resumable" } })).rejects.toMatchObject({ rule: "invalid-level" });
    await expect(store.writeDocumentAssetLedger({ ...write, scope: { ...A, orgId: "" } })).rejects.toMatchObject({ rule: "invalid-scope" });
    expect(await assets("doc-a")).toEqual([]);
    expect(await level("doc-a")).toBeUndefined();
  });

  it("a hostile manifest never reaches the ledger: the folder is refused before a write is built", async () => {
    await expect(figureWrite(A, { mutate: ({ manifest }) => { manifest.images[0]!.path = "../../../etc/passwd"; } })).rejects.toMatchObject({ rule: "manifest-image-invalid" });
    await expect(figureWrite(A, { mutate: ({ manifest }) => { manifest.images[0]!.fate = "Quarterly earnings beat"; } })).rejects.toMatchObject({ rule: "manifest-image-invalid" });
    // The legacy version 2 shape is refused the same way.
    await expect(figureWrite(A, { v2: true, mutate: ({ manifest }) => { manifest.images[0]!.path = "../../../etc/passwd"; } })).rejects.toMatchObject({ rule: "manifest-invalid" });
    expect(await assets("doc-a")).toEqual([]);
    expect(await level("doc-a")).toBeUndefined();
  });
});

describe("the write waits for the checkpoint (MEDIUM-4)", () => {
  it("markdown_complete is whether the committed checkpoint holds the document's Markdown", async () => {
    const write = await inMemory(await figureWrite(A));
    const pending: PendingAssetLedgerWrite = { level: write.level, assets: write.assets };
    const state = { run: { id: "run-a", orgId: "org-a", projectId: "proj-a" }, pendingAssetLedger: new Map([["doc-a", pending]]), artifactLedger: { readDocument: () => undefined as string | undefined } };
    expect((await flushAssetLedger(state, (w) => writeDocumentAssetLedger(sql, w))).get("doc-a")).toBe("written");
    expect(await level("doc-a")).toMatchObject({ markdown_complete: false });
    expect(state.pendingAssetLedger.size).toBe(0);
    state.pendingAssetLedger.set("doc-a", pending);
    state.artifactLedger.readDocument = () => "s3://b/ua/run-a/doc-a.md";
    await flushAssetLedger(state, (w) => writeDocumentAssetLedger(sql, w));
    expect(await level("doc-a")).toMatchObject({ markdown_complete: true });
  });

  it("a stale run's queued write is logged as stale-write and writes nothing", async () => {
    const write = await inMemory(await figureWrite(A));
    await sql`update documents set run_id = 'run-a-new' where id = 'doc-a'`;
    const state = { run: { id: "run-a", orgId: "org-a", projectId: "proj-a" }, pendingAssetLedger: new Map([["doc-a", { level: write.level, assets: write.assets }]]), artifactLedger: { readDocument: () => "x" } };
    expect((await flushAssetLedger(state, (w) => writeDocumentAssetLedger(sql, w))).get("doc-a")).toBe("stale-write");
    expect(await level("doc-a")).toBeUndefined();
  });
});

describe("resume from stored state (HIGH-2)", () => {
  it("rebuilds the --images-resume DIR from the stored folder and validates it against the v3 lines and the file set", async () => {
    const storage = memoryStorage();
    await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true, storage }));
    const [queued] = await listResumableDocuments(sql, { orgId: "org-a" });
    expect(queued?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    // What a resume worker does: download images/ (the manifest, then each extracted file by its derived key).
    const dir = path.join(await mkdtemp(path.join(work, "resume-")), "DIR");
    const rebuilt = await downloadDopplerImagesDir({
      storage, document: { id: "doc-a", userId: "ua", runId: "run-a" }, runId: "run-a", manifestSha256: queued!.manifestSha256!, pageCount: 3, dir, manifestOnly: false,
    });
    expect(rebuilt).toMatchObject({ files: 3 });
    // Exactly Doppler's DIR: manifest.jsonl and page folders, nothing else; the manifest bytes are the stored ones.
    expect((await readdir(dir)).sort()).toEqual(["manifest.jsonl", "page-0001", "page-0003"]);
    const manifestBytes = await readFile(path.join(dir, "manifest.jsonl"));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(queued!.manifestSha256);
    // The rebuilt DIR passes the same validation as the provider's folder: the v3 lines, their end hash and the file set.
    const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "partial", sourceSha256: V2_SOURCE_SHA });
    const stored = (await assets("doc-a")).filter((row) => row.stored).map((row) => row.asset_id);
    expect(set.files.map((file) => file.id).sort()).toEqual(stored.sort());
    // A stored object that changed since the ledger recorded it is refused.
    const key = "ua/run-a/doppler/doc-a/images/manifest.jsonl";
    storage.objects.set(key, Buffer.concat([storage.objects.get(key)!, Buffer.from(" ")]));
    await expect(downloadDopplerImagesDir({
      storage, document: { id: "doc-a", userId: "ua", runId: "run-a" }, runId: "run-a", manifestSha256: queued!.manifestSha256!, pageCount: 3,
      dir: path.join(work, "resume-changed"),
    })).rejects.toMatchObject({ rule: "manifest-changed" });
  });
});

// Keep the shared row type in use (the writer re-validates it).
export type { DocumentAsset };

describe("routing page facts go through the page-facts write (MEDIUM-6)", () => {
  it("text_layer and scan_class land whatever the figure setting, and a later write without them keeps them", async () => {
    const { buildRoutingPageFacts } = await import("../pipeline/page-facts.js");
    const layout = new Map<number, { textLayer?: string | null; scanClass?: string | null }>([
      [1, { textLayer: "visible" }], [3, { textLayer: "invisible", scanClass: "single" }], [2, { textLayer: "lots" }], [9, { textLayer: "none" }],
    ]);
    const rows = buildRoutingPageFacts({ documentId: "doc-a", runId: "run-a", pageCount: 3, layoutFacts: layout });
    // Out-of-vocabulary values and pages outside the document are dropped.
    expect(rows.map((row) => [row.pageNumber, row.textLayer, row.scanClass])).toEqual([[1, "visible", undefined], [3, "invisible", "single"]]);
    await store.upsertPageFacts(rows);
    await store.upsertPageFacts([{ documentId: "doc-a", runId: "run-a", pageNumber: 3, textBytes: 10, wordCount: 2, imageCount: 1, factsSource: "pdftotext" }]);
    expect(await sql`select page_number, text_layer, scan_class from document_page_facts where document_id = 'doc-a' order by page_number`).toEqual([
      { page_number: 1, text_layer: "visible", scan_class: null }, { page_number: 3, text_layer: "invisible", scan_class: "single" },
    ]);
    await sql`delete from document_page_facts where document_id = 'doc-a'`;
  });
});

describe("sharded documents: a record per shard, the level is the aggregate, resume per shard", () => {
  /** Read and store a two-shard folder (pages 1-2 and 3-3), as the figure step does, and queue-shape its write. */
  async function shardedWrite(options: { partial?: boolean } = {}): Promise<DocumentAssetLedgerWrite> {
    const built = v2Manifest({ partial: options.partial });
    const dir = await mkdtemp(path.join(work, "sharded-"));
    await writeShardedFolder(dir, [{ range: [1, 2], text: v3ShardText(built.manifest, [1, 2]) }, { range: [3, 3], text: v3ShardText(built.manifest, [3, 3]) }], built.files);
    const set = await readDopplerFigureDir(dir, { pageCount: 3 });
    const stored = await storeDopplerFigures({ storage: memoryStorage(), document: { id: "doc-a", userId: "ua", runId: "run-a" }, runId: "run-a", figures: set, markdown: "" });
    const pending = ledgerWriteForStoredFigures({ set, stored, outcome: { status: set.complete ? "extracted" : "partial", exitCode: set.complete ? 0 : 5, gaps: [{ first: 2, last: 2, reason: "plugin:shard-over-share" }] } });
    return { ...complete(A, pending), ...(pending.shards ? { shards: pending.shards } : {}) };
  }
  const shards = async () => sql`select first_page, last_page, images_status, assets_resumable, resumes, manifest_key from document_extraction_shards where document_id = 'doc-a' order by first_page`;

  it("writes the union of rows, one record per shard, and an aggregate level with the gaps", async () => {
    await store.writeDocumentAssetLedger(await shardedWrite({ partial: true }));
    expect((await assets("doc-a")).map((row) => row.asset_id)).toEqual(["p1.1", "p1.g1", "p2.1", "p2.2", "p3.1", "p3.2"]);
    expect(await shards()).toEqual([
      { first_page: 1, last_page: 2, images_status: "complete", assets_resumable: 0, resumes: 0, manifest_key: "ua/run-a/doppler/doc-a/images/shards/0001-0002/manifest.jsonl" },
      { first_page: 3, last_page: 3, images_status: "resumable", assets_resumable: 1, resumes: 0, manifest_key: "ua/run-a/doppler/doc-a/images/shards/0003-0003/manifest.jsonl" },
    ]);
    expect(await level("doc-a")).toMatchObject({ images_status: "resumable", manifest_key: null, assets_total: 6, assets_resumable: 1 });
    expect((await sql`select shards, gaps from document_extraction_levels where document_id = 'doc-a'`)[0]).toEqual({ shards: 2, gaps: [{ first: 2, last: 2, reason: "plugin:shard-over-share" }] });
    // Resume discovery names the shard, with its own manifest.
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toMatchObject([{ documentId: "doc-a", shard: { first: 3, last: 3 }, assetsResumable: 1 }]);
  });

  it("complete only if every shard is; a single-manifest write afterwards removes the shard records", async () => {
    await store.writeDocumentAssetLedger(await shardedWrite());
    expect(await level("doc-a")).toMatchObject({ images_status: "complete" });
    await store.writeDocumentAssetLedger(await figureWrite(A));
    expect(await shards()).toEqual([]);
    expect((await sql`select shards from document_extraction_levels where document_id = 'doc-a'`)[0]).toEqual({ shards: 0 });
  });

  it("a shard resume touches only its own rows and record, is counted per shard, and leaves the queue at the cap", async () => {
    await store.writeDocumentAssetLedger(await shardedWrite({ partial: true }));
    const full = await shardedWrite({ partial: true });
    const shard3 = full.shards!.filter((shard) => shard.first === 3);
    const rows3 = (await inMemory(full)).assets.filter((asset) => asset.pageNumber === 3);
    const resume = (): DocumentAssetLedgerWrite => ({ ...full, assets: rows3, shards: shard3, resume: { first: 3, last: 3 } });
    for (let i = 1; i <= DOCUMENT_ASSET_RESUME_CAP; i += 1) await store.writeDocumentAssetLedger(resume());
    expect((await shards()).map((row) => [row.first_page, row.resumes])).toEqual([[1, 0], [3, DOCUMENT_ASSET_RESUME_CAP]]);
    // Rows of the other shard were neither pruned nor rewritten.
    expect((await assets("doc-a")).map((row) => row.asset_id)).toEqual(["p1.1", "p1.g1", "p2.1", "p2.2", "p3.1", "p3.2"]);
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
    await expect(store.writeDocumentAssetLedger(resume())).rejects.toMatchObject({ rule: "resume-cap" });
    // A shard resume may not write another shard's pages.
    await expect(store.writeDocumentAssetLedger({ ...resume(), assets: (await inMemory(full)).assets })).rejects.toMatchObject({ rule: expect.stringMatching(/invalid-assets|resume-cap/) });
  }, 60_000);

  it("refuses a shard record whose key is not its folder's, or ranges that overlap", async () => {
    const write = await shardedWrite();
    await expect(store.writeDocumentAssetLedger({ ...write, shards: write.shards!.map((s) => ({ ...s, manifestKey: s.manifestKey.replace("ua/run-a/", "ub/run-b/") })) })).rejects.toMatchObject({ rule: "key-mismatch" });
    await expect(store.writeDocumentAssetLedger({ ...write, shards: [write.shards![0]!, { ...write.shards![1]!, first: 2 }] })).rejects.toMatchObject({ rule: expect.stringMatching(/invalid-level|key-mismatch/) });
    expect(await shards()).toEqual([]);
  });
});

describe("LOW-5: shard ranges and the document's total resume cap", () => {
  const H = "a".repeat(64);
  async function insertShards(resumes: number[], resumableFrom = 0) {
    // Shards are listed only under the current, resumable level of their run (MEDIUM-3).
    await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status, assets_total,
        assets_not_extracted, assets_resumable, shards)
      values ('doc-a', 'org-a', 'proj-a', 'run-a', true, 'resumable', 1, 1, 1, ${resumes.length})
      on conflict (document_id) do update set run_id = 'run-a', images_status = 'resumable', assets_total = 1, assets_extracted = 0,
        assets_not_extracted = 1, assets_unlinked = 0, assets_resumable = 1, assets_current = true, shards = excluded.shards`;
    for (const [i, n] of resumes.entries()) {
      const page = i + 1;
      const folder = `${String(page).padStart(4, "0")}-${String(page).padStart(4, "0")}`;
      const resumable = i >= resumableFrom;
      await sql`insert into document_extraction_shards (document_id, org_id, project_id, run_id, first_page, last_page, manifest_key, manifest_sha256,
          source_sha256, settings_sha256, images_status, assets_resumable, resumes)
        values ('doc-a', 'org-a', 'proj-a', 'run-a', ${page}, ${page}, ${`ua/run-a/doppler/doc-a/images/shards/${folder}/manifest.jsonl`}, ${H}, ${H}, ${H},
          ${resumable ? "resumable" : "complete"}, ${resumable ? 1 : 0}, ${n})`;
    }
  }

  it("a full write's shards start at page 1 and leave no hole", async () => {
    const shard = (first: number, last: number) => ({
      first, last, manifestKey: `ua/run-a/doppler/doc-a/images/shards/${String(first).padStart(4, "0")}-${String(last).padStart(4, "0")}/manifest.jsonl`,
      manifestSha256: H, sourceSha256: H, settingsSha256: H, imagesStatus: "complete" as const, assetsResumable: 0, lastCutPage: null, deadlineMs: null,
    });
    const write = (shards: ReturnType<typeof shard>[]): DocumentAssetLedgerWrite => ({ ...complete(A, ledgerWriteForNoFigures("none")), shards });
    await expect(store.writeDocumentAssetLedger(write([shard(1, 1), shard(3, 3)]))).rejects.toMatchObject({ rule: "invalid-level" });
    await expect(store.writeDocumentAssetLedger(write([shard(2, 3)]))).rejects.toMatchObject({ rule: "invalid-level" });
    expect(await sql`select 1 from document_extraction_shards where document_id = 'doc-a'`).toHaveLength(0);
  });

  it("past the backstop total (min(unit cap x shards, hard document cap)) no shard of the document is listed or resumed", async () => {
    // Each shard under its own cap, but DOCUMENT_ASSET_RESUME_TOTAL_CAP resumes in all.
    const unit = DOCUMENT_ASSET_RESUME_CAP - 1;
    const fullShards = Math.floor(DOCUMENT_ASSET_RESUME_TOTAL_CAP / unit);
    const rest = DOCUMENT_ASSET_RESUME_TOTAL_CAP - fullShards * unit;
    expect(Math.min(DOCUMENT_ASSET_RESUME_CAP * (fullShards + 1), DOCUMENT_ASSET_RESUME_TOTAL_CAP)).toBe(DOCUMENT_ASSET_RESUME_TOTAL_CAP);
    await insertShards([...Array.from({ length: fullShards }, () => unit), rest], 3);
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
    await sql`delete from document_extraction_shards`;
    // Under the total, the resumable shards are listed.
    await insertShards([unit, unit, unit, 2, 1], 3);
    expect((await listResumableDocuments(sql, { orgId: "org-a" })).map((row) => row.shard)).toEqual([{ first: 4, last: 4 }, { first: 5, last: 5 }]);
    await sql`delete from document_extraction_shards`;
  });
});

describe("PII withholding for files stored after the PII stage (HIGH-1)", () => {
  it("withholds only under a recorded redact or block outcome, and appends URIs without dropping the stage's own", async () => {
    await sql`update documents set metadata = '{}'::jsonb where id = 'doc-a'`;
    expect(await store.documentPiiWithholds("doc-a")).toBe(false);
    // Fail closed: no row, no answer to trust.
    expect(await store.documentPiiWithholds("doc-missing")).toBe(true);
    // No PII outcome to add to: refused, so the caller records nothing.
    await expect(store.appendWithheldArtifactUris("doc-a", ["s3://b/x"])).rejects.toThrow(/no PII outcome/);
    await sql`update documents set metadata = ${sql.json({ pii: { redacted: true, blocked: false, withheldArtifactUris: ["s3://b/ka"] } })} where id = 'doc-a'`;
    expect(await store.documentPiiWithholds("doc-a")).toBe(true);
    await store.appendWithheldArtifactUris("doc-a", ["s3://b/doppler/index.json", "s3://b/ka"]);
    await store.appendWithheldArtifactUris("doc-a", ["s3://b/doppler/images/manifest.jsonl"]);
    const [row] = await sql<{ metadata: { pii: { withheldArtifactUris: string[]; redacted: boolean } } }[]>`select metadata from documents where id = 'doc-a'`;
    expect(row!.metadata.pii.withheldArtifactUris).toEqual(["s3://b/doppler/images/manifest.jsonl", "s3://b/doppler/index.json", "s3://b/ka"]);
    expect(row!.metadata.pii.redacted).toBe(true);
    await sql`update documents set metadata = ${sql.json({ pii: { blocked: true, redacted: false, withheldArtifactUris: [] } })} where id = 'doc-a'`;
    expect(await store.documentPiiWithholds("doc-a")).toBe(true);
    await sql`update documents set metadata = '{}'::jsonb where id = 'doc-a'`;
  });
});
