import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DocumentAssetLedgerError, ledgerWriteForFailedFigures, ledgerWriteForStoredFigures, listResumableDocuments, recordFigureLedger,
  type DocumentAssetLedgerScope, type DocumentAssetLedgerWrite,
} from "../db/document-asset-ledger.js";
import { Store } from "../db/store.js";
import { readDopplerFigureDir, storeDopplerFigures } from "../extractors/doppler-figures.js";
import { v2Manifest, writeV2Folder, V2_SETTINGS_SHA, V2_SOURCE_SHA } from "../test/doppler-manifest-v2.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// The asset ledger (migration 0140) through the worker's real Store over a migrated database: org-scoped writes,
// idempotent re-runs and resumes, refusals that write nothing, and no way for one organization to touch another's rows.
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;
let work: string;

const A: DocumentAssetLedgerScope = { orgId: "org-a", projectId: "proj-a", documentId: "doc-a", runId: "run-a" };
const B: DocumentAssetLedgerScope = { orgId: "org-b", projectId: "proj-b", documentId: "doc-b", runId: "run-b" };

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub');
    insert into projects(id, org_id, user_id, name) values ('proj-a', 'org-a', 'ua', 'A'), ('proj-a2', 'org-a', 'ua', 'A2'), ('proj-b', 'org-b', 'ub', 'B');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents) values
      ('run-a', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1),
      ('run-b', 'org-b', 'ub', 'proj-b', 'upload', 'processing', 'extract', '{}', 1);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 3),
      ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'processing', 3),
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
  await sql`delete from document_page_facts`;
});

/** Read, store (in memory) and build the ledger write for a v2 folder, as the figure step does. */
async function figureWrite(scope: DocumentAssetLedgerScope, options: { partial?: boolean; mutate?: (m: ReturnType<typeof v2Manifest>) => void } = {}): Promise<DocumentAssetLedgerWrite> {
  const built = v2Manifest({ partial: options.partial });
  options.mutate?.(built);
  const dir = await mkdtemp(path.join(work, "figures-"));
  await writeV2Folder(dir, built.manifest, built.files);
  const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: options.partial ? "partial" : "complete" });
  const stored = await storeDopplerFigures({
    storage: { putBytes: async () => {}, putJson: async () => {}, uri: (key) => `s3://b/${key}` },
    document: { id: scope.documentId, userId: "u", runId: scope.runId! }, runId: scope.runId!, figures: set, markdown: "",
  });
  return ledgerWriteForStoredFigures({
    scope, manifest: set.manifest, assets: set.assets, keys: stored.keys,
    outcome: { status: options.partial ? "partial" : "extracted", exitCode: options.partial ? 5 : 0, build: "doppler-1.4.0+g1a2b3c4" },
    pages: [{ pageNumber: 1, textLayer: "visible" }, { pageNumber: 3, textLayer: "invisible", scanClass: "single" }],
  });
}

const assets = async (documentId: string) => sql<Array<Record<string, unknown>>>`
  select asset_id, org_id, project_id, status, reason, resumable, source, file_of, link_path, storage_key is not null as stored
  from document_assets where document_id = ${documentId} order by asset_id`;
const level = async (documentId: string) => (await sql<Array<Record<string, unknown>>>`
  select org_id, images_status, images_exit_code, manifest_version, doppler_build, markdown_complete, facts_level, source_sha256,
    settings_sha256, resumes, last_cut_page, deadline_ms, assets_total, assets_extracted, assets_not_extracted, assets_unlinked,
    assets_resumable, source_copy, source_decode, source_render, asset_bytes::int as asset_bytes
  from document_extraction_levels where document_id = ${documentId}`)[0];

describe("writing the ledger", () => {
  it("writes every image and the extraction level with counts per status and source", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A));
    expect(await assets("doc-a")).toEqual([
      { asset_id: "p1.1", org_id: "org-a", project_id: "proj-a", status: "extracted", reason: null, resumable: false, source: "render", file_of: "p1.1", link_path: "images/page-0001/image-001.webp", stored: true },
      { asset_id: "p1.g1", org_id: "org-a", project_id: "proj-a", status: "extracted", reason: null, resumable: false, source: "render", file_of: "p1.g1", link_path: "images/page-0001/figure-001.svg", stored: true },
      { asset_id: "p2.1", org_id: "org-a", project_id: "proj-a", status: "not-extracted", reason: "repeat", resumable: false, source: null, file_of: "p1.1", link_path: "images/page-0001/image-001.webp", stored: false },
      { asset_id: "p2.2", org_id: "org-a", project_id: "proj-a", status: "unlinked", reason: null, resumable: false, source: null, file_of: null, link_path: null, stored: false },
      { asset_id: "p3.1", org_id: "org-a", project_id: "proj-a", status: "extracted", reason: null, resumable: false, source: "copy", file_of: "p3.1", link_path: "images/page-0003/image-001.jpg", stored: true },
    ]);
    expect(await level("doc-a")).toMatchObject({
      org_id: "org-a", images_status: "complete", images_exit_code: 0, manifest_version: 2, doppler_build: "doppler-1.4.0+g1a2b3c4",
      markdown_complete: true, facts_level: "none", source_sha256: V2_SOURCE_SHA, settings_sha256: V2_SETTINGS_SHA, resumes: 0,
      last_cut_page: null, deadline_ms: 121_500, assets_total: 5, assets_extracted: 3, assets_not_extracted: 1, assets_unlinked: 1,
      assets_resumable: 0, source_copy: 1, source_decode: 0, source_render: 2,
    });
    expect((await level("doc-a"))!.asset_bytes).toBeGreaterThan(0);
    expect(await sql`select page_number, text_layer, scan_class from document_page_facts where document_id = 'doc-a' order by page_number`).toEqual([
      { page_number: 1, text_layer: "visible", scan_class: null }, { page_number: 3, text_layer: "invisible", scan_class: "single" },
    ]);
  });

  it("is idempotent: the same write twice leaves the same rows", async () => {
    const write = await figureWrite(A);
    await store.writeDocumentAssetLedger(write);
    const first = await assets("doc-a");
    await store.writeDocumentAssetLedger(write);
    expect(await assets("doc-a")).toEqual(first);
    expect(await level("doc-a")).toMatchObject({ assets_total: 5 });
  });

  it("a partial run (exit 5) is resumable, not failed, and a resume updates the same rows in place", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A, { partial: true }));
    expect(await level("doc-a")).toMatchObject({ images_status: "resumable", images_exit_code: 5, assets_resumable: 1, last_cut_page: 3 });
    expect((await assets("doc-a")).find((row) => row.asset_id === "p3.2")).toMatchObject({ status: "not-extracted", reason: "budget", resumable: true, stored: false });
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toMatchObject([{ documentId: "doc-a", projectId: "proj-a", assetsResumable: 1, lastCutPage: 3, sourceSha256: V2_SOURCE_SHA }]);

    // The resume extracted p3.2: same ids, new status, resumes counted.
    const resumed = await figureWrite(A, {
      mutate: ({ manifest, files }) => {
        const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
        bytes.writeUInt32LE(bytes.length - 8, 4);
        files.set("page-0003/image-002.webp", bytes);
        manifest.images.push({ id: "p3.2", page: 3, bbox: [10, 20, 110, 220], kind: "picture", fate: "inline", obj: [12, 0], path: "page-0003/image-002.webp", link: "images/page-0003/image-002.webp", status: "extracted", format: "webp", source: "render", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: 10, height: 10 });
        manifest.resumes = 1;
        manifest.totals.images += 1;
        manifest.totals.extracted += 1;
      },
    });
    const before = (await sql<{ created_at: string }[]>`select created_at::text from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`)[0]!.created_at;
    await store.writeDocumentAssetLedger(resumed);
    expect(await level("doc-a")).toMatchObject({ images_status: "complete", resumes: 1, assets_resumable: 0, assets_extracted: 4 });
    expect((await assets("doc-a")).find((row) => row.asset_id === "p3.2")).toMatchObject({ status: "extracted", resumable: false, stored: true });
    expect((await sql<{ created_at: string }[]>`select created_at::text from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`)[0]!.created_at).toBe(before);
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
  });

  it("a version 1 folder maps into the ledger with what it has", async () => {
    const dir = await mkdtemp(path.join(work, "v1-"));
    await cp(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-figures"), dir, { recursive: true });
    const set = await readDopplerFigureDir(dir, { pageCount: 5, expect: "complete" });
    const stored = await storeDopplerFigures({
      storage: { putBytes: async () => {}, putJson: async () => {}, uri: (key) => `s3://b/${key}` },
      document: { id: "doc-a", userId: "ua", runId: "run-a" }, runId: "run-a", figures: set, markdown: "",
    });
    await store.writeDocumentAssetLedger(ledgerWriteForStoredFigures({ scope: A, manifest: set.manifest, assets: set.assets, keys: stored.keys, outcome: { status: "extracted" } }));
    expect((await assets("doc-a")).map((row) => [row.asset_id, row.status, row.reason, row.file_of, row.link_path, row.stored])).toEqual([
      ["p3.1", "extracted", null, "p3.1", null, true],
      ["p3.g2", "extracted", null, "p3.g2", null, true],
      ["p4.1", "not-extracted", "repeat", "p3.1", null, false],
      ["p5.2", "not-extracted", "error", null, null, false],
      ["p5.g1", "extracted", null, "p5.g1", null, true],
    ]);
    expect(await level("doc-a")).toMatchObject({ images_status: "complete", manifest_version: 1, images_exit_code: null, source_sha256: null, assets_total: 5, assets_extracted: 3, source_render: 3 });
  });

  it("a failed step clears older rows and records the images as failed", async () => {
    await store.writeDocumentAssetLedger(await figureWrite(A));
    await store.writeDocumentAssetLedger(ledgerWriteForFailedFigures({ scope: A, outcome: { exitCode: 6 } }));
    expect(await assets("doc-a")).toEqual([]);
    expect(await level("doc-a")).toMatchObject({ images_status: "failed", images_exit_code: 6, manifest_version: null, assets_total: 0 });
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

  it("a document without an organization can have no rows", async () => {
    await expect(store.writeDocumentAssetLedger(await figureWrite({ ...A, documentId: "doc-orphan" }))).rejects.toMatchObject({ rule: "scope-mismatch" });
    const status = await recordFigureLedger({ store, run: { id: "run-a", orgId: null, projectId: "proj-a" }, documentId: "doc-a", build: () => { throw new Error("never built"); } });
    expect(status).toBe("no-scope");
  });

  it("the database refuses a row whose organization is not its document's, even written directly", async () => {
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status)
      values ('doc-a', 'org-b', 'proj-b', 'p1.1', 1, 'picture', 'block', 'unlinked')`).rejects.toMatchObject({ code: "23503" });
    await expect(sql`insert into document_extraction_levels (document_id, org_id, project_id) values ('doc-a', 'org-b', 'proj-a')`)
      .rejects.toMatchObject({ code: "23503" });
    // And a storage key outside the row's own document folder.
    await expect(sql`insert into document_assets (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, source, format, bytes, sha256, width, height, file_of, storage_key)
      values ('doc-a', 'org-a', 'proj-a', 'p1.1', 1, 'picture', 'block', 'extracted', 'render', 'webp', 10, ${"e".repeat(64)}, 1, 1, 'p1.1', 'ub/run-b/doppler-figures/doc-b/p1.1.webp')`)
      .rejects.toMatchObject({ code: "23514" });
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
    const write = await figureWrite(A);
    const bad = (patch: Record<string, unknown>) => ({ ...write, assets: write.assets.map((asset, i) => (i === 0 ? { ...asset, ...patch } : asset)) }) as DocumentAssetLedgerWrite;
    for (const patch of [
      { fate: "Quarterly earnings beat" }, { reason: "<script>" }, { linkPath: "javascript:alert(1)" }, { assetId: "p1.1; drop table" },
      { storageKey: "ub/run-b/doppler-figures/doc-b/p1.1.webp" }, { storageKey: `x/doppler-figures/doc-a/../doc-b/p1.1.webp` }, { bytes: 1e12 },
      { width: Number.POSITIVE_INFINITY },
    ]) {
      await expect(store.writeDocumentAssetLedger(bad(patch))).rejects.toMatchObject({ rule: "invalid-assets" });
    }
    await expect(store.writeDocumentAssetLedger({ ...write, assets: [...write.assets, write.assets[0]!] })).rejects.toMatchObject({ rule: "invalid-assets" });
    await expect(store.writeDocumentAssetLedger({ ...write, assets: Array.from({ length: 16_385 }, () => write.assets[3]!) })).rejects.toMatchObject({ rule: "invalid-assets" });
    await expect(store.writeDocumentAssetLedger({ ...write, level: { ...write.level, dopplerBuild: "x y" } })).rejects.toMatchObject({ rule: "invalid-level" });
    await expect(store.writeDocumentAssetLedger({ ...write, level: { ...write.level, imagesStatus: "resumable" } })).rejects.toMatchObject({ rule: "invalid-level" });
    await expect(store.writeDocumentAssetLedger({ ...write, pages: [{ pageNumber: 1, textLayer: "lots" as never }] })).rejects.toMatchObject({ rule: "invalid-pages" });
    await expect(store.writeDocumentAssetLedger({ ...write, scope: { ...A, orgId: "" } })).rejects.toMatchObject({ rule: "invalid-scope" });
    expect(await assets("doc-a")).toEqual([]);
    expect(await level("doc-a")).toBeUndefined();
  });

  it("a hostile manifest never reaches the ledger: the folder is refused before a write is built", async () => {
    await expect(figureWrite(A, { mutate: ({ manifest }) => { manifest.images[0]!.path = "../../../etc/passwd"; } })).rejects.toMatchObject({ rule: "manifest-invalid" });
    await expect(figureWrite(A, { mutate: ({ manifest }) => { manifest.images[0]!.fate = "Quarterly earnings beat"; } })).rejects.toMatchObject({ rule: "manifest-invalid" });
    expect(await assets("doc-a")).toEqual([]);
    expect(await level("doc-a")).toBeUndefined();
  });
});
