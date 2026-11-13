import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adoptPendingAssets, figureLedgerHooks, ledgerWriteForFailedFigures, ledgerWriteForNoFigures, ledgerWriteForStoredFigures, markAssetsPending,
  writeDocumentAssetLedger, type DocumentAssetLedgerScope,
} from "../db/document-asset-ledger.js";
import { Store } from "../db/store.js";
import { listResumableDocuments, replaceUnvouchedObject } from "../db/document-asset-ledger.js";
import { firstPassBatchOptions } from "../pipeline/first-pass.js";
import { projectFiguresEnabled } from "@docslurp/shared";
import { DopplerFigureStoreError, downloadDopplerImagesDir, readDopplerFigureDir, readLedgerSpill, storeDopplerFigures } from "../extractors/doppler-figures.js";
import { v2Manifest, v3Text, writeV3Folder, V2_SOURCE_SHA } from "../test/doppler-manifest-v2.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// Figures kept on every failure path (migration 0143), with the worker's real Store over a migrated database and crash
// injection: pending rows before each upload step and stored after it; nothing deleted on failure; the next attempt
// adopts by streamed SHA-256 with no VM; conditional creates never overwrite; a resume only adds; tenants never mix.
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;
let work: string;

const A: DocumentAssetLedgerScope = { orgId: "org-a", projectId: "proj-a", documentId: "doc-a", runId: "run-a" };
const B: DocumentAssetLedgerScope = { orgId: "org-b", projectId: "proj-b", documentId: "doc-b", runId: "run-b" };
const DOC_A = { id: "doc-a", userId: "ua", runId: "run-a" };
const ROOT_A = "ua/run-a/doppler/doc-a/images";

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub');
    insert into projects(id, org_id, user_id, name) values ('proj-a', 'org-a', 'ua', 'A'), ('proj-b', 'org-b', 'ub', 'B');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, created_at) values
      ('run-a', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1, now() - interval '1 hour'),
      ('run-a2', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1, now()),
      ('run-b', 'org-b', 'ub', 'proj-b', 'upload', 'processing', 'extract', '{}', 1, now());
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 3),
      ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'processing', 3);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  work = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "figure-storage-state-"));
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql`delete from document_assets`;
  await sql`delete from document_extraction_shards`;
  await sql`delete from document_extraction_levels`;
  await sql`update documents set run_id = 'run-a', status = 'processing' where id = 'doc-a'`;
});

/** An object store in memory with conditional creates and streamed reads, recording every write and delete. */
function memoryStorage(options: { failAfterPuts?: number; conditional?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const puts: string[] = [];
  const deletes: string[] = [];
  let onPut: ((key: string) => void) | null = null;
  const put = (key: string, data: Uint8Array) => {
    if (puts.length >= (options.failAfterPuts ?? Number.POSITIVE_INFINITY)) throw Object.assign(new Error("storage unavailable"), { code: "SlowDown" });
    puts.push(key);
    objects.set(key, Buffer.from(data));
    onPut?.(key);
  };
  return {
    objects, puts, deletes,
    onPut(hook: (key: string) => void) { onPut = hook; },
    putBytes: async (key: string, data: Uint8Array) => { put(key, data); },
    putJson: async (key: string, value: unknown) => { put(key, Buffer.from(JSON.stringify(value))); },
    ...(options.conditional === false ? {} : {
      putBytesIfAbsent: async (key: string, data: Uint8Array) => {
        if (objects.has(key)) return "exists" as const;
        put(key, data);
        return "created" as const;
      },
    }),
    deleteKeys: async (keys: string[]) => { deletes.push(...keys); for (const key of keys) objects.delete(key); },
    getBytes: async (key: string) => { const value = objects.get(key); if (!value) throw Object.assign(new Error("missing"), { name: "NoSuchKey" }); return value; },
    openStream: async (key: string) => {
      const value = objects.get(key);
      if (!value) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { stream: (async function* () { yield value; })(), size: value.length };
    },
    uri: (key: string) => `s3://b/${key}`,
  };
}

async function folder(options: { partial?: boolean } = {}): Promise<string> {
  const built = v2Manifest({ partial: options.partial });
  const dir = await mkdtemp(path.join(work, "figures-"));
  await writeV3Folder(dir, v3Text(built.manifest), built.files);
  return dir;
}

const hooks = (scope: DocumentAssetLedgerScope) => figureLedgerHooks({ store, run: { id: scope.runId, orgId: scope.orgId, projectId: scope.projectId } }, scope.documentId)!;

/** The figure step as the stage runs it: read, then store with the ledger beside each upload step. */
async function storeStep(storage: ReturnType<typeof memoryStorage>, options: { partial?: boolean; scope?: DocumentAssetLedgerScope; signal?: AbortSignal } = {}) {
  const scope = options.scope ?? A;
  const set = await readDopplerFigureDir(await folder(options), { pageCount: 3, expect: options.partial ? "partial" : "complete" });
  const stored = await storeDopplerFigures({
    storage, document: { id: scope.documentId, userId: scope === A ? "ua" : "ub", runId: scope.runId }, runId: scope.runId, figures: set, markdown: "",
    ledger: hooks(scope), signal: options.signal,
  });
  return { set, stored };
}

const rows = async (documentId = "doc-a") => sql<Array<{ asset_id: string; status: string; storage_state: string; storage_key: string | null; reason: string | null; resumable: boolean; run_id: string | null }>>`
  select asset_id, status, storage_state, storage_key, reason, resumable, run_id from document_assets where document_id = ${documentId} order by asset_id`;
const level = async (documentId = "doc-a") => (await sql<Array<Record<string, unknown>>>`
  select run_id, images_status, markdown_complete, asset_bytes::float8 as asset_bytes, assets_extracted, assets_resumable, assets_total
  from document_extraction_levels where document_id = ${documentId}`)[0];
const figureKeys = (storage: ReturnType<typeof memoryStorage>) => [...storage.objects.keys()].filter((key) => /\/page-\d{4}\//.test(key)).sort();

describe("figures are kept and recorded before anything else can fail", () => {
  it("each file is pending before its upload and stored after it, under Doppler's exact layout; the level is honest before any Markdown", async () => {
    const storage = memoryStorage();
    const seen: string[] = [];
    storage.onPut((key) => { if (/\/page-\d{4}\//.test(key)) seen.push(key); });
    const pendingAtPut: string[] = [];
    const real = storage.putBytesIfAbsent!;
    storage.putBytesIfAbsent = async (key, data) => {
      const [row] = await sql<{ storage_state: string }[]>`select storage_state from document_assets where storage_key = ${key}`;
      pendingAtPut.push(row?.storage_state ?? "missing");
      return await real(key, data);
    };
    await storeStep(storage);
    // Doppler's own layout: the stored folder is a plain --images-resume DIR and the Markdown's links resolve.
    expect(figureKeys(storage)).toEqual([`${ROOT_A}/page-0001/figure-001.svg`, `${ROOT_A}/page-0001/image-001.webp`, `${ROOT_A}/page-0003/image-001.jpg`]);
    expect(pendingAtPut).toEqual(["pending", "pending", "pending"]);
    expect((await rows()).filter((row) => row.status === "extracted").map((row) => row.storage_state)).toEqual(["stored", "stored", "stored"]);
    const fileBytes = figureKeys(storage).reduce((sum, key) => sum + storage.objects.get(key)!.length, 0);
    // No checkpoint has run: the level is this run's, Markdown not complete, bytes of the stored files only.
    expect(await level()).toMatchObject({ run_id: "run-a", markdown_complete: false, images_status: "partial", asset_bytes: fileBytes, assets_extracted: 3 });
    expect(storage.deletes).toEqual([]);
  });

  it("Markdown, a later stage (embed), a cancelled run or a failed document never deletes them; the status stays honest", async () => {
    const storage = memoryStorage();
    await storeStep(storage);
    const before = await rows();
    // What those failures leave: the failure write is level-only, the checkpoint never commits, the document fails.
    await writeDocumentAssetLedger(sql, { scope: A, ...ledgerWriteForFailedFigures({ outcome: { exitCode: 6 } }), level: { ...ledgerWriteForFailedFigures({ outcome: { exitCode: 6 } }).level, markdownComplete: false } });
    await sql`update documents set status = 'failed' where id = 'doc-a'`;
    expect(await rows()).toEqual(before);
    expect(await level()).toMatchObject({ images_status: "partial", markdown_complete: false, assets_extracted: 3 });
    expect(figureKeys(storage)).toHaveLength(3);
    expect(storage.deletes).toEqual([]);
  });

  it("the checkpoint's full write completes the same rows (Markdown committed) without re-uploading anything", async () => {
    const storage = memoryStorage();
    const { set, stored } = await storeStep(storage);
    const pending = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "extracted", exitCode: 0 } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...pending.level, markdownComplete: true }, assets: pending.assets });
    expect(await level()).toMatchObject({ images_status: "complete", markdown_complete: true, assets_extracted: 3 });
    expect((await rows()).filter((row) => row.status === "extracted").every((row) => row.storage_state === "stored")).toBe(true);
  });
});

describe("crash injection", () => {
  it("killed between upload and the stored flip: the next attempt adopts by SHA-256 with no VM; missing or tampered objects become resumable", async () => {
    const storage = memoryStorage();
    const set = await readDopplerFigureDir(await folder(), { pageCount: 3, expect: "complete" });
    const extracted = [];
    for await (const row of readLedgerSpill(set.ledger.spill)) if (row.status === "extracted") extracted.push(row);
    await markAssetsPending(sql, { scope: A, rows: extracted });
    const pending = await rows();
    const keyOf = (id: string) => pending.find((row) => row.asset_id === id)!.storage_key!;
    // One upload landed; one key holds other bytes; one never landed. Then the worker died: no flip, no commit.
    storage.objects.set(keyOf("p1.1"), v2Manifest().files.get("page-0001/image-001.webp")!);
    storage.objects.set(keyOf("p1.g1"), Buffer.from("<svg>tampered</svg>"));
    expect(await adoptPendingAssets(sql, storage, { scope: A })).toEqual({ adopted: 1, lost: 2, kept: 0 });
    const after = await rows();
    expect(after.find((row) => row.asset_id === "p1.1")).toMatchObject({ status: "extracted", storage_state: "stored" });
    expect(after.find((row) => row.asset_id === "p1.g1")).toMatchObject({ status: "not-extracted", reason: "aborted", resumable: true, storage_state: "none", storage_key: null });
    expect(after.find((row) => row.asset_id === "p3.1")).toMatchObject({ status: "not-extracted", reason: "aborted", resumable: true });
    // Adoption deletes nothing: the tampered object waits for the orphan GC.
    expect(storage.objects.has(keyOf("p1.g1"))).toBe(true);
    expect(storage.deletes).toEqual([]);
  });

  it("a storage failure or a cancellation mid-upload deletes nothing; the retry adopts and finishes", async () => {
    const failing = memoryStorage({ failAfterPuts: 1 });
    const error = await storeStep(failing).catch((e) => e);
    expect(error).toBeInstanceOf(DopplerFigureStoreError);
    expect(error).toMatchObject({ reason: "store-object-failed", cleanup: "kept" });
    expect(failing.deletes).toEqual([]);
    expect(failing.objects.size).toBe(1);
    expect((await rows()).filter((row) => row.storage_state === "pending").length).toBeGreaterThan(0);

    const controller = new AbortController();
    const cancelled = memoryStorage();
    cancelled.onPut(() => controller.abort());
    await expect(storeStep(cancelled, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.deletes).toEqual([]);

    // The retry: whatever landed is adopted (no VM), the rest uploaded; an object already there is never overwritten.
    const retry = memoryStorage();
    for (const [key, value] of cancelled.objects) retry.objects.set(key, value);
    expect((await adoptPendingAssets(sql, retry, { scope: A })).adopted).toBe(cancelled.objects.size);
    await storeStep(retry);
    expect((await rows()).filter((row) => row.status === "extracted").every((row) => row.storage_state === "stored")).toBe(true);
    for (const key of cancelled.objects.keys()) expect(retry.puts).not.toContain(key);
  });
});

describe("conditional creates", () => {
  it("an object already at the key is accepted only with the manifest's bytes, never overwritten", async () => {
    const storage = memoryStorage();
    const key = `${ROOT_A}/page-0001/image-001.webp`;
    storage.objects.set(key, Buffer.from("RIFF....WEBP other bytes"));
    const error = await storeStep(storage).catch((e) => e);
    expect(error).toMatchObject({ rule: "object-conflict" });
    expect(storage.objects.get(key)!.toString()).toBe("RIFF....WEBP other bytes");
    expect(storage.puts).not.toContain(key);
    expect(storage.deletes).toEqual([]);
    // The same bytes already there (a replayed upload): accepted, not rewritten.
    const same = memoryStorage();
    same.objects.set(key, v2Manifest().files.get("page-0001/image-001.webp")!);
    await storeStep(same);
    expect(same.puts).not.toContain(key);
  });

  it("without conditional creates the store still writes under the run's own root (a stale run is refused by the ledger)", async () => {
    const storage = memoryStorage({ conditional: false });
    await storeStep(storage);
    expect(figureKeys(storage).every((key) => key.startsWith("ua/run-a/"))).toBe(true);
    // A run that is no longer the document's current one cannot record anything.
    await sql`update documents set run_id = 'run-a2' where id = 'doc-a'`;
    await expect(storeStep(memoryStorage())).rejects.toMatchObject({ reason: "store-object-failed" });
  });
});

describe("resumes only add; levels are the current run's", () => {
  it("a resume write naming another file for a stored image is resume-rewrite, and never prunes a stored file", async () => {
    const storage = memoryStorage();
    const { set, stored } = await storeStep(storage, { partial: true });
    const full = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5 } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...full.level, markdownComplete: true }, assets: full.assets });
    const second = await readDopplerFigureDir(await folder({ partial: true }), { pageCount: 3, expect: "partial" });
    const rowsIn = [];
    for await (const row of readLedgerSpill(second.ledger.spill)) rowsIn.push({ ...row, storageKey: null });
    const p11 = rowsIn.find((row) => row.assetId === "p1.1")!;
    Object.assign(p11, { sha256: "f".repeat(64) });
    await expect(writeDocumentAssetLedger(sql, { scope: A, level: { ...full.level, markdownComplete: true }, assets: rowsIn.map((row) => row.status === "extracted" ? { ...row, storageKey: `${ROOT_A}/${row.linkPath!.slice("images/".length)}` } : row), resume: true }))
      .rejects.toMatchObject({ rule: "resume-rewrite" });
    // A resume that omits a stored image never prunes it.
    const without = rowsIn.filter((row) => row.assetId !== "p1.g1").map((row) => row.assetId === "p1.1" ? { ...row, sha256: set.files.find((f) => f.id === "p1.1")!.sha256 } : row)
      .map((row) => row.status === "extracted" ? { ...row, storageKey: `${ROOT_A}/${row.linkPath!.slice("images/".length)}` } : row);
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...full.level, markdownComplete: true }, assets: without, resume: true });
    expect((await rows()).find((row) => row.asset_id === "p1.g1")).toMatchObject({ storage_state: "stored" });
  });

  it("a re-run that skips the figure step takes the document off the resume queue; earlier rows are kept but not current (MEDIUM-3)", async () => {
    const storage = memoryStorage();
    const { set, stored } = await storeStep(storage, { partial: true });
    const full = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5 } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...full.level, markdownComplete: true }, assets: full.assets });
    expect(await level()).toMatchObject({ images_status: "resumable" });
    await sql`update documents set run_id = 'run-a2' where id = 'doc-a'`;
    const write = ledgerWriteForNoFigures("disabled");
    await writeDocumentAssetLedger(sql, { scope: { ...A, runId: "run-a2" }, level: { ...write.level, markdownComplete: true }, assets: write.assets, levelOnly: true });
    expect(await level()).toMatchObject({ run_id: "run-a2", images_status: "disabled", assets_total: 0, asset_bytes: 0, assets_resumable: 0 });
    // The earlier run's rows and objects stay (unserved, unbilled) for the orphan GC or the run's purge.
    expect((await rows()).every((row) => row.run_id === "run-a")).toBe(true);
    expect(figureKeys(storage)).toHaveLength(3);
  });
});

describe("gaps: page ranges with no manifest are resumable work", () => {
  it("a gap makes the level resumable and a discovery unit; a gap resume creates its shard and clears the gap; outside a gap it is refused", async () => {
    const storage = memoryStorage();
    const { set, stored } = await storeStep(storage);
    const full = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5, gaps: [{ first: 2, last: 3, reason: "plugin:shard-over-share" }] } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...full.level, markdownComplete: true }, assets: full.assets });
    expect(await level()).toMatchObject({ images_status: "resumable", assets_resumable: 0 });
    const units = await listResumableDocuments(sql, { orgId: "org-a" });
    expect(units).toEqual([expect.objectContaining({ documentId: "doc-a", gap: true, shard: { first: 2, last: 3 }, manifestSha256: null })]);
    const shard = (first: number, last: number) => ({
      first, last, manifestKey: `ua/run-a/doppler/doc-a/images/shards/${String(first).padStart(4, "0")}-${String(last).padStart(4, "0")}/manifest.jsonl`,
      manifestSha256: "c".repeat(64), sourceSha256: V2_SOURCE_SHA, settingsSha256: "d".repeat(64), imagesStatus: "complete" as const,
      assetsResumable: 0, lastCutPage: null, deadlineMs: null,
    });
    const level0 = { ...full.level, markdownComplete: true, manifest: null, gaps: [] };
    // Outside every gap: refused, nothing changes.
    await expect(writeDocumentAssetLedger(sql, { scope: A, level: level0, assets: [], resume: { first: 1, last: 1 }, shards: [shard(1, 1)] }))
      .rejects.toMatchObject({ rule: "invalid-level" });
    // The gap's fresh pass: its shard is created, the gap goes, the level is complete.
    await writeDocumentAssetLedger(sql, { scope: A, level: level0, assets: [], resume: { first: 2, last: 3 }, shards: [shard(2, 3)] });
    const [after] = await sql<{ images_status: string; gaps: unknown }[]>`select images_status, gaps from document_extraction_levels where document_id = 'doc-a'`;
    expect(after).toMatchObject({ images_status: "complete" });
    expect(after!.gaps ?? []).toEqual([]);
    expect(await sql`select first_page, last_page, resumes from document_extraction_shards where document_id = 'doc-a'`).toEqual([{ first_page: 2, last_page: 3, resumes: 1 }]);
    // Stored images of the other pages were never touched by the gap's resume.
    expect((await rows()).filter((row) => row.status === "extracted").every((row) => row.storage_state === "stored")).toBe(true);
  });

  it("a re-run without the figure step clears gaps with the rest (off the queue)", async () => {
    const storage = memoryStorage();
    const { set, stored } = await storeStep(storage);
    const full = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5, gaps: [{ first: 3, last: 3, reason: "plugin:doc-pass-budget" }] } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...full.level, markdownComplete: true }, assets: full.assets });
    const write = ledgerWriteForNoFigures("disabled");
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...write.level, markdownComplete: true }, assets: write.assets, levelOnly: true });
    expect(await level()).toMatchObject({ images_status: "disabled" });
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
  });
});

describe("council fix round (#357)", () => {
  it("pending rows a crash left are resumable work (M3): the level is resumable and discovery lists the document for a VM-less adopt", async () => {
    const set = await readDopplerFigureDir(await folder(), { pageCount: 3, expect: "complete" });
    const extracted = [];
    for await (const row of readLedgerSpill(set.ledger.spill)) if (row.status === "extracted") extracted.push(row);
    await markAssetsPending(sql, { scope: A, rows: extracted });
    // The worker died before any flip; the stage's failure write is level-only.
    await writeDocumentAssetLedger(sql, { scope: A, ...ledgerWriteForFailedFigures({ outcome: {} }), level: { ...ledgerWriteForFailedFigures({ outcome: {} }).level, markdownComplete: false } });
    const [row] = await sql<{ images_status: string; assets_pending: number }[]>`select images_status, assets_pending from document_extraction_levels where document_id = 'doc-a'`;
    expect(row).toEqual({ images_status: "resumable", assets_pending: 3 });
    // An unsharded level needs a stored manifest to be a resume unit; pending-only work is adopted by the audit.
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
  });

  it("a fresh full write that commits on a newer run queues the earlier run's figure folder; a resume or a failure never does (Q2)", async () => {
    const storage = memoryStorage();
    const first = await storeStep(storage);
    const w1 = ledgerWriteForStoredFigures({ set: first.set, stored: first.stored, outcome: { status: "extracted", exitCode: 0 } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...w1.level, markdownComplete: true }, assets: w1.assets });
    await sql`delete from storage_cleanup_queue`;
    // The document moves to run-a2; a failed figure step there queues nothing.
    await sql`update documents set run_id = 'run-a2' where id = 'doc-a'`;
    const A2 = { ...A, runId: "run-a2" };
    await writeDocumentAssetLedger(sql, { scope: A2, ...ledgerWriteForFailedFigures({ outcome: {} }), level: { ...ledgerWriteForFailedFigures({ outcome: {} }).level, markdownComplete: true } });
    expect(await sql`select target from storage_cleanup_queue`).toEqual([]);
    // A pending write of run-a2 never rewrites run-a's stored, still-served rows (M5).
    const before = await rows();
    await markAssetsPending(sql, { scope: A2, rows: (await inMemoryRows(first.set)).filter((r) => r.status === "extracted") });
    expect(await rows()).toEqual(before);
    // run-a2's full write commits: run-a's folder is queued.
    const second = await storeStep(memoryStorage(), { scope: A2 });
    const w2 = ledgerWriteForStoredFigures({ set: second.set, stored: second.stored, outcome: { status: "extracted", exitCode: 0 } });
    await writeDocumentAssetLedger(sql, { scope: A2, level: { ...w2.level, markdownComplete: true }, assets: w2.assets });
    expect(await sql`select kind, target from storage_cleanup_queue`).toEqual([{ kind: "doppler_folder", target: "ua/run-a/doppler/doc-a/" }]);
    await sql`delete from storage_cleanup_queue`;
  });

  it("repair: an object of other bytes is replaced under the document lock only when no stored row vouches for it (M4)", async () => {
    const storage = memoryStorage();
    await storeStep(storage);
    const key = `${ROOT_A}/page-0001/image-001.webp`;
    // A stored row vouches: never replaced.
    await expect(replaceUnvouchedObject(sql, { scope: A, key, replace: async () => { throw new Error("must not run"); } })).rejects.toMatchObject({ rule: "object-conflict" });
    // Not vouched (the row went back to resumable): replaced.
    await sql`update document_assets set status = 'not-extracted', reason = 'aborted', resumable = true, storage_state = 'none', storage_key = null, bytes = null, sha256 = null, source = null where document_id = 'doc-a' and asset_id = 'p1.1'`;
    let ran = false;
    await replaceUnvouchedObject(sql, { scope: A, key, replace: async () => { ran = true; } });
    expect(ran).toBe(true);
    // A key outside the document's own images folder is refused.
    await expect(replaceUnvouchedObject(sql, { scope: A, key: "ub/run-b/doppler/doc-b/images/page-0001/image-001.webp", replace: async () => {} })).rejects.toMatchObject({ rule: "key-mismatch" });
    // The upload path uses it: other bytes at an unvouched key are replaced, not refused.
    storage.objects.set(key, Buffer.from("RIFF....WEBP stale bytes"));
    await storeStep(storage);
    expect(storage.objects.get(key)!.equals(v2Manifest().files.get("page-0001/image-001.webp")!)).toBe(true);
  });

  it("billed bytes include the folder's own stored files (L11)", async () => {
    const storage = memoryStorage();
    const { set, stored } = await storeStep(storage);
    const w = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "extracted", exitCode: 0 } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...w.level, markdownComplete: true }, assets: w.assets });
    const figureBytes = figureKeys(storage).reduce((sum, k) => sum + storage.objects.get(k)!.length, 0);
    const [row] = await sql<{ asset_bytes: number; folder_bytes: number }[]>`select asset_bytes::float8 as asset_bytes, folder_bytes::float8 as folder_bytes from document_extraction_levels where document_id = 'doc-a'`;
    expect(row!.folder_bytes).toBe(stored.folderBytes);
    expect(stored.folderBytes).toBeGreaterThan(0);
    expect(row!.asset_bytes).toBe(figureBytes + stored.folderBytes);
  });
});

async function inMemoryRows(set: Awaited<ReturnType<typeof readDopplerFigureDir>>) {
  const out = [];
  for await (const row of readLedgerSpill(set.ledger.spill)) out.push(row);
  return out;
}

describe("projects that opted out of figures", () => {
  it("never appear in resume discovery, and the first pass asks for no figures", async () => {
    const storage = memoryStorage();
    const { set, stored } = await storeStep(storage, { partial: true });
    const full = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5 } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...full.level, markdownComplete: true }, assets: full.assets });
    expect(await listResumableDocuments(sql, { orgId: "org-a" })).toHaveLength(1);
    await sql`update projects set pipeline = '{"figures": false}'::jsonb where id = 'proj-a'`;
    try {
      expect(await listResumableDocuments(sql, { orgId: "org-a" })).toEqual([]);
      expect(firstPassBatchOptions({ figures: false } as never, { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" }).figures).toBe(false);
      expect(projectFiguresEnabled({ figures: false }, { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" })).toBe(false);
      expect(projectFiguresEnabled({ figures: { enabled: false } }, { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" })).toBe(false);
      expect(projectFiguresEnabled({}, { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" })).toBe(true);
      expect(projectFiguresEnabled({}, {})).toBe(false);
    } finally {
      await sql`update projects set pipeline = '{}'::jsonb where id = 'proj-a'`;
    }
  });
});

describe("resume input", () => {
  it("the resume DIR is the manifest only by default (no figure goes back into the VM); files on request", async () => {
    const storage = memoryStorage();
    const { set, stored } = await storeStep(storage, { partial: true });
    const pending = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5 } });
    await writeDocumentAssetLedger(sql, { scope: A, level: { ...pending.level, markdownComplete: true }, assets: pending.assets });
    const sha = stored.manifest!.sha256;
    const dir = path.join(await mkdtemp(path.join(work, "resume-")), "DIR");
    expect(await downloadDopplerImagesDir({ storage, document: DOC_A, runId: "run-a", manifestSha256: sha, pageCount: 3, dir })).toEqual({ files: 0, bytes: 0 });
    expect(await readdir(dir)).toEqual(["manifest.jsonl"]);
    const full = path.join(await mkdtemp(path.join(work, "resume-full-")), "DIR");
    expect((await downloadDopplerImagesDir({ storage, document: DOC_A, runId: "run-a", manifestSha256: sha, pageCount: 3, dir: full, manifestOnly: false })).files).toBe(3);
    expect(createHash("sha256").update(storage.objects.get(`${ROOT_A}/manifest.jsonl`)!).digest("hex")).toBe(sha);
    expect(V2_SOURCE_SHA).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tenant isolation", () => {
  it("org B can never record, adopt or flip org A's rows or objects", async () => {
    const storage = memoryStorage();
    await storeStep(storage);
    const before = await rows();
    const forged = { ...B, documentId: "doc-a" };
    const set = await readDopplerFigureDir(await folder(), { pageCount: 3, expect: "complete" });
    const extracted = [];
    for await (const row of readLedgerSpill(set.ledger.spill)) if (row.status === "extracted") extracted.push(row);
    await expect(markAssetsPending(sql, { scope: forged, rows: extracted })).rejects.toMatchObject({ rule: "scope-mismatch" });
    await expect(adoptPendingAssets(sql, storage, { scope: forged })).resolves.toEqual({ adopted: 0, lost: 0, kept: 0 });
    await expect(store.markAssetsStored({ scope: forged, files: [{ id: "p1.1", key: `${ROOT_A}/page-0001/image-001.webp` }] })).rejects.toMatchObject({ rule: "scope-mismatch" });
    // A key outside the scope's own folder is refused (a path-traversal or foreign key never becomes a row).
    await expect(markAssetsPending(sql, { scope: A, rows: extracted.map((row) => ({ ...row, storageKey: `ub/run-b/doppler/doc-b/images/${row.linkPath!.slice("images/".length)}` })) }))
      .rejects.toMatchObject({ rule: "key-mismatch" });
    await expect(markAssetsPending(sql, { scope: A, rows: extracted.map((row) => ({ ...row, storageKey: `${ROOT_A}/../../x/${row.linkPath!.slice("images/".length)}` })) }))
      .rejects.toMatchObject({ rule: "key-mismatch" });
    expect(await rows()).toEqual(before);
  });

  it("a deleted document's ledger goes with it (its objects are purged with the document's folder)", async () => {
    await storeStep(memoryStorage());
    await sql`delete from documents where id = 'doc-a'`;
    expect(await rows()).toEqual([]);
    expect(await level()).toBeUndefined();
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 3)`;
  });
});
