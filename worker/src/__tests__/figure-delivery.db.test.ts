import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DocumentAssetLedgerError, adoptPendingAssets, beginFigureDelivery, commitFigureDelivery, markAssetsPending, readFigureLevel, type DocumentAssetLedgerScope } from "../db/document-asset-ledger.js";
import { Store } from "../db/store.js";
import { DopplerFigureRejection, downloadRangeManifest, readDopplerFigureDir, readLedgerSpill, storeFigureDelivery } from "../extractors/doppler-figures.js";
import { v2Manifest, v3Text, writeV3Folder, V2_SETTINGS_SHA, V2_SOURCE_SHA } from "../test/doppler-manifest-v2.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// Per-range figure deliveries against the worker's real Store over a migrated database, with crash injection: figures
// are kept on every failure path, adopted after a kill, never rewritten, fenced by generation, and never cross tenants.
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;
let work: string;

const A: DocumentAssetLedgerScope = { orgId: "org-a", projectId: "proj-a", documentId: "doc-a", runId: "run-a" };
const B: DocumentAssetLedgerScope = { orgId: "org-b", projectId: "proj-b", documentId: "doc-b", runId: "run-b" };
const DOC_A = { id: "doc-a", userId: "ua", runId: "run-a", pageCount: 3, sourceSha256: V2_SOURCE_SHA };
const DOC_B = { id: "doc-b", userId: "ub", runId: "run-b", pageCount: 3, sourceSha256: V2_SOURCE_SHA };

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub');
    insert into projects(id, org_id, user_id, name) values ('proj-a', 'org-a', 'ua', 'A'), ('proj-b', 'org-b', 'ub', 'B');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents) values
      ('run-a', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1),
      ('run-b', 'org-b', 'ub', 'proj-b', 'upload', 'processing', 'extract', '{}', 1);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 3),
      ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'processing', 3);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  work = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "figure-delivery-test-"));
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
  await sql`update documents set status = 'processing'`;
});

/** An object store in memory, with streamed reads (what adopt and resume use) and a record of every write. */
function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const puts: string[] = [];
  const deletes: string[] = [];
  let failAfter = Number.POSITIVE_INFINITY;
  let onPut: ((key: string) => void) | null = null;
  return {
    objects, puts, deletes,
    failAfterPuts(n: number) { failAfter = n; },
    onPut(hook: (key: string) => void) { onPut = hook; },
    putBytes: async (key: string, data: Uint8Array) => {
      if (puts.length >= failAfter) throw new Error("storage unavailable");
      puts.push(key);
      objects.set(key, Buffer.from(data));
      onPut?.(key);
    },
    putJson: async (key: string, value: unknown) => { puts.push(key); objects.set(key, Buffer.from(JSON.stringify(value))); },
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

/** A provider's folder for pages 1-3 (version 3), optionally bent. */
async function folder(options: { partial?: boolean; mutate?: (m: ReturnType<typeof v2Manifest>) => void } = {}): Promise<string> {
  const built = v2Manifest({ partial: options.partial });
  options.mutate?.(built);
  const dir = await mkdtemp(path.join(work, "delivery-"));
  await writeV3Folder(dir, v3Text(built.manifest), built.files);
  return dir;
}

const deliver = async (storage: ReturnType<typeof memoryStorage>, options: { partial?: boolean; scope?: DocumentAssetLedgerScope; document?: typeof DOC_A; signal?: AbortSignal; dir?: string; fence?: { generation: number }; resume?: boolean } = {}) =>
  await storeFigureDelivery({
    storage, ledger: store, scope: options.scope ?? A, document: options.document ?? DOC_A,
    delivery: { dir: options.dir ?? await folder({ partial: options.partial }), status: options.partial ? "partial" : "extracted", exitCode: options.partial ? 5 : 0 },
    signal: options.signal, ...(options.fence ? { fence: options.fence } : {}), ...(options.resume ? { resume: true } : {}),
  });

const rows = async (documentId = "doc-a") => sql<Array<{ asset_id: string; status: string; storage_state: string; storage_key: string | null; reason: string | null; resumable: boolean }>>`
  select asset_id, status, storage_state, storage_key, reason, resumable from document_assets where document_id = ${documentId} order by asset_id`;
const level = async (documentId = "doc-a") => (await sql<Array<Record<string, unknown>>>`
  select images_status, markdown_complete, figures_generation::int as generation, asset_bytes::float8 as asset_bytes, manifest_bytes::float8 as manifest_bytes,
    assets_extracted, assets_resumable, ranges, gaps, manifest_key
  from document_extraction_levels where document_id = ${documentId}`)[0];
const imageKeys = (storage: ReturnType<typeof memoryStorage>) => [...storage.objects.keys()].filter((key) => /\/page-\d{4}\//.test(key)).sort();

describe("a range is stored and committed the moment it validates", () => {
  it("rows stored, objects present, an honest level with markdown_complete=false, before any Markdown checkpoint", async () => {
    const storage = memoryStorage();
    const result = await deliver(storage);
    expect(result).toMatchObject({ generation: 1, mode: "fresh", range: { first: 1, last: 3 }, files: 3, status: "complete" });
    expect((await rows()).filter((row) => row.status === "extracted").map((row) => row.storage_state)).toEqual(["stored", "stored", "stored"]);
    expect(imageKeys(storage)).toHaveLength(3);
    for (const key of imageKeys(storage)) expect(key).toMatch(/\/image-\d{3}\.[0-9a-f]{16}\.(webp|jpg)$|\/figure-\d{3}\.[0-9a-f]{16}\.svg$/);
    const committed = await level();
    expect(committed).toMatchObject({ images_status: "complete", markdown_complete: false, generation: 1, assets_extracted: 3 });
    // asset_bytes is recomputed from the stored rows plus the stored range manifest.
    const fileBytes = imageKeys(storage).reduce((sum, key) => sum + storage.objects.get(key)!.length, 0);
    expect(committed!.asset_bytes).toBe(fileBytes + (committed!.manifest_bytes as number));
    // The range manifest is canonical, content-addressed and listed on the level.
    const [range] = committed!.ranges as Array<{ key: string; sha256: string; bytes: number }>;
    expect(range!.key).toMatch(/^ua\/run-a\/doppler\/doc-a\/images\/manifests\/1-3\.[0-9a-f]{16}\.jsonl$/);
    expect(createHash("sha256").update(storage.objects.get(range!.key)!).digest("hex")).toBe(range!.sha256);
    expect(storage.deletes).toEqual([]);
  });

  it("the Markdown, a later stage (embed), a cancelled run or a failed document never touches them", async () => {
    const storage = memoryStorage();
    await deliver(storage);
    const before = await rows();
    // What those failures leave: no checkpoint, the run's failure write is level-only, the document fails.
    await store.writeDocumentAssetLedger({ scope: A, level: { markdownComplete: false, imagesStatus: "failed", imagesExitCode: null, manifestVersion: null, dopplerBuild: null, run: null, manifest: null }, assets: [], levelOnly: true });
    await sql`update documents set status = 'failed' where id = 'doc-a'`;
    expect(await rows()).toEqual(before);
    expect(await level()).toMatchObject({ images_status: "complete", markdown_complete: false });
    expect(imageKeys(storage)).toHaveLength(3);
    expect(storage.deletes).toEqual([]);
  });

  it("a retry of the same PDF and settings merges: nothing is uploaded again and no row changes", async () => {
    const storage = memoryStorage();
    await deliver(storage);
    const before = await sql`select asset_id, updated_at::text from document_assets where document_id = 'doc-a' order by asset_id`;
    const imagePuts = () => storage.puts.filter((key) => /\/page-\d{4}\//.test(key)).length;
    const uploaded = imagePuts();
    const again = await deliver(storage);
    expect(again).toMatchObject({ generation: 1, mode: "merge", files: 0, kept: 3 });
    expect(imagePuts()).toBe(uploaded);
    expect(await sql`select asset_id, updated_at::text from document_assets where document_id = 'doc-a' and status = 'extracted' order by asset_id`)
      .toEqual(before.filter((row) => ["p1.1", "p1.g1", "p3.1"].includes(row.asset_id as string)));
    // The retry plan: the stored range manifest downloads and validates as a resume input.
    const plan = await readFigureLevel(sql, A);
    expect(plan).toMatchObject({ generation: 1, sourceSha256: V2_SOURCE_SHA, settingsSha256: V2_SETTINGS_SHA, pending: 0 });
    const file = path.join(await mkdtemp(path.join(work, "plan-")), "m.jsonl");
    await downloadRangeManifest(storage, plan!.ranges[0]!, file);
  });

  it("a partial range resumes: only the missing image is uploaded, stored ones are kept", async () => {
    const storage = memoryStorage();
    await deliver(storage, { partial: true });
    expect(await level()).toMatchObject({ images_status: "resumable", assets_resumable: 1 });
    const generation = (await level())!.generation as number;
    // The resume's folder: the same manifest with p3.2 now extracted, and only its file (manifest-only resume).
    const dir = await folder({ partial: true, mutate: resumed });
    const result = await deliver(storage, { dir, fence: { generation }, resume: true });
    // One file uploaded; its row (flipped to stored by the upload step) and the three stored before are left as stored.
    expect(result).toMatchObject({ mode: "merge", files: 1, kept: 4, status: "complete" });
    expect(await level()).toMatchObject({ images_status: "complete", assets_resumable: 0, assets_extracted: 4 });
  });
});

/** Bend the partial fixture into its resumed form: p3.2 extracted, the other files absent (a manifest-only resume). */
function resumed({ manifest, files }: ReturnType<typeof v2Manifest>): void {
  const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  for (const key of [...files.keys()]) files.delete(key);
  files.set("page-0003/image-002.webp", bytes);
  const entry = manifest.images.find((e) => e.id === "p3.2")!;
  Object.assign(entry, { status: "extracted", reason: undefined, resumable: undefined, source: "render", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: 10, height: 10 });
  manifest.resumable = false;
  manifest.complete = true;
  manifest.batches[1] = { pages: [3, 3], status: "ok" };
  manifest.totals.extracted += 1;
  manifest.totals.not_extracted -= 1;
  manifest.totals.bytes += bytes.length;
  manifest.totals.batches_cut = 0;
}

describe("crash injection: a worker killed or cancelled mid-upload", () => {
  it("killed between upload and the stored flip: the next attempt adopts by SHA-256 with no VM; missing or tampered objects become resumable", async () => {
    const storage = memoryStorage();
    // What a killed worker leaves: pending rows (written before the uploads), the uploads, no flip, no commit.
    const start = await beginFigureDelivery(sql, { scope: A, sourceSha256: V2_SOURCE_SHA, settingsSha256: V2_SETTINGS_SHA });
    const set = await readDopplerFigureDir(await folder(), { pageCount: 3, expect: "complete", sourceSha256: V2_SOURCE_SHA });
    const extracted = [];
    for await (const row of readLedgerSpill(set.ledger.spill)) if (row.status === "extracted") extracted.push({ ...row, storageKey: null });
    await markAssetsPending(sql, { scope: A, rows: extracted, fence: { generation: start.generation } });
    const pending = await rows();
    expect(pending.filter((row) => row.storage_state === "pending")).toHaveLength(3);
    // Two of three uploads landed; one of them was then overwritten with other bytes (never ours to adopt).
    const [p11, p1g1] = [pending.find((row) => row.asset_id === "p1.1")!, pending.find((row) => row.asset_id === "p1.g1")!];
    const file = (rel: string) => v2Manifest().files.get(rel)!;
    storage.objects.set(p11.storage_key!, file("page-0001/image-001.webp"));
    storage.objects.set(p1g1.storage_key!, Buffer.from("<svg>tampered</svg>"));
    const adopted = await adoptPendingAssets(sql, storage, { scope: A, fence: { generation: start.generation } });
    expect(adopted).toEqual({ adopted: 1, lost: 2, kept: 0 });
    const after = await rows();
    expect(after.find((row) => row.asset_id === "p1.1")).toMatchObject({ status: "extracted", storage_state: "stored" });
    expect(after.find((row) => row.asset_id === "p1.g1")).toMatchObject({ status: "not-extracted", reason: "aborted", resumable: true, storage_state: "none", storage_key: null });
    expect(after.find((row) => row.asset_id === "p3.1")).toMatchObject({ status: "not-extracted", reason: "aborted", resumable: true });
    expect(await level()).toMatchObject({ images_status: "resumable", assets_resumable: 2 });
    // Adoption never deletes: the tampered object is left for the orphan GC.
    expect(storage.objects.has(p1g1.storage_key!)).toBe(true);
  });

  it("a storage failure or cancellation mid-upload deletes nothing; pending rows stay for the next attempt", async () => {
    const storage = memoryStorage();
    storage.failAfterPuts(1);
    await expect(deliver(storage)).rejects.toThrow();
    expect((await rows()).filter((row) => row.storage_state === "pending")).toHaveLength(3);
    expect(storage.deletes).toEqual([]);
    expect(storage.objects.size).toBe(1);

    const controller = new AbortController();
    const second = memoryStorage();
    second.onPut(() => controller.abort());
    await expect(deliver(second, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(second.deletes).toEqual([]);
    // The next attempt: the landed upload is adopted, the rest re-uploaded under the same keys.
    const retry = memoryStorage();
    for (const [key, value] of second.objects) retry.objects.set(key, value);
    // Concurrent uploads may have landed before the cancellation was seen: every landed, verified one is adopted.
    expect(await adoptPendingAssets(sql, retry, { scope: A })).toMatchObject({ adopted: second.objects.size, kept: 0 });
    await deliver(retry);
    expect((await rows()).filter((row) => row.status === "extracted").every((row) => row.storage_state === "stored")).toBe(true);
  });
});

describe("fences and monotonic writes", () => {
  it("a reprocess with other settings starts a new generation; the old generation's resume is a no-op", async () => {
    const storage = memoryStorage();
    await deliver(storage, { partial: true });
    const old = (await level())!.generation as number;
    // A fresh pass with other settings (a reprocess) lands mid-resume.
    const dir = await mkdtemp(path.join(work, "other-settings-"));
    const built = v2Manifest();
    await writeV3Folder(dir, v3Text(built.manifest).replace(V2_SETTINGS_SHA, "c".repeat(64)), built.files);
    await expect(deliver(storage, { dir })).rejects.toThrow(); // the end-line hash no longer matches: refused, nothing written
    await beginFigureDelivery(sql, { scope: A, sourceSha256: V2_SOURCE_SHA, settingsSha256: "c".repeat(64) });
    expect((await level())!.generation).toBe(old + 1);
    await expect(beginFigureDelivery(sql, { scope: A, sourceSha256: V2_SOURCE_SHA, settingsSha256: V2_SETTINGS_SHA, fence: { generation: old } }))
      .rejects.toMatchObject({ rule: "stale-generation" });
    await expect(deliver(storage, { fence: { generation: old }, resume: true, dir: await folder({ partial: true, mutate: resumed }) }))
      .rejects.toMatchObject({ rule: "stale-generation" });
  });

  it("a delivery with another file for a stored image is resume-rewrite, and nothing changes", async () => {
    const storage = memoryStorage();
    await deliver(storage);
    const before = await rows();
    const dir = await folder({
      mutate: ({ manifest, files }) => {
        const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M9 9"/></svg>');
        files.set("page-0001/figure-001.svg", bytes);
        const entry = manifest.images.find((e) => e.id === "p1.g1")!;
        manifest.totals.bytes += bytes.length - (entry.bytes as number);
        Object.assign(entry, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      },
    });
    await expect(deliver(storage, { dir })).rejects.toMatchObject({ rule: "resume-rewrite" });
    expect(await rows()).toEqual(before);
  });

  it("a commit with a key outside the document's folder, a traversal key or a range past the document is refused", async () => {
    const storage = memoryStorage();
    await deliver(storage);
    const generation = (await level())!.generation as number;
    const commit = { scope: A, generation, range: { first: 1, last: 3 }, assets: [], run: null, complete: true, exitCode: 0, build: null };
    const sha = "d".repeat(64);
    for (const key of [`ub/run-b/doppler/doc-a/images/manifests/1-3.${sha.slice(0, 16)}.jsonl`, `ua/run-a/doppler/doc-a/images/../manifests/1-3.${sha.slice(0, 16)}.jsonl`, "ua/run-a/doppler/doc-a/images/manifest.jsonl"]) {
      await expect(commitFigureDelivery(sql, { ...commit, manifest: { key, sha256: sha, bytes: 10, version: 3 } })).rejects.toMatchObject({ rule: "key-mismatch" });
    }
    await expect(commitFigureDelivery(sql, { ...commit, range: { first: 1, last: 9 }, manifest: { key: "x", sha256: sha, bytes: 10, version: 3 } })).rejects.toBeInstanceOf(DocumentAssetLedgerError);
    await expect(commitFigureDelivery(sql, { ...commit, gaps: Array.from({ length: 129 }, (_, i) => ({ first: i + 1, last: i + 1, reason: "shard-failed" })),
      manifest: { key: `ua/run-a/doppler/doc-a/images/manifests/1-3.${sha.slice(0, 16)}.jsonl`, sha256: sha, bytes: 10, version: 3 } })).rejects.toMatchObject({ rule: "invalid-gaps" });
    // A range manifest key from the ledger is checked before any download: traversal and other folders are refused.
    for (const key of ["../../etc/passwd", `ua/run-a/doppler/doc-a/images/manifests/1-3.${"0".repeat(16)}.jsonl`]) {
      await expect(downloadRangeManifest(storage, { key, sha256: sha, bytes: 1 }, path.join(work, "never"))).rejects.toBeInstanceOf(DopplerFigureRejection);
    }
  });

  it("a tampered manifest is refused before anything is stored", async () => {
    const storage = memoryStorage();
    const dir = await mkdtemp(path.join(work, "tampered-"));
    const built = v2Manifest();
    await writeV3Folder(dir, v3Text(built.manifest, { mutateLines: (lines) => { lines[1] = lines[1]!.replace('"page":1', '"page":2'); } }), built.files);
    await expect(deliver(storage, { dir })).rejects.toBeInstanceOf(DopplerFigureRejection);
    expect(storage.puts.filter((key) => /\/page-\d{4}\//.test(key))).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("a retry in org B can never adopt, merge or commit org A's objects or rows", async () => {
    const storage = memoryStorage();
    await deliver(storage);
    const before = await rows();
    // Org B's scope naming org A's document: refused before anything is read or written.
    await expect(beginFigureDelivery(sql, { scope: { ...B, documentId: "doc-a" }, sourceSha256: V2_SOURCE_SHA, settingsSha256: V2_SETTINGS_SHA })).rejects.toMatchObject({ rule: "scope-mismatch" });
    await expect(deliver(storage, { scope: { ...B, documentId: "doc-a" }, document: { ...DOC_B, id: "doc-a" } })).rejects.toMatchObject({ rule: "scope-mismatch" });
    expect(await adoptPendingAssets(sql, storage, { scope: { ...B, documentId: "doc-a" } })).toEqual({ adopted: 0, lost: 0, kept: 0 });
    expect(await rows()).toEqual(before);
    // Org B's own document with the same bytes gets its own keys under its own root, never A's objects.
    await deliver(storage, { scope: B, document: DOC_B });
    const keysB = (await rows("doc-b")).flatMap((row) => (row.storage_key ? [row.storage_key] : []));
    expect(keysB.every((key) => key.startsWith("ub/run-b/doppler/doc-b/"))).toBe(true);
  });

  it("a deleted document's ledger goes with it (its objects are purged with the document's folder)", async () => {
    const storage = memoryStorage();
    await deliver(storage);
    await sql`delete from documents where id = 'doc-a'`;
    expect(await rows()).toEqual([]);
    expect(await level()).toBeUndefined();
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 3)`;
  });
});
