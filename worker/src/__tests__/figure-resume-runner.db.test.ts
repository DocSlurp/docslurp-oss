import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { figureLedgerHooks, ledgerWriteForStoredFigures, writeDocumentAssetLedger, type DocumentAssetLedgerScope } from "../db/document-asset-ledger.js";
import { Store } from "../db/store.js";
import { readDopplerFigureDir, storeDopplerFigures } from "../extractors/doppler-figures.js";
import type { FigureResumeJob } from "../extractors/plugins.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { auditFigureStorage, claimFigureResume, runFigureResumes, FIGURE_ORPHAN_GRACE_MS, type FigureResumeProvider } from "../figures/resume-runner.js";
import { v2Manifest, v3Text, writeV3Folder, V2_SOURCE_SHA } from "../test/doppler-manifest-v2.js";
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
const ON = { DOCSLURP_FIGURE_RESUME: "1" };

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
    downloadToTempFile: async (key: string) => { const file = path.join(work, `src-${key}-${Math.random()}`); await writeFile(file, `pdf of ${key}`); return file; },
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
      jobs.push({ ...job, inputFiles: await readdir(path.dirname(job.manifest)) });
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
  select images_status, resumes, resume_failures, resume_after is not null as queued, resume_blocked, resume_lease_until is not null as leased, assets_resumable
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
    expect(events).toEqual([expect.objectContaining({ metric: "doppler-figures-resume-vm", cost: 0, org_id: "org-a", metadata: expect.objectContaining({ billable: false }) })]);
    expect(storage.deletes).toEqual([]);
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
    expect(await level()).toMatchObject({ resume_blocked: "attempts", queued: false, images_status: "resumable" });
    expect(storage.deletes).toEqual([]);
  });

  it("a resume that hands back another file for a stored image is refused (resume-rewrite) and changes nothing", async () => {
    const storage = memoryStorage();
    await partialPass(storage);
    await due();
    const rows = await sql`select asset_id, sha256, storage_state from document_assets where document_id = 'doc-a' order by asset_id`;
    const { provider } = fakeProvider({ rewrite: true });
    await runFigureResumes({ sql, storage, provider, workerId: "w1", env: ON });
    expect(await sql`select asset_id, sha256, storage_state from document_assets where document_id = 'doc-a' order by asset_id`).toEqual(rows);
    expect(await level()).toMatchObject({ images_status: "resumable", resume_failures: 1 });
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
    const first = await claimFigureResume(sql, "w1", 60_000);
    expect(first?.org_id).toBe("org-a");
    const second = await claimFigureResume(sql, "w2", 60_000);
    expect(second?.org_id).toBe("org-b");
    expect(await claimFigureResume(sql, "w3", 60_000)).toBeNull();
  });

  it("never claims for an organization that may not spend (budget paused): re-queued later", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const storage = memoryStorage();
    await partialPass(storage, "doc-b", "org-b", "proj-b", "run-b");
    await due("doc-b");
    await sql`update organizations set budget_paused = true where id = 'org-b'`;
    try {
      expect(await claimFigureResume(sql, "w1", 60_000)).toBeNull();
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
    expect(await level("doc-off")).toMatchObject({ resume_blocked: "resume-off", queued: false });
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
    const result = await auditFigureStorage({ sql, storage, limit: 10 });
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
