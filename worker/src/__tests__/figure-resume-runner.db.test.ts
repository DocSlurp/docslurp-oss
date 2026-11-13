import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dopplerShardFolder, PARSE_SOURCE_SCAN_VERSION } from "@docslurp/shared";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({ calls: [] as Array<{ name: string; value: number; labels: Record<string, string> }> }));
vi.mock("@docslurp/shared/observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("@docslurp/shared/observability")>(),
  recordFigureTelemetry: (name: string, value: number, labels: Record<string, string> = {}) => { telemetry.calls.push({ name, value, labels }); },
}));

import { figureLedgerHooks, ledgerWriteForStoredFigures, markAssetsLost, writeDocumentAssetLedger, type DocumentAssetLedgerScope } from "../db/document-asset-ledger.js";
import { Store } from "../db/store.js";
import { readDopplerFigureDir, storeDopplerFigures } from "../extractors/doppler-figures.js";
import type { FigureResumeJob } from "../extractors/plugins.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import {
  auditFigureStorage, claimFigureResume, figureResumeBacklog, isPageWithheld, piiWithholding, resumeWithholding, runFigureResumes, FIGURE_FAILED_RETENTION_MS, FIGURE_ORPHAN_GRACE_MS, type FigureResumeProvider,
} from "../figures/resume-runner.js";
import { v2Manifest, v3Text, writeV3Folder, V2_SOURCE_BYTES, V2_SOURCE_SHA } from "../test/doppler-manifest-v2.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// The figure resume runner over a migrated database with a fake provider (no VM): commit-time enqueue, the deploy flag and
// project settings, one per organization, spend pauses, manifest-only input, monotonic writes, attempt caps, stale
// resumes, cost-only VM time, and the orphan GC and audit. Nothing here ever reads another tenant's rows or objects.
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;
let work: string;
const ON = { DOCSLURP_FIGURE_RESUME: "1", DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" };
/** The audit and GC with their writes and deletes on (they are dry runs by default). */
const GC = { DOCSLURP_FIGURE_AUDIT: "1", DOCSLURP_FIGURE_GC_DELETE: "1" };

const scopeOf = (doc: string, org = "org-a", project = "proj-a", run = "run-a"): DocumentAssetLedgerScope => ({ orgId: org, projectId: project, documentId: doc, runId: run });

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub');
    insert into projects(id, org_id, user_id, name, pipeline) values ('proj-a', 'org-a', 'ua', 'A', '{}'), ('proj-m', 'org-a', 'ua', 'M', '{"figureResume":"manual"}'),
      ('proj-off', 'org-a', 'ua', 'Off', '{"figures":false}'), ('proj-b', 'org-b', 'ub', 'B', '{}');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, created_at) values
      ('run-a', 'org-a', 'ua', 'proj-a', 'upload', 'completed', 'completed', '{}', 1, now() - interval '2 hours'),
      ('run-a2', 'org-a', 'ua', 'proj-a', 'upload', 'completed', 'completed', '{}', 1, now()),
      ('run-m', 'org-a', 'ua', 'proj-m', 'upload', 'completed', 'completed', '{}', 1, now()),
      ('run-off', 'org-a', 'ua', 'proj-off', 'upload', 'completed', 'completed', '{}', 1, now()),
      ('run-b', 'org-b', 'ub', 'proj-b', 'upload', 'completed', 'completed', '{}', 1, now());
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, source_sha256) values
      ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'completed', 3, '${V2_SOURCE_SHA}'),
      ('doc-a2', 'org-a', 'ua', 'proj-a', 'run-a', 'a2.pdf', 'application/pdf', 'ka2', 'completed', 3, '${V2_SOURCE_SHA}'),
      ('doc-m', 'org-a', 'ua', 'proj-m', 'run-m', 'm.pdf', 'application/pdf', 'km', 'completed', 3, '${V2_SOURCE_SHA}'),
      ('doc-off', 'org-a', 'ua', 'proj-off', 'run-off', 'o.pdf', 'application/pdf', 'ko', 'completed', 3, '${V2_SOURCE_SHA}'),
      ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'completed', 3, '${V2_SOURCE_SHA}');
  `);
  // Each document has this build's quarantine decision: its upload, as scanned (lib/parse-source.ts "original").
  await db.exec(`update documents set parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION}, parse_source_sha256 = source_sha256`);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  work = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "figure-resume-runner-"));
}, 600_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql`delete from document_assets`;
  await sql`delete from document_extraction_levels`;
  await sql`delete from usage_events`;
  await sql`delete from document_extraction_shards`;
  await sql`delete from figure_resume_org_days`;
  await sql`delete from pii_detections`;
  await sql`update documents set source_sha256 = ${V2_SOURCE_SHA} where source_sha256 is distinct from ${V2_SOURCE_SHA}`;
  await sql`update documents set status = 'completed', metadata = '{}'::jsonb, parse_source_key = null, parse_source_sha256 = source_sha256,
    parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION}`;
  telemetry.calls.length = 0;
  await sql`update documents set run_id = case id when 'doc-m' then 'run-m' when 'doc-off' then 'run-off' when 'doc-b' then 'run-b' else 'run-a' end`;
  await sql`update project_runs set artifacts = '{}'::jsonb`;
});

function memoryStorage() {
  const objects = new Map<string, { bytes: Buffer; at: Date }>();
  const deletes: string[] = [];
  const put = (key: string, data: Uint8Array) => { objects.set(key, { bytes: Buffer.from(data), at: new Date() }); };
  return {
    objects, deletes, bucket: "b",
    putBytes: async (key: string, data: Uint8Array) => put(key, data),
    putBytesIfAbsent: async (key: string, data: Uint8Array) => { if (objects.has(key)) return "exists" as const; put(key, data); return "created" as const; },
    putJson: async (key: string, value: unknown) => put(key, Buffer.from(JSON.stringify(value))),
    deleteKeys: async (keys: string[]) => { deletes.push(...keys); for (const key of keys) objects.delete(key); },
    getBytes: async (key: string) => { const v = objects.get(key); if (!v) throw Object.assign(new Error("missing"), { name: "NoSuchKey" }); return v.bytes; },
    openStream: async (key: string) => {
      const v = objects.get(key);
      if (!v) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { stream: (async function* () { yield v.bytes; })(), size: v.bytes.length };
    },
    // Source reads (the decided parse source): the test PDF's bytes, unless a test put other bytes at the key.
    sources: new Map<string, Buffer>(),
    downloaded: [] as string[],
    async downloadToTempFile(key: string) {
      this.downloaded.push(key);
      const file = path.join(work, `src-${key.replace(/[^a-z0-9]/gi, "_")}-${Math.random()}`);
      await writeFile(file, this.sources.get(key) ?? V2_SOURCE_BYTES);
      return file;
    },
    listKeys: async ({ prefix }: { prefix: string }) => ({ keys: [...objects.keys()].filter((key) => key.startsWith(prefix)), truncated: false }),
    headObject: async (key: string) => { const v = objects.get(key); return v ? { size: v.bytes.length, lastModified: v.at } : null; },
    uri: (key: string) => `s3://b/${key}`,
  };
}

/** A partial first pass of `doc` (p3.2 left by a budget stop), stored and committed as the stage does. */
async function partialPass(storage: ReturnType<typeof memoryStorage>, doc = "doc-a", org = "org-a", project = "proj-a", run = "run-a") {
  const built = v2Manifest({ partial: true });
  const dir = await mkdtemp(path.join(work, "pass-"));
  await writeV3Folder(dir, v3Text(built.manifest), built.files);
  const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "partial", sourceSha256: V2_SOURCE_SHA });
  const scope = scopeOf(doc, org, project, run);
  const user = org === "org-a" ? "ua" : "ub";
  const ledger = figureLedgerHooks({ store, run: { id: run, orgId: org, projectId: project } }, doc)!;
  const stored = await storeDopplerFigures({ storage, document: { id: doc, userId: user, runId: run }, runId: run, figures: set, markdown: "", ledger });
  const write = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5 } });
  await writeDocumentAssetLedger(sql, { scope, level: { ...write.level, markdownComplete: true }, assets: write.assets });
}

/** A fake provider: records what it got, and writes the resumed folder (p3.2 extracted, only its file) unless told otherwise. */
function fakeProvider(options: { fail?: boolean; rewrite?: boolean; onResume?: () => Promise<void> } = {}) {
  const jobs: Array<FigureResumeJob & { inputFiles: string[] }> = [];
  const provider: FigureResumeProvider = {
    timeoutMs: () => 60_000,
    resume: async (job) => {
      jobs.push({ ...job, inputFiles: job.manifest ? await readdir(path.dirname(job.manifest)) : [] });
      await options.onResume?.();
      if (options.fail) return { status: "failed", reason: "vm died" };
      const built = v2Manifest({ partial: true });
      const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
      bytes.writeUInt32LE(bytes.length - 8, 4);
      const files = new Map<string, Buffer>([["page-0003/image-002.webp", bytes]]);
      const entry = built.manifest.images.find((e) => e.id === "p3.2")!;
      Object.assign(entry, { status: "extracted", reason: undefined, resumable: undefined, source: "render", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: 10, height: 10 });
      if (options.rewrite) {
        const p11 = built.manifest.images.find((e) => e.id === "p1.1")!;
        const other = Buffer.from(bytes);
        other[19] = 7;
        files.set("page-0001/image-001.webp", other);
        built.manifest.totals.bytes += other.length - (p11.bytes as number);
        Object.assign(p11, { bytes: other.length, sha256: createHash("sha256").update(other).digest("hex") });
      }
      Object.assign(built.manifest, { resumable: false, complete: true });
      built.manifest.batches[1] = { pages: [3, 3], status: "ok" };
      built.manifest.totals.extracted += 1;
      built.manifest.totals.not_extracted -= 1;
      built.manifest.totals.bytes += bytes.length;
      built.manifest.totals.batches_cut = 0;
      await writeV3Folder(job.dir, v3Text(built.manifest), files);
      return { status: "extracted", exitCode: 0 };
    },
  };
  return { provider, jobs };
}

const level = async (doc = "doc-a") => (await sql<Array<Record<string, unknown>>>`
  select images_status, resumes, resume_failures, resume_vm_launches, resume_after is not null as queued, resume_blocked, resume_lease_until is not null as leased,
    resume_lease_owner, assets_resumable, resume_vm_ms::float8 as resume_vm_ms, resume_stalls, resume_grants, resume_blocked_at is not null as blocked_at
  from document_extraction_levels where document_id = ${doc}`)[0];
const due = async (doc = "doc-a") => { await sql`update document_extraction_levels set resume_after = now() - interval '1 second' where document_id = ${doc} and resume_after is not null`; };

describe("queueing", () => {
  it("a resumable level is queued in its own commit for an auto project, never for manual or figures-off projects", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    expect(await level()).toMatchObject({ images_status: "resumable", queued: true, resume_blocked: null });
    await partialPass(storage, "doc-m", "org-a", "proj-m", "run-m");
    expect(await level("doc-m")).toMatchObject({ images_status: "resumable", queued: false });
    await partialPass(storage, "doc-off", "org-a", "proj-off", "run-off");
    expect(await level("doc-off")).toMatchObject({ queued: false });
  });
});

describe("the runner", () => {
  it("does nothing while DOCSLURP_FIGURE_RESUME is off (the request stays queued)", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const { provider, jobs } = fakeProvider();
    expect(await runFigureResumes({ sql, storage, provider, workerId: "w1", env: {} })).toBe(0);
    expect(jobs).toEqual([]);
    expect(await level()).toMatchObject({ queued: true, images_status: "resumable" });
  });

  it("resumes from the manifest only, adds only the new file, serves it, and records the VM time as a cost-only event", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const before = new Set(storage.objects.keys());
    const { provider, jobs } = fakeProvider();
    expect(await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON })).toBe(1);
    // Manifest-only input: no figure file went back into the VM.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.inputFiles).toEqual(["manifest.jsonl"]);
    expect(jobs[0]).toMatchObject({ sourceSha256: V2_SOURCE_SHA, pages: null });
    const added = [...storage.objects.keys()].filter((key) => !before.has(key) && /\/page-\d{4}\//.test(key));
    expect(added).toEqual(["ua/run-a/doppler/doc-a/images/page-0003/image-002.webp"]);
    expect(await level()).toMatchObject({ images_status: "complete", resumes: 1, queued: false, leased: false, assets_resumable: 0 });
    const [run] = await sql<{ artifacts: Record<string, string> }[]>`select artifacts from project_runs where id = 'run-a'`;
    expect(run!.artifacts["doc-a:doppler-figure:p3.2"]).toBe("s3://b/ua/run-a/doppler/doc-a/images/page-0003/image-002.webp");
    const events = await sql<{ metric: string; cost: number; org_id: string; metadata: Record<string, unknown> }[]>`
      select metric, cost_cents::float8 as cost, org_id, metadata from usage_events`;
    // Our own cost at its real allocated price (L5), never a customer charge.
    expect(events).toEqual([expect.objectContaining({ metric: "doppler-figures-resume-vm", org_id: "org-a", metadata: expect.objectContaining({ billable: false, costRollup: "authoritative" }) })]);
    expect(events[0]!.cost).toBeGreaterThanOrEqual(0);
    expect(storage.deletes).toEqual([]);
  });

  it("a gap (no manifest) is resumed by a fresh pass over its pages, which becomes that range's shard", async () => {
    const storage = memoryStorage();
    // A complete pass whose pages 3-3 a shard never returned (plugin:shard-over-share).
    const built = v2Manifest();
    const dir = await mkdtemp(path.join(work, "pass-"));
    await writeV3Folder(dir, v3Text(built.manifest), built.files);
    const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "complete", sourceSha256: V2_SOURCE_SHA });
    const stored = await storeDopplerFigures({ storage, document: { id: "doc-a", userId: "ua", runId: "run-a" }, runId: "run-a", figures: set, markdown: "" });
    const write = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5, gaps: [{ first: 3, last: 3, reason: "plugin:shard-over-share" }] } });
    await writeDocumentAssetLedger(sql, { scope: scopeOf("doc-a"), level: { ...write.level, markdownComplete: true }, assets: write.assets });
    expect(await level()).toMatchObject({ images_status: "resumable", queued: true });
    await due();
    const jobs: FigureResumeJob[] = [];
    const provider: FigureResumeProvider = {
      timeoutMs: () => 60_000,
      resume: async (job) => {
        jobs.push(job);
        // The converter's own manifest for --images-pages 3-3: nothing to extract on that page.
        const empty = { ...v2Manifest().manifest, images: [], batches: [{ pages: [3, 3], status: "ok" }], complete: true, resumable: false };
        empty.totals = Object.fromEntries(Object.keys(empty.totals).map((key) => [key, key === "batches" ? 1 : 0]));
        const shardDir = path.join(job.dir, "shards", dopplerShardFolder(3, 3));
        await mkdir(shardDir, { recursive: true });
        await writeFile(path.join(shardDir, "manifest.jsonl"), v3Text(empty as never, { pages: [3, 3] }));
        return { status: "extracted", exitCode: 0 };
      },
    };
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([expect.objectContaining({ manifest: null, pages: [3, 3], resumePages: null })]);
    const [after] = await sql<{ images_status: string; gaps: unknown }[]>`select images_status, gaps from document_extraction_levels where document_id = 'doc-a'`;
    expect(after!.images_status).toBe("complete");
    expect(after!.gaps ?? []).toEqual([]);
    expect(await sql`select first_page, last_page from document_extraction_shards where document_id = 'doc-a'`).toEqual([{ first_page: 3, last_page: 3 }]);
    await sql`delete from document_extraction_shards`;
  });

  it("a provider failure backs off and blocks after three attempts; nothing is deleted", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    const { provider } = fakeProvider({ fail: true });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await due();
      await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
      expect(await level()).toMatchObject({ resume_failures: attempt, leased: false });
    }
    // Three launches in a row without progress (a 3-page document's launch cap is also 3): stopped `no-progress` at once,
    // and the next claim finds nothing to run.
    expect(await level()).toMatchObject({ resume_blocked: "no-progress", resume_stalls: 3, queued: false, images_status: "resumable", blocked_at: true });
    await sql`update document_extraction_levels set resume_after = now() - interval '1 second' where document_id = 'doc-a'`;
    const { provider: again, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider: again, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(storage.deletes).toEqual([]);
  });

  it("a resume that hands back another file for a stored image is refused (resume-rewrite) and changes nothing", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const rows = await sql`select asset_id, sha256, storage_state from document_assets where document_id = 'doc-a' order by asset_id`;
    const manifestKey = "ua/run-a/doppler/doc-a/images/manifest.jsonl";
    const manifestBefore = Buffer.from(storage.objects.get(manifestKey)!.bytes);
    const { provider } = fakeProvider({ rewrite: true });
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(await sql`select asset_id, sha256, storage_state from document_assets where document_id = 'doc-a' order by asset_id`).toEqual(rows);
    // Adversarial M7: a refused resume never rewrote the folder's manifest (figure files only before the commit).
    expect(storage.objects.get(manifestKey)!.bytes.equals(manifestBefore)).toBe(true);
    // R2-L4: a rewrite can only repeat: refused at once, no more VMs.
    expect(await level()).toMatchObject({ images_status: "resumable", resume_failures: 0, resume_blocked: "refused", queued: false });
  });

  it("a reprocess that lands mid-resume makes the resume a no-op (stale)", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const { provider } = fakeProvider({ onResume: async () => { await sql`update documents set run_id = 'run-a2' where id = 'doc-a'`; } });
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(await level()).toMatchObject({ resume_blocked: "stale", resumes: 0, images_status: "resumable" });
    expect((await sql`select count(*)::int as n from document_assets where document_id = 'doc-a' and asset_id = 'p3.2' and status = 'extracted'`)[0]).toEqual({ n: 0 });
  });

  it("claims at most one document per organization, and never for a spend-paused organization", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await partialPass(storage, "doc-a2");
    await partialPass(storage, "doc-b", "org-b", "proj-b", "run-b");
    await due("doc-a"); await due("doc-a2"); await due("doc-b");
    const first = await claimFigureResume(sql, "w1", ON);
    expect(first?.org_id).toBe("org-a");
    const second = await claimFigureResume(sql, "w2", ON);
    expect(second?.org_id).toBe("org-b");
    expect(await claimFigureResume(sql, "w3", ON)).toBeNull();
  });

  it("never claims for an organization that may not spend (budget paused): re-queued later", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const storage = memoryStorage();
    await partialPass(storage, "doc-b", "org-b", "proj-b", "run-b");
    await due("doc-b");
    await sql`update organizations set budget_paused = true where id = 'org-b'`;
    try {
      expect(await claimFigureResume(sql, "w1", ON)).toBeNull();
      const [row] = await sql<{ later: boolean }[]>`select resume_after > now() + interval '30 minutes' as later from document_extraction_levels where document_id = 'doc-b'`;
      expect(row).toEqual({ later: true });
    } finally {
      await sql`update organizations set budget_paused = false where id = 'org-b'`;
      setSpendCheckConfig(null);
    }
  });

  it("a project whose resumes or figures are off is blocked, never claimed", async () => {
    const storage = memoryStorage();
    await partialPass(storage, "doc-off", "org-a", "proj-off", "run-off");
    await sql`update document_extraction_levels set resume_after = now() - interval '1 second' where document_id = 'doc-off'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    // L2: the reason says figures are off (not resumes); #363 H2: the level is closed `disabled`.
    expect(await level("doc-off")).toMatchObject({ resume_blocked: "figures-off", queued: false, images_status: "disabled" });
  });

  it("#363 H2: a run whose own pipeline opted out of figures closes the level disabled and is never resumed", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update project_runs set pipeline = '{"figures": false}'::jsonb where id = 'run-a'`;
    try {
      const { provider, jobs } = fakeProvider();
      await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
      expect(jobs).toEqual([]);
      expect(await level()).toMatchObject({ images_status: "disabled", resume_blocked: "figures-off", queued: false });
    } finally {
      await sql`update project_runs set pipeline = '{}'::jsonb where id = 'run-a'`;
    }
  });
});

describe("orphan GC and audit", () => {
  it("deletes only unvouched page files past the grace period, under this document's own folder, and turns a missing stored object into a resumable image", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await partialPass(storage, "doc-b", "org-b", "proj-b", "run-b");
    const old = new Date(Date.now() - FIGURE_ORPHAN_GRACE_MS - 60_000);
    const orphanOld = "ua/run-a/doppler/doc-a/images/page-0002/image-009.webp";
    const orphanNew = "ua/run-a/doppler/doc-a/images/page-0002/image-010.webp";
    storage.objects.set(orphanOld, { bytes: Buffer.from("x"), at: old });
    storage.objects.set(orphanNew, { bytes: Buffer.from("x"), at: new Date() });
    // The folder's own files (manifest) are never figures to collect, however old.
    storage.objects.get("ua/run-a/doppler/doc-a/images/manifest.jsonl")!.at = old;
    // A stored figure lost from storage.
    storage.objects.delete("ua/run-a/doppler/doc-a/images/page-0001/image-001.webp");
    const bBefore = [...storage.objects.keys()].filter((key) => key.startsWith("ub/"));
    const result = await auditFigureStorage({ sql, storage, limit: 10, env: GC });
    expect(storage.deletes).toEqual([orphanOld]);
    expect(storage.objects.has(orphanNew)).toBe(true);
    expect(result).toMatchObject({ orphans: 1, missing: 1 });
    expect((await sql`select status, reason, resumable from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`)[0]).toEqual({ status: "not-extracted", reason: "aborted", resumable: true });
    expect(await level()).toMatchObject({ images_status: "resumable", queued: true });
    // Org B's folder and rows are untouched.
    expect([...storage.objects.keys()].filter((key) => key.startsWith("ub/"))).toEqual(bBefore);
    expect((await sql`select count(*)::int as n from document_assets where document_id = 'doc-b' and storage_state = 'stored'`)[0]).toEqual({ n: 3 });
  });
});

const OLD = () => new Date(Date.now() - FIGURE_ORPHAN_GRACE_MS - 60_000);
const P11 = "ua/run-a/doppler/doc-a/images/page-0001/image-001.webp";
const P32 = "ua/run-a/doppler/doc-a/images/page-0003/image-002.webp";

describe("council fix round (#365): highs", () => {
  it("H1: a level with no runnable unit left (every cap spent) is blocked `attempts`, never re-queued", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await sql`update document_extraction_levels set resumes = 3 where document_id = 'doc-a'`;
    await due();
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(await level()).toMatchObject({ resume_blocked: "attempts", queued: false, leased: false, resume_vm_launches: 0 });
  });

  it("H2: a truncated listing is skipped whole: nothing is marked lost and nothing is deleted", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    storage.objects.delete(P11);
    storage.objects.set("ua/run-a/doppler/doc-a/images/page-0002/image-009.webp", { bytes: Buffer.from("x"), at: OLD() });
    storage.listKeys = async ({ prefix }) => ({ keys: [...storage.objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, 1), truncated: true });
    const result = await auditFigureStorage({ sql, storage, limit: 10, env: GC });
    expect(result).toMatchObject({ skippedTruncated: 1, missing: 0, orphans: 0 });
    expect(storage.deletes).toEqual([]);
    expect((await sql`select storage_state from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`)[0]).toEqual({ storage_state: "stored" });
  });

  it("H2: an object vouched for again between the GC's snapshot and its delete survives (re-checked under the ledger lock)", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    const [saved] = await sql<{ row: unknown }[]>`select to_jsonb(a) as row from document_assets a where document_id = 'doc-a' and asset_id = 'p1.1'`;
    await markAssetsLost(sql, { scope: scopeOf("doc-a"), ids: ["p1.1"] });
    storage.objects.get(P11)!.at = OLD();
    const head = storage.headObject;
    storage.headObject = async (key: string) => {
      // A same-run retry adopts the object right after the GC listed it as unvouched.
      if (key === P11) {
        await sql`delete from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`;
        await sql`insert into document_assets select * from jsonb_populate_record(null::document_assets, ${sql.json(saved!.row as never)}::jsonb)`;
      }
      return head(key);
    };
    const result = await auditFigureStorage({ sql, storage, limit: 10, env: GC });
    expect(result.orphans).toBe(0);
    expect(storage.objects.has(P11)).toBe(true);
    expect(storage.deletes).toEqual([]);
  });

  it("H3: runner, audit and backlog signals reach the OTel meter from a background pass", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const { provider } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    await auditFigureStorage({ sql, storage, limit: 10 });
    await figureResumeBacklog(sql);
    const names = telemetry.calls.map((call) => call.name);
    expect(names).toEqual(expect.arrayContaining(["resume.claimed", "resume.attempts", "resume.vm_ms", "resumable_backlog", "resume_oldest_age_s", "gc.orphan_files"]));
    expect(telemetry.calls.find((call) => call.name === "resume.attempts")!.labels).toEqual({ outcome: "completed" });
  });

  it("H4: a request never resets failures, the lifetime VM cap holds across requests, and failed VM time is recorded at cost", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    const provider: FigureResumeProvider = { timeoutMs: () => 60_000, resume: async () => { throw new Error("vm timed out"); } };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await due();
      await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    }
    expect(await level()).toMatchObject({ resume_failures: 2, resume_vm_launches: 2, resume_blocked: null });
    // The on-demand request (server figure-resume.ts): clears the backoff, never a counter.
    await sql`update document_extraction_levels set resume_after = now() - interval '1 second', resume_blocked = null where document_id = 'doc-a'`;
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(await level()).toMatchObject({ resume_failures: 3, resume_vm_launches: 3 });
    // Three launches without progress, and the page-scaled launch cap of a 3-page document (3): stopped, no fourth VM.
    await due();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(await level()).toMatchObject({ resume_vm_launches: 3, resume_blocked: "no-progress", queued: false });
    const events = await sql<{ metadata: Record<string, unknown> }[]>`select metadata from usage_events where metric = 'doppler-figures-resume-vm'`;
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.metadata.outcome === "failed" && event.metadata.billable === false)).toBe(true);
    // Lifetime: even with the failures cleared by hand, a document past its launches is blocked at claim.
    await sql`update document_extraction_levels set resume_failures = 0, resume_stalls = 0, resume_unit_failures = '{}'::jsonb, resume_blocked = null,
      resume_after = now() - interval '1 second', resume_vm_launches = 3 where document_id = 'doc-a'`;
    const { provider: fresh, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider: fresh, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(await level()).toMatchObject({ resume_blocked: "attempts", resume_vm_launches: 3 });
  });

  it("H4: an organization past its daily resume VM budget is deferred to the next UTC day", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`insert into figure_resume_org_days (org_id, day, launches, vm_ms) values ('org-a', (now() at time zone 'utc')::date, 50, 999999999)`;
    expect(await claimFigureResume(sql, "w1", ON)).toBeNull();
    const [row] = await sql<{ later: boolean }[]>`
      select resume_after > now() and resume_after <= now() + interval '25 hours' as later from document_extraction_levels where document_id = 'doc-a'`;
    expect(row).toEqual({ later: true });
  });
});

describe("page-scaled resume budget (figure-resume-limits.ts)", () => {
  const capped = (reason: string) => telemetry.calls.filter((call) => call.name === "resume.capped" && call.labels.reason === reason).length;

  it("a small document gets 3 launches and 180 s of VM time: under a minute left, it is blocked `vm-budget` with no VM", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await sql`update document_extraction_levels set resume_vm_ms = 130000 where document_id = 'doc-a'`;
    await due();
    const { provider, jobs } = fakeProvider();
    const log = vi.spyOn(console, "log");
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(await level()).toMatchObject({ resume_blocked: "vm-budget", blocked_at: true, queued: false, resume_vm_launches: 0 });
    expect(capped("vm-budget")).toBe(1);
    // Logged with its numbers (counts only).
    expect(log.mock.calls.map((call) => String(call[0])).find((line) => line.includes("reason=vm-budget")))
      .toMatch(/pages=3 launches=0\/3 vmMs=130000\/180000 stalls=0\/3 grants=0/);
    log.mockRestore();
  });

  it("each launch's timeout is capped at the document's remaining VM time, and the measured time is charged to the document", async () => {
    const storage = memoryStorage();
    await gapPass(storage, [{ first: 3, last: 3 }]);
    await sql`update document_extraction_levels set resume_vm_ms = 60000 where document_id = 'doc-a'`;
    await due();
    const { provider, jobs } = gapProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(Number((await level())!.resume_vm_ms)).toBeGreaterThanOrEqual(60_000);
  });

  it("a huge document keeps resuming past the old cap of 12 launches, up to its own page-scaled cap", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await sql`update documents set page_count = 20000 where id = 'doc-a'`;
    try {
      await sql`update document_extraction_levels set resume_vm_launches = 12 where document_id = 'doc-a'`;
      await due();
      const claimed = await claimFigureResume(sql, "w1", ON);
      expect(claimed?.document_id).toBe("doc-a");
      await sql`update document_extraction_levels set resume_lease_until = null, resume_lease_owner = null, resume_vm_launches = 95 where document_id = 'doc-a'`;
      expect(await claimFigureResume(sql, "w1", ON)).toBeNull();
      expect(await level()).toMatchObject({ resume_blocked: "attempts", queued: false });
      expect(capped("attempts")).toBe(1);
      // An operator can lower the ceiling (DOCSLURP_FIGURE_RESUME_LAUNCH_CEILING) for the same document.
      await sql`update document_extraction_levels set resume_blocked = null, resume_after = now() - interval '1 second', resume_vm_launches = 12 where document_id = 'doc-a'`;
      expect(await claimFigureResume(sql, "w1", { ...ON, DOCSLURP_FIGURE_RESUME_LAUNCH_CEILING: "12" })).toBeNull();
      expect(await level()).toMatchObject({ resume_blocked: "attempts" });
    } finally {
      await sql`update documents set page_count = 3 where id = 'doc-a'`;
    }
  });

  it("no progress: N launched resumes in a row that add nothing stop the document (`no-progress`), before the unit's failure cap", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    const env = { ...ON, DOCSLURP_FIGURE_RESUME_NO_PROGRESS: "2" };
    const { provider } = fakeProvider({ fail: true });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await due();
      await runFigureResumes({ sql, storage, provider, workerId: "w1", env });
    }
    expect(await level()).toMatchObject({ resume_failures: 2, resume_stalls: 2, resume_vm_launches: 2, resume_blocked: "no-progress", queued: false });
    expect(capped("no-progress")).toBe(1);
  });

  it("progress resets the no-progress count; a resume that never launched a VM does not count", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await sql`update document_extraction_levels set resume_stalls = 2 where document_id = 'doc-a'`;
    // Under a minute of daily budget left: deferred, no VM, the count stays.
    await sql`insert into figure_resume_org_days (org_id, day, launches, vm_ms) values ('org-a', (now() at time zone 'utc')::date, 1, ${120 * 60_000 - 30_000})`;
    await due();
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(await level()).toMatchObject({ resume_stalls: 2, resume_blocked: null });
    await sql`delete from figure_resume_org_days`;
    await sql`update document_extraction_levels set resume_after = now() - interval '1 second' where document_id = 'doc-a'`;
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toHaveLength(1);
    expect(await level()).toMatchObject({ resume_stalls: 0, resume_blocked: null, images_status: "complete" });
  });

  it("a request grant raises the caps: a 3-page document blocked at 3 launches resumes again", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await sql`update document_extraction_levels set resume_vm_launches = 3, resume_after = now() - interval '1 second' where document_id = 'doc-a'`;
    expect(await claimFigureResume(sql, "w1", ON)).toBeNull();
    expect(await level()).toMatchObject({ resume_blocked: "attempts" });
    // What the API's request does for a budget block (server figure-resume.ts): one grant, the block cleared.
    await sql`update document_extraction_levels set resume_blocked = null, resume_grants = 1, resume_after = now() - interval '1 second' where document_id = 'doc-a'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toHaveLength(1);
    expect(await level()).toMatchObject({ resume_vm_launches: 4, images_status: "complete" });
  });
});

describe("council fix round (#365): mediums", () => {
  it("M1: only completed documents whose Markdown committed are claimed; a new run's level starts with a clean queue", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    for (const status of ["failed", "cancelled", "pii_blocked", "processing"]) {
      await sql`update documents set status = ${status} where id = 'doc-a'`;
      expect(await claimFigureResume(sql, "w1", ON), status).toBeNull();
    }
    await sql`update documents set status = 'completed' where id = 'doc-a'`;
    await sql`update document_extraction_levels set markdown_complete = false where document_id = 'doc-a'`;
    expect(await claimFigureResume(sql, "w1", ON)).toBeNull();
    // A fresh pass in a new run: failures, launches, the block and the lease all start again.
    await sql`update document_extraction_levels set markdown_complete = true, resume_failures = 2, resume_vm_launches = 4, resume_blocked = 'vm-budget',
      resume_blocked_at = now(), resume_vm_ms = 999000, resume_stalls = 2, resume_grants = 2,
      resume_lease_owner = 'w9', resume_lease_until = now() + interval '1 hour' where document_id = 'doc-a'`;
    await sql`update documents set run_id = 'run-a2' where id = 'doc-a'`;
    await partialPass(storage, "doc-a", "org-a", "proj-a", "run-a2");
    expect(await level()).toMatchObject({ resume_failures: 0, resume_vm_launches: 0, resume_blocked: null, leased: false, resume_lease_owner: null, queued: true,
      resume_vm_ms: 0, resume_stalls: 0, resume_grants: 0, blocked_at: false });
  });

  it("M2: a runner that lost its lease never overwrites the new owner's queue state", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const { provider } = fakeProvider({
      fail: true,
      onResume: async () => { await sql`update document_extraction_levels set resume_lease_owner = 'w2', resume_lease_until = now() + interval '1 hour' where document_id = 'doc-a'`; },
    });
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(await level()).toMatchObject({ resume_lease_owner: "w2", leased: true, resume_failures: 0 });
  });

  it("M3: the audit adopts pending rows a crash left on a level nobody queued", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await sql`update document_assets set storage_state = 'pending', updated_at = now() - interval '2 days' where document_id = 'doc-a' and asset_id = 'p1.1'`;
    const result = await auditFigureStorage({ sql, storage, limit: 10, env: GC });
    expect(result.adopted).toBe(1);
    expect((await sql`select storage_state from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`)[0]).toEqual({ storage_state: "stored" });
  });

  it("M7: with the deploy figure flag off the runner does nothing, and the audit and GC are dry runs by default", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const { provider, jobs } = fakeProvider();
    expect(await runFigureResumes({ sql, storage, provider, workerId: "w1", env: { DOCSLURP_FIGURE_RESUME: "1" } })).toBe(0);
    expect(jobs).toEqual([]);
    storage.objects.set("ua/run-a/doppler/doc-a/images/page-0002/image-009.webp", { bytes: Buffer.from("x"), at: OLD() });
    storage.objects.delete(P11);
    const result = await auditFigureStorage({ sql, storage, limit: 10 });
    expect(result).toMatchObject({ orphans: 1, missing: 1, dryRun: { audit: true, gc: true } });
    expect(storage.deletes).toEqual([]);
    expect((await sql`select storage_state from document_assets where document_id = 'doc-a' and asset_id = 'p1.1'`)[0]).toEqual({ storage_state: "stored" });
  });

  it("M11: figures of a failed document are collected after its retention, and of a level no longer current after the grace period; other tenants untouched", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await partialPass(storage, "doc-a2");
    await partialPass(storage, "doc-b", "org-b", "proj-b", "run-b");
    for (const value of storage.objects.values()) value.at = new Date(Date.now() - FIGURE_FAILED_RETENTION_MS - 60_000);
    await sql`update documents set status = 'failed', updated_at = now() - interval '8 days' where id = 'doc-a'`;
    await sql`update document_extraction_levels set assets_current = false, updated_at = now() - interval '2 days' where document_id = 'doc-a2'`;
    // A failed document inside its retention keeps everything.
    await sql`update documents set status = 'failed', updated_at = now() where id = 'doc-b'`;
    const bBefore = [...storage.objects.keys()].filter((key) => key.startsWith("ub/"));
    await auditFigureStorage({ sql, storage, limit: 10, env: GC });
    expect([...storage.objects.keys()].filter((key) => key.includes("/doc-a/"))).toEqual([]);
    expect([...storage.objects.keys()].filter((key) => key.includes("/doc-a2/"))).toEqual([]);
    expect((await sql`select count(*)::int as n from document_assets where document_id in ('doc-a', 'doc-a2')`)[0]).toEqual({ n: 0 });
    expect([...storage.objects.keys()].filter((key) => key.startsWith("ub/"))).toEqual(bBefore);
    expect((await sql`select count(*)::int as n from document_assets where document_id = 'doc-b'`)[0]!.n).toBeGreaterThan(0);
  });
});

describe("PII: legacy outcomes are whole-document for a resume (R2 adversarial 1, 7)", () => {
  it("R2 repro: a legacy redact_artifacts outcome is never narrowed to pii_detections pages: nothing resumed, nothing served", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    // Legacy PII stage output: everything withheld document-wide; detections only for the primary source, page 1.
    await sql`update documents set metadata = jsonb_build_object('pii', jsonb_build_object('redacted', true, 'withheldArtifactUris', jsonb_build_array('s3://b/ka', 's3://b/ua/run-a/doppler/doc-a/images/page-0001/image-001.webp'))) where id = 'doc-a'`;
    await sql`insert into pii_detections (document_id, run_id, pattern_type, matched_prefix, page_number) values ('doc-a', 'run-a', 'email', 'a@', 1)`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(await level()).toMatchObject({ resume_blocked: "refused", queued: false, resume_vm_launches: 0 });
    const [run] = await sql<{ artifacts: Record<string, string> }[]>`select artifacts from project_runs where id = 'run-a'`;
    expect(Object.values(run!.artifacts)).not.toContain(`s3://b/${P32}`);
  });

  it("scope none with an active withheld list, redacted or blocked fails closed (refused)", async () => {
    for (const pii of [{ scope: "none", withheldArtifactUris: ["s3://b/x"] }, { scope: "none", redacted: true }, { scope: "sections", withheldSectionCount: 2 }]) {
      const storage = memoryStorage();
      await sql`delete from document_assets`; await sql`delete from document_extraction_levels`;
      await partialPass(storage);
      await due();
      await sql`update documents set metadata = ${sql.json({ pii })} where id = 'doc-a'`;
      const { provider, jobs } = fakeProvider();
      await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
      expect(jobs, JSON.stringify(pii)).toEqual([]);
      expect(await level()).toMatchObject({ resume_blocked: "refused" });
    }
  });

  it("no PII outcome, or one that withholds nothing, resumes normally", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update documents set metadata = '{"pii":{"scope":"none","redacted":false,"withheldArtifactUris":[]}}'::jsonb where id = 'doc-a'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toHaveLength(1);
    expect(await level()).toMatchObject({ images_status: "complete" });
  });
});

describe("PII withholding API (local until feat/pii-page-scoped lands)", () => {
  it("piiWithholding (shared semantics) fails closed; isPageWithheld follows the scope; resumeWithholding is stricter", () => {
    expect(piiWithholding({ status: "completed", metadata: {} })).toEqual({ scope: "none" });
    expect(piiWithholding({ status: "pii_blocked", metadata: {} }).scope).toBe("document");
    expect(piiWithholding({ status: "completed", metadata: { pii: "garbage" } }).scope).toBe("document");
    expect(piiWithholding({ status: "completed", metadata: { pii: { blocked: true } } }).scope).toBe("document");
    expect(piiWithholding({ status: "completed", metadata: { pii: { scope: "pages", withheldPages: "x" } } }).scope).toBe("document");
    const pages = piiWithholding({ status: "completed", metadata: { pii: { scope: "pages", withheldPages: [3] } } });
    expect(pages).toEqual({ scope: "pages", pages: new Set([3]) });
    expect(isPageWithheld(pages, 3)).toBe(true);
    expect(isPageWithheld(pages, 2)).toBe(false);
    expect(isPageWithheld(pages, [1, 3])).toBe(true);
    expect(isPageWithheld(pages, null)).toBe(true);
    expect(isPageWithheld({ scope: "document", reason: "x" }, 1)).toBe(true);
    expect(isPageWithheld({ scope: "none" }, null)).toBe(false);
    // The resume's rule: a legacy or inconsistent outcome is whole-document.
    expect(resumeWithholding({ status: "completed", metadata: { pii: { redacted: true } } }).scope).toBe("document");
    expect(resumeWithholding({ status: "completed", metadata: { pii: { scope: "none", withheldArtifactUris: ["s3://b/x"] } } }).scope).toBe("document");
    expect(resumeWithholding({ status: "completed", metadata: { pii: { scope: "pages", withheldPages: [3], withheldArtifactUris: ["s3://b/x"] } } }).scope).toBe("pages");
    expect(resumeWithholding({ status: "completed", metadata: {} }).scope).toBe("none");
  });

  it("a page-scoped document (metadata.pii.scope = pages) resumes figures on clean pages; the PII page's figures are withheld", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update documents set metadata = '{"pii":{"scope":"pages","withheldPages":[3],"withheldArtifactUris":[]}}'::jsonb where id = 'doc-a'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toHaveLength(1);
    expect(await level()).toMatchObject({ images_status: "complete", resume_blocked: null });
    const [doc] = await sql<{ withheld: string[] }[]>`select metadata->'pii'->'withheldArtifactUris' as withheld from documents where id = 'doc-a'`;
    expect(doc!.withheld).toEqual([`s3://b/${P32}`]);
  });

  it("a unit whose pages are all withheld is skipped (no VM), and nothing runnable is left", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update documents set metadata = '{"pii":{"scope":"pages","withheldPages":[1,2,3]}}'::jsonb where id = 'doc-a'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(await level()).toMatchObject({ queued: false, resume_blocked: "attempts", resume_vm_launches: 0 });
  });

  it("an outcome that cannot be read skips all figures (no VM) and leaves the queue", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update documents set metadata = '{"pii":{"scope":"pages","withheldPages":"unreadable"}}'::jsonb where id = 'doc-a'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(await level()).toMatchObject({ queued: false, resume_blocked: "refused", resume_vm_launches: 0 });
  });

  it("a pii_blocked document is never claimed", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update documents set status = 'pii_blocked' where id = 'doc-a'`;
    expect(await claimFigureResume(sql, "w1", ON)).toBeNull();
  });
});

/** A complete unsharded pass with `gaps` (ranges no shard returned), committed as the stage does. */
async function gapPass(storage: ReturnType<typeof memoryStorage>, gaps: Array<{ first: number; last: number }>) {
  const built = v2Manifest();
  const dir = await mkdtemp(path.join(work, "pass-"));
  await writeV3Folder(dir, v3Text(built.manifest), built.files);
  const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "complete", sourceSha256: V2_SOURCE_SHA });
  const stored = await storeDopplerFigures({ storage, document: { id: "doc-a", userId: "ua", runId: "run-a" }, runId: "run-a", figures: set, markdown: "" });
  const write = ledgerWriteForStoredFigures({ set, stored, outcome: { status: "partial", exitCode: 5, gaps: gaps.map((g) => ({ ...g, reason: "plugin:shard-over-share" as const })) } });
  await writeDocumentAssetLedger(sql, { scope: scopeOf("doc-a"), level: { ...write.level, markdownComplete: true }, assets: write.assets });
}

/** A provider for gap units: an empty shard folder for exactly the asked range (or `split`: two folders). */
function gapProvider(options: { split?: boolean } = {}) {
  const jobs: FigureResumeJob[] = [];
  const provider: FigureResumeProvider = {
    timeoutMs: () => 60 * 60_000,
    resume: async (job) => {
      jobs.push(job);
      const ranges: Array<[number, number]> = options.split && job.pages && job.pages[0] < job.pages[1]
        ? [[job.pages[0], job.pages[0]], [job.pages[0] + 1, job.pages[1]]] : [job.pages ?? [1, 3]];
      for (const [first, last] of ranges) {
        const empty = { ...v2Manifest().manifest, images: [], batches: [{ pages: [first, last], status: "ok" }], complete: true, resumable: false };
        empty.totals = Object.fromEntries(Object.keys(empty.totals).map((key) => [key, key === "batches" ? 1 : 0]));
        const shardDir = path.join(job.dir, "shards", dopplerShardFolder(first, last));
        await mkdir(shardDir, { recursive: true });
        await writeFile(path.join(shardDir, "manifest.jsonl"), v3Text(empty as never, { pages: [first, last] }));
      }
      return { status: "extracted", exitCode: 0 };
    },
  };
  return { provider, jobs };
}

describe("council round 2 (#365)", () => {
  it("R2-H1 / repro R1 inverted: a document retried between the audit's selection and its collection loses nothing", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    for (const value of storage.objects.values()) value.at = new Date(Date.now() - FIGURE_FAILED_RETENTION_MS - 60_000);
    await sql`update documents set status = 'failed', updated_at = now() - interval '8 days' where id = 'doc-a'`;
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from document_assets where document_id = 'doc-a'`)[0]!.n;
    const objectsBefore = [...storage.objects.keys()].filter((key) => key.includes("/doc-a/")).length;
    const list = storage.listKeys;
    storage.listKeys = async (args) => {
      await sql`update documents set status = 'queued', updated_at = now() where id = 'doc-a'`;
      return await list(args);
    };
    const result = await auditFigureStorage({ sql, storage, limit: 10, env: GC });
    expect(result.skippedChanged).toBe(1);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from document_assets where document_id = 'doc-a'`)[0]!.n).toBe(before);
    expect([...storage.objects.keys()].filter((key) => key.includes("/doc-a/")).length).toBe(objectsBefore);
    expect((await sql`select assets_current from document_extraction_levels where document_id = 'doc-a'`)[0]).toEqual({ assets_current: true });
  });

  it("R2-H1: a non-current level revived during the pass is left alone", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    for (const value of storage.objects.values()) value.at = OLD();
    await sql`update document_extraction_levels set assets_current = false, updated_at = now() - interval '2 days' where document_id = 'doc-a'`;
    const list = storage.listKeys;
    storage.listKeys = async (args) => {
      await sql`update document_extraction_levels set assets_current = true, updated_at = now() where document_id = 'doc-a'`;
      return await list(args);
    };
    await auditFigureStorage({ sql, storage, limit: 10, env: GC });
    expect(storage.deletes).toEqual([]);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from document_assets where document_id = 'doc-a'`)[0]!.n).toBeGreaterThan(0);
  });

  it("R2-H1 (b): retention resets the run's extract-markdown checkpoint and figure slots, so a retry re-extracts; pii_blocked documents expire too", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    for (const value of storage.objects.values()) value.at = new Date(Date.now() - FIGURE_FAILED_RETENTION_MS - 60_000);
    await sql`update project_runs set artifacts = '{"doc-a:doppler-figure:p1.1":"s3://b/x","doc-a:doppler-figures":"s3://b/y","doc-a:markdown":"s3://b/m"}'::jsonb where id = 'run-a'`;
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status) values ('run-a', 'doc-a', 'extract-markdown', 'completed'), ('run-a', 'doc-a', 'embed', 'failed')
      on conflict do nothing`;
    await sql`update documents set status = 'pii_blocked', updated_at = now() - interval '8 days' where id = 'doc-a'`;
    try {
      await auditFigureStorage({ sql, storage, limit: 10, env: GC });
      expect([...storage.objects.keys()].filter((key) => key.includes("/doc-a/"))).toEqual([]);
      expect((await sql<{ n: number }[]>`select count(*)::int as n from document_assets where document_id = 'doc-a'`)[0]!.n).toBe(0);
      // The level leaves the audit set: none, current, no bytes.
      expect((await sql`select images_status, assets_current, asset_bytes::int as b from document_extraction_levels where document_id = 'doc-a'`)[0]).toEqual({ images_status: "none", assets_current: true, b: 0 });
      expect(await sql`select stage_name from document_run_stage_states where run_id = 'run-a' and document_id = 'doc-a' order by stage_name`).toEqual([{ stage_name: "embed" }]);
      const [run] = await sql<{ artifacts: Record<string, string> }[]>`select artifacts from project_runs where id = 'run-a'`;
      expect(run!.artifacts).toEqual({ "doc-a:markdown": "s3://b/m" });
    } finally {
      await sql`delete from document_run_stage_states where run_id = 'run-a'`;
    }
  });

  it("R2-M1: documents whose figure step never ran are not in the audit set; the selection can use the partial index", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    // A document with a level but no figures (a non-PDF, figures off): current, no bytes.
    await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status, assets_current)
      values ('doc-a2', 'org-a', 'proj-a', 'run-a', true, 'none', true)`;
    const result = await auditFigureStorage({ sql, storage, limit: 10 });
    expect(result.documents).toBe(1);
    await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const plan = (await tx.unsafe(`explain select * from document_extraction_levels where asset_bytes > 0 or assets_pending > 0 or not assets_current
        order by audited_at nulls first, document_id limit 50`)).map((r) => Object.values(r)[0]).join("\n");
      expect(plan).toContain("document_extraction_levels_audit_idx");
    });
  });

  it("R2-M3: failures count per unit: a unit at three failures is skipped, the others still resume", async () => {
    const storage = memoryStorage();
    await gapPass(storage, [{ first: 2, last: 2 }, { first: 3, last: 3 }]);
    await sql`update document_extraction_levels set resume_unit_failures = '{"2-2": 3}'::jsonb where document_id = 'doc-a'`;
    await due();
    const { provider, jobs } = gapProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs.map((job) => job.pages)).toEqual([[3, 3]]);
  });

  it("R2 adversarial 4: a launch's timeout is capped at the organization's remaining daily budget, reserved, then settled", async () => {
    const storage = memoryStorage();
    await gapPass(storage, [{ first: 3, last: 3 }]);
    await due();
    // 115 of the 120 daily minutes used: 5 minutes left.
    await sql`insert into figure_resume_org_days (org_id, day, launches, vm_ms) values ('org-a', (now() at time zone 'utc')::date, 1, ${115 * 60_000})`;
    const { provider, jobs } = gapProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.timeoutMs).toBeLessThanOrEqual(5 * 60_000);
    expect((await sql`select reserved_ms::int as r from figure_resume_org_days where org_id = 'org-a'`)[0]).toEqual({ r: 0 });
  });

  it("R2 adversarial 4: under a minute of daily budget left, the unit is deferred to the next UTC day: no VM, no failure", async () => {
    const storage = memoryStorage();
    await gapPass(storage, [{ first: 3, last: 3 }]);
    await due();
    await sql`insert into figure_resume_org_days (org_id, day, launches, vm_ms) values ('org-a', (now() at time zone 'utc')::date, 1, ${120 * 60_000 - 30_000})`;
    const { provider, jobs } = gapProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    const [row] = await sql<{ later: boolean; failures: number; launches: number }[]>`
      select resume_after > now() as later, resume_failures as failures, resume_vm_launches as launches from document_extraction_levels where document_id = 'doc-a'`;
    expect(row).toEqual({ later: true, failures: 0, launches: 0 });
  });

  it("R2-L5: a range resume that comes back in another shape is refused before anything is uploaded", async () => {
    const storage = memoryStorage();
    await gapPass(storage, [{ first: 2, last: 3 }]);
    await due();
    const before = new Set(storage.objects.keys());
    const { provider } = gapProvider({ split: true });
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect([...storage.objects.keys()].filter((key) => !before.has(key))).toEqual([]);
    expect(await level()).toMatchObject({ resume_blocked: "refused" });
  });

  it("R2 adversarial 5: a runner write with a lease that is no longer the document's lands nothing (stale-write)", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await sql`update document_extraction_levels set resume_lease_owner = 'w2:aaaaaaaa', resume_lease_until = now() + interval '1 hour' where document_id = 'doc-a'`;
    const write = ledgerWriteForNoFiguresForTest();
    await expect(writeDocumentAssetLedger(sql, { scope: { ...scopeOf("doc-a"), lease: "w1:bbbbbbbb" }, ...write })).rejects.toMatchObject({ rule: "stale-write" });
  });

  it("R2-L1: a crash between a resume's ledger commit and its slot update is repaired (claim or audit)", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const { provider } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    await sql`update project_runs set artifacts = artifacts - 'doc-a:doppler-figure:p3.2' where id = 'run-a'`;
    const result = await auditFigureStorage({ sql, storage, limit: 10, env: GC });
    expect(result.slotsRepaired).toBeGreaterThanOrEqual(1);
    const [run] = await sql<{ artifacts: Record<string, string> }[]>`select artifacts from project_runs where id = 'run-a'`;
    expect(run!.artifacts["doc-a:doppler-figure:p3.2"]).toBe(`s3://b/${P32}`);
  });
});

function ledgerWriteForNoFiguresForTest() {
  return { level: { imagesStatus: "failed" as const, imagesExitCode: null, manifestVersion: null, dopplerBuild: null, run: null, manifest: null, markdownComplete: true }, assets: [], levelOnly: true };
}

describe("R6-H1: the resume converts quarantine's parse source, never the upload (lib/parse-source.ts)", () => {
  const launches = async () => (await sql<{ n: number }[]>`select resume_vm_launches as n from document_extraction_levels where document_id = 'doc-a'`)[0]!.n;

  it("an undecided document (no decision from this build's quarantine) is blocked unscanned: no download, no VM, counted", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update documents set parse_source_scan_version = null, parse_source_sha256 = null where id = 'doc-a'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(storage.downloaded).toEqual([]);
    expect(await launches()).toBe(0);
    expect(await level()).toMatchObject({ resume_blocked: "unscanned", queued: false });
    expect(telemetry.calls).toEqual(expect.arrayContaining([expect.objectContaining({ name: "resume.parse_source_refused", labels: { reason: "unscanned" } })]));
  });

  it("a rejected decision (its hash is not the upload's server hash) is unscanned: refused the same way", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update documents set parse_source_sha256 = ${"c".repeat(64)} where id = 'doc-a'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(storage.downloaded).toEqual([]);
    expect(await level()).toMatchObject({ resume_blocked: "unscanned" });
  });

  it("an encrypted PDF converts its scanned copy, hash-bound to the copy; the upload is never read", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    // The upload's own bytes differ (the encrypted original); the scanned copy hashes to what the figures were made from.
    await sql`update documents set source_sha256 = ${"d".repeat(64)}, parse_source_key = 'ua/run-a/quarantine/doc-a.scanned.pdf', parse_source_sha256 = ${V2_SOURCE_SHA} where id = 'doc-a'`;
    storage.sources.set("ka", Buffer.from("%PDF-1.7 encrypted original"));
    try {
      const { provider, jobs } = fakeProvider();
      await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
      // The source read is the scanned copy; the upload ("ka") is never downloaded (document.md is read for the index).
      expect(storage.downloaded.filter((key) => !key.endsWith("/document.md"))).toEqual(["ua/run-a/quarantine/doc-a.scanned.pdf"]);
      expect(storage.downloaded).not.toContain("ka");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.sourceSha256).toBe(V2_SOURCE_SHA);
      expect(await level()).toMatchObject({ images_status: "complete" });
    } finally {
      await sql`update documents set source_sha256 = ${V2_SOURCE_SHA} where id = 'doc-a'`;
    }
  });

  it("hash mismatch: a decided source other than the one the figures were made from is refused before any download", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    await sql`update documents set parse_source_key = 'ua/run-a/quarantine/doc-a.scanned.pdf', parse_source_sha256 = ${"e".repeat(64)} where id = 'doc-a'`;
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(jobs).toEqual([]);
    expect(storage.downloaded).toEqual([]);
    expect(await level()).toMatchObject({ resume_blocked: "refused" });
  });

  it("hash mismatch: staged bytes that are not the decided source's (a swapped object) are refused: no VM, no launch counted", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    storage.sources.set("ka", Buffer.from("%PDF-1.7 swapped after the scan"));
    const { provider, jobs } = fakeProvider();
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(storage.downloaded).toEqual(["ka"]);
    expect(jobs).toEqual([]);
    expect(await launches()).toBe(0);
    expect(await level()).toMatchObject({ resume_blocked: "refused", queued: false });
  });

  it("F1/F2: documentParseSource is org-scoped and reads only the claimed run of a completed document", async () => {
    const { documentParseSource } = await import("../db/store.js");
    const env = ON as NodeJS.ProcessEnv;
    expect(await documentParseSource(sql, { orgId: "org-a", documentId: "doc-a", runId: "run-a" }, env)).toMatchObject({ parseSourceDecision: "original", sourceSha256: V2_SOURCE_SHA });
    // Another organization's id for this document, or this organization for another's: nothing.
    expect(await documentParseSource(sql, { orgId: "org-b", documentId: "doc-a", runId: "run-a" }, env)).toBeNull();
    expect(await documentParseSource(sql, { orgId: "org-a", documentId: "doc-b", runId: "run-b" }, env)).toBeNull();
    // Another run (a reprocess since the claim), or a document no longer completed: nothing.
    expect(await documentParseSource(sql, { orgId: "org-a", documentId: "doc-a", runId: "run-a2" }, env)).toBeNull();
    await sql`update documents set status = 'failed' where id = 'doc-a'`;
    expect(await documentParseSource(sql, { orgId: "org-a", documentId: "doc-a", runId: "run-a" }, env)).toBeNull();
  });
});
