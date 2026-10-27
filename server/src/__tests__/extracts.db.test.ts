import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Extract mode against a migrated database: retention policy and spend
 * gates, tenant-scoped reads, the download signer, and the sweep (settle,
 * extended-retention charge, download export, email, and deletion of rows and
 * the storage prefix). Storage, Temporal and email are fakes.
 */
const mocks = vi.hoisted(() => ({
  objects: new Map<string, number>(),
  purged: [] as string[],
  deleted: [] as string[],
  sign: vi.fn(async ({ key, expiresInSeconds }: { key: string; expiresInSeconds?: number }) => `https://storage.test/${key}?X-Amz-Expires=${expiresInSeconds}`),
  startExport: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  email: vi.fn(async () => undefined),
  notificationEnabled: vi.fn(async () => true),
}));

vi.mock("../lib/storage.js", () => ({
  signDownloadGet: mocks.sign,
  deleteUploadedObject: vi.fn(async (key: string) => { mocks.deleted.push(key); mocks.objects.delete(key); }),
  // One page of up to 2 keys per call, so the multi-pass path is exercised.
  deleteObjectsUnderPrefix: vi.fn(async (prefix: string) => {
    mocks.purged.push(prefix);
    const keys = [...mocks.objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, 2);
    if (keys.length === 0) return { objects: 0, bytes: 0, failed: 0, done: true };
    let bytes = 0;
    for (const key of keys) { bytes += mocks.objects.get(key)!; mocks.objects.delete(key); }
    return { objects: keys.length, bytes, failed: 0, done: false };
  }),
}));
vi.mock("../lib/temporal.js", () => ({ startDocumentExportWorkflow: mocks.startExport, signalPipelineCancel: mocks.cancel }));
vi.mock("../services/notifications.js", () => ({
  sendExtractReadyEmail: mocks.email,
  sendExportReadyEmail: vi.fn(async () => undefined),
  isNotificationEnabled: mocks.notificationEnabled,
}));
vi.mock("../search/eligibility-hint.js", () => ({ notifySearchEligibilityChanged: vi.fn(async () => undefined) }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let extracts: typeof import("../services/extracts.js");

const MB = 1024 * 1024;
const owner = { type: "session", userId: "u", sessionId: "s", user: { id: "u", email: "u@example.test", name: "U" } } as const;
const stranger = { type: "session", userId: "stranger", sessionId: "s2", user: { id: "stranger", email: "s@example.test", name: "S" } } as const;
const key = (overrides: Record<string, unknown> = {}) => ({
  type: "apiKey", userId: "u",
  apiKey: { keyId: "k", userId: "u", orgId: "o", keyType: "server", scopes: ["ingest", "artifacts"], workspaceIds: [], allowedDomains: [], rateLimitRpm: 60, rateLimitPpd: 1000, rateLimits: [], ...overrides },
}) as never;

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'u@example.test'), ('stranger', 'S', 's@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'extract-org', 'u'), ('o2', 'Other', 'other-org', 'stranger')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner'), ('o2', 'stranger', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Inbox'), ('w-other', 'o2', 'stranger', 'Theirs')`;
  extracts = await import("../services/extracts.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.objects.clear();
  mocks.purged.length = 0;
  mocks.deleted.length = 0;
  delete process.env.DOCSLURP_BILL_STORAGE;
  delete process.env.DOCSLURP_EXTRACT_FREE_RETENTION_HOURS;
  delete process.env.DOCSLURP_EXTRACT_MAX_RETENTION_DAYS;
  await sql`delete from document_exports`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
  await sql`delete from extracts`;
  await sql`delete from storage_cleanup_queue`;
  await sql`delete from document_cleanup_queue`;
});

async function newExtract(options: { retentionDays?: number } = {}) {
  return await extracts.createExtract({ userId: "u", orgId: "o", workspaceId: "w", options });
}

/** What intake and the worker leave behind: an extract run with documents and objects under the prefix. */
async function seedRun(extract: { id: string; storagePrefix: string }, status = "completed") {
  const runId = `run-${extract.id.slice(4, 12)}`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, extract_id, storage_prefix)
    values (${runId}, 'o', 'u', 'w', 'bulk-upload', ${status}, ${status}, '{}', ${extract.id}, ${extract.storagePrefix})`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, file_size, page_count, canonical_id)
    values (${`${runId}-d1`}, 'o', 'u', 'w', ${runId}, 'Report.pdf', 'application/pdf', ${`${extract.storagePrefix}/raw/r.pdf`}, ${status === "completed" ? "completed" : "processing"}, ${2 * MB}, 10, ${`docslurp:extract:${extract.id}:d1`})`;
  await extracts.attachExtractRun(extract.id, runId);
  for (const [name, size] of [["raw/r.pdf", 2 * MB], ["images/d1/page-1.png", 1000], ["parser/d1.json", 500], ["markdown/d1.md", 200]] as const) {
    mocks.objects.set(`${extract.storagePrefix}/${name}`, size);
  }
  return runId;
}

describe("extract retention policy", () => {
  it("defaults to the free 48 hours, takes env overrides and refuses retention past the cap", async () => {
    expect(extracts.resolveExtractRetention({})).toEqual({ retentionHours: 48, paid: false });
    expect(extracts.resolveExtractRetention({ retentionDays: 2 })).toEqual({ retentionHours: 48, paid: false });
    expect(extracts.resolveExtractRetention({ retentionDays: 30 })).toEqual({ retentionHours: 720, paid: true });
    expect(() => extracts.resolveExtractRetention({ retentionDays: 31 })).toThrow(expect.objectContaining({ status: 400, code: "retention_exceeds_cap", details: { maxRetentionDays: 30 } }));
    expect(extracts.extractRetentionPolicy({ DOCSLURP_EXTRACT_FREE_RETENTION_HOURS: "24", DOCSLURP_EXTRACT_MAX_RETENTION_DAYS: "90" })).toEqual({ freeHours: 24, maxDays: 90 });
    // Invalid values fall back to the defaults instead of opening the cap.
    expect(extracts.extractRetentionPolicy({ DOCSLURP_EXTRACT_MAX_RETENTION_DAYS: "-1", DOCSLURP_EXTRACT_FREE_RETENTION_HOURS: "lots" })).toEqual({ freeHours: 48, maxDays: 30 });
  });

  it("records the expiry row with the tenant prefix; a paid window without credits is refused before anything is stored", async () => {
    const free = await newExtract();
    expect(free.storagePrefix).toBe(`extracts/o/${free.id}`);
    const [row] = await sql<{ hours: number; paid: boolean; state: string }[]>`
      select round(extract(epoch from expires_at - created_at) / 3600)::int as hours, paid_retention as paid, state from extracts where id = ${free.id}`;
    expect(row).toEqual({ hours: 48, paid: false, state: "active" });

    process.env.DOCSLURP_BILL_STORAGE = "true";
    await expect(newExtract({ retentionDays: 30 })).rejects.toMatchObject({ name: "SpendBlockedError", statusCode: 402 });
    await expect(newExtract({ retentionDays: 45 })).rejects.toMatchObject({ code: "retention_exceeds_cap" });
    expect((await sql`select id from extracts`).length).toBe(1);
  });
});

describe("extract reads are tenant-scoped", () => {
  it("shows an extract to a reader of its workspace and to a key of its org, and to nobody else", async () => {
    const extract = await newExtract();
    expect(await extracts.getExtractForActor(extract.id, owner)).toMatchObject({ id: extract.id });
    expect(await extracts.getExtractForActor(extract.id, key())).toMatchObject({ id: extract.id });
    // Another tenant, a key of another org, a key restricted to other workspaces, and a guessed ID all see nothing.
    expect(await extracts.getExtractForActor(extract.id, stranger)).toBeNull();
    expect(await extracts.getExtractForActor(extract.id, key({ orgId: "o2" }))).toBeNull();
    expect(await extracts.getExtractForActor(extract.id, key({ workspaceIds: ["w-elsewhere"] }))).toBeNull();
    expect(await extracts.getExtractForActor("ext_00000000000000000000000000000000", owner)).toBeNull();
    expect(await extracts.getExtractForActor("../ext", owner)).toBeNull();
    expect((await extracts.listExtractsForActor(stranger)).map((item) => item.id)).toEqual([]);
    expect((await extracts.listExtractsForActor(owner)).map((item) => item.id)).toEqual([extract.id]);
  });

  it("reports pending, processing and expired, with the 410 message for expired extracts", async () => {
    const extract = await newExtract();
    expect(extracts.describeExtract((await extracts.getExtractForActor(extract.id, owner))!).status).toBe("pending");
    await seedRun(extract, "processing");
    expect(extracts.describeExtract((await extracts.getExtractForActor(extract.id, owner))!)).toMatchObject({ status: "processing", download: { status: "pending", url: null } });
    await sql`update extracts set expires_at = now() - interval '1 minute' where id = ${extract.id}`;
    const expired = (await extracts.getExtractForActor(extract.id, owner))!;
    expect(extracts.describeExtract(expired)).toMatchObject({ status: "expired", download: { status: "expired", url: null } });
    await expect(extracts.signExtractDownload(expired)).rejects.toMatchObject({ status: 410, code: "extract_expired" });
  });
});

describe("extract sweep", () => {
  it("settles a finished extract, queues a run-scoped download under its prefix and emails once it is ready", async () => {
    const extract = await newExtract();
    const runId = await seedRun(extract);
    await extracts.sweepExtracts();

    const [settled] = await sql<{ pages: number; stored_bytes: string; export_id: string; retention_credits: string | null }[]>`
      select pages, stored_bytes::text, export_id, retention_credits::text from extracts where id = ${extract.id}`;
    expect(settled!.pages).toBe(10);
    expect(Number(settled!.stored_bytes)).toBe(2 * MB + 10 * (96 + 28) * 1024);
    expect(settled!.retention_credits).toBeNull();
    const [download] = await sql<{ run_id: string; object_key: string; notify_email: boolean; max_expires_at: Date; expires_at: Date; filename: string }[]>`
      select run_id, object_key, notify_email, max_expires_at, expires_at, filename from document_exports where id = ${settled!.export_id}`;
    expect(download).toMatchObject({ run_id: runId, object_key: `${extract.storagePrefix}/exports/${settled!.export_id}/`, notify_email: false, filename: "Report.zip" });
    expect(mocks.startExport).toHaveBeenCalledWith({ exportId: settled!.export_id }, { large: false });
    // Not ready yet: no email, no signed link.
    expect(mocks.email).not.toHaveBeenCalled();
    await expect(extracts.signExtractDownload((await extracts.getExtractForActor(extract.id, owner))!)).rejects.toMatchObject({ code: "download_not_ready" });

    // The worker finishes the zip under the prefix.
    const zip = `${extract.storagePrefix}/exports/${settled!.export_id}/a1.zip`;
    await sql`update document_exports set status = 'ready', object_key = ${zip}, completed_at = now() where id = ${settled!.export_id}`;
    await extracts.sweepExtracts();
    expect(mocks.email).toHaveBeenCalledTimes(1);
    const [emailArgs] = mocks.email.mock.calls[0] as unknown as [{ url: string; ready: boolean; recipientEmail: string }];
    expect(emailArgs).toMatchObject({ ready: true, recipientEmail: "u@example.test" });
    // The emailed link names the export for the signed-in app page; it is not a signed storage URL.
    expect(emailArgs.url).toMatch(/\/app\?export=exp_[0-9a-f]{32}$/);
    expect(emailArgs.url).not.toContain("X-Amz");

    const ready = (await extracts.getExtractForActor(extract.id, owner))!;
    expect(extracts.describeExtract(ready)).toMatchObject({ status: "completed", download: { status: "ready", url: `/v1/extracts/${extract.id}/download` } });
    expect(await extracts.signExtractDownload(ready)).toBe(`https://storage.test/${zip}?X-Amz-Expires=120`);

    // A second sweep neither emails nor queues again.
    await extracts.sweepExtracts();
    expect(mocks.email).toHaveBeenCalledTimes(1);
    expect(mocks.startExport).toHaveBeenCalledTimes(1);
  });

  it("skips the email when the request opted out or the user turned run emails off", async () => {
    const quiet = await extracts.createExtract({ userId: "u", orgId: "o", workspaceId: "w", options: { notifyEmail: false } });
    await seedRun(quiet);
    const muted = await newExtract();
    await seedRun(muted);
    mocks.notificationEnabled.mockResolvedValue(false);
    await extracts.sweepExtracts();
    await sql`update document_exports set status = 'ready', object_key = object_key || 'a1.zip'`;
    await extracts.sweepExtracts();
    expect(mocks.email).not.toHaveBeenCalled();
    mocks.notificationEnabled.mockResolvedValue(true);
  });

  it("refuses to sign a download that is not this extract's own object inside its prefix", async () => {
    const extract = await newExtract();
    await seedRun(extract);
    await extracts.sweepExtracts();
    const [{ export_id: exportId }] = await sql<{ export_id: string }[]>`select export_id from extracts where id = ${extract.id}`;
    // Tampered: the export row points outside the extract prefix.
    await sql`update document_exports set status = 'ready', object_key = 'exports/o/w/other/a1.zip' where id = ${exportId}`;
    await expect(extracts.signExtractDownload((await extracts.getExtractForActor(extract.id, owner))!)).rejects.toMatchObject({ code: "download_failed" });
    // Replayed onto another extract: a second extract cannot borrow the first one's export.
    const other = await newExtract();
    await seedRun(other);
    await sql`update extracts set export_id = ${exportId}, completed_at = now() where id = ${other.id}`;
    await sql`update document_exports set object_key = ${`${extract.storagePrefix}/exports/${exportId}/a1.zip`} where id = ${exportId}`;
    await expect(extracts.signExtractDownload((await extracts.getExtractForActor(other.id, owner))!)).rejects.toMatchObject({ code: "download_not_ready" });
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("charges extended retention once on the measured size, through the usage ledger and a credit debit", async () => {
    process.env.DOCSLURP_BILL_STORAGE = "true";
    // Inserted directly: the spend pre-check is covered above.
    const id = "ext_" + "a".repeat(32);
    await sql`insert into extracts (id, org_id, workspace_id, user_id, storage_prefix, retention_hours, paid_retention, expires_at)
      values (${id}, 'o', 'w', 'u', ${`extracts/o/${id}`}, 720, true, now() + interval '30 days')`;
    const runId = await seedRun({ id, storagePrefix: `extracts/o/${id}` });
    await extracts.sweepExtracts();
    await extracts.sweepExtracts();

    const events = await sql<{ id: string; metric: string; cost_cents: number; run_id: string; org_id: string; workspace_id: string; metadata: Record<string, unknown> }[]>`
      select id, metric, cost_cents::float8 as cost_cents, run_id, org_id, workspace_id, metadata from usage_events where metric = 'storage-extract-retention'`;
    const bytes = 2 * MB + 10 * (96 + 28) * 1024;
    const expected = (bytes / 1024 ** 3) * 25 * 2;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: `extract-retention:${id}:settle`, run_id: runId, org_id: "o", workspace_id: "w" });
    expect(events[0]!.cost_cents).toBeCloseTo(expected, 6);
    expect(events[0]!.metadata).toMatchObject({ product: "extract", extractId: id, phase: "settle", multiplier: 2, billable: true });
    const [row] = await sql<{ retention_credits: number }[]>`select retention_credits::float8 as retention_credits from extracts where id = ${id}`;
    expect(row!.retention_credits).toBeCloseTo(expected, 6);

    // The extract's spend is reported on its own.
    const { extractUsageTotals } = await import("../services/usage-attribution.js");
    const usage = await extractUsageTotals("o", null, sql as never);
    expect(usage).toMatchObject({ extracts: 1, pages: 10 });
    expect(usage.retentionCents).toBeCloseTo(expected, 6);
    expect(usage.pagesPerDollar).toBeCloseTo(10 / (expected / 100), 3);
  });

  it("deletes an expired extract: in-flight run cancelled first, rows deleted after the grace, prefix emptied, idempotently", async () => {
    const extract = await newExtract();
    const runId = await seedRun(extract, "processing");
    // A workspace export that included the extract's document is withdrawn too, and one still being built is stopped.
    await sql`insert into document_exports (id, org_id, workspace_id, user_id, content, filename, object_key, status, document_ids, expires_at)
      values ('exp_ws', 'o', 'w', 'u', 'markdown', 'Inbox.zip', 'exports/o/w/exp_ws/a1.zip', 'ready', ${sql.array([`${runId}-d1`])}, now() + interval '7 days'),
             ('exp_building', 'o', 'w', 'u', 'markdown', 'Inbox.zip', 'exports/o/w/exp_building/', 'running', '{}', now() + interval '7 days')`;
    // Another tenant's objects next door are never touched.
    mocks.objects.set("extracts/o2/ext_other/raw/x.pdf", 10);
    await sql`update extracts set expires_at = now() - interval '5 minutes' where id = ${extract.id}`;

    // Pass 1: the run is in flight. Cancel it and wait; nothing is deleted yet, so late writes are not orphaned.
    await extracts.sweepExtracts();
    expect(mocks.cancel).toHaveBeenCalledWith(runId);
    expect((await sql`select id from documents where run_id = ${runId}`).length).toBe(1);
    expect(mocks.purged).toEqual([]);
    const [waiting] = await sql<{ state: string; due: boolean }[]>`select state, purge_after <= now() as due from extracts where id = ${extract.id}`;
    expect(waiting).toEqual({ state: "deleting", due: false });

    // Pass 2, after the grace: rows go (their triggers queue cleanup), then the prefix.
    await sql`update extracts set purge_after = now() - interval '1 second' where id = ${extract.id}`;
    const result = await extracts.sweepExtracts();
    expect((await sql`select id from documents where run_id = ${runId}`).length).toBe(0);
    expect((await sql`select id from workspace_runs where id = ${runId}`).length).toBe(0);
    expect((await sql`select id, status from document_exports order by id`)).toEqual([{ id: "exp_building", status: "failed" }]);
    expect(mocks.deleted).toEqual(["exports/o/w/exp_ws/a1.zip"]);
    expect((await sql`select document_id from document_cleanup_queue`).map((row) => row.document_id)).toEqual([`${runId}-d1`]);
    expect((await sql`select target from storage_cleanup_queue where kind = 'storage_prefix'`).map((row) => row.target)).toEqual([`u/${runId}/`]);
    expect(mocks.purged.every((prefix) => prefix === `${extract.storagePrefix}/`)).toBe(true);
    expect([...mocks.objects.keys()]).toEqual(["extracts/o2/ext_other/raw/x.pdf"]);
    expect(result).toMatchObject({ deleted: 1, deletedObjects: 4, deletedBytes: 2 * MB + 1700 });
    expect(result.maxLagSeconds).toBeGreaterThanOrEqual(300);
    const [done] = await sql<{ state: string; deleted_objects: string; deleted_bytes: string; deleted_at: Date | null; relist: boolean }[]>`
      select state, deleted_objects::text, deleted_bytes::text, deleted_at, relist_after > now() as relist from extracts where id = ${extract.id}`;
    expect(done).toMatchObject({ state: "deleted", deleted_objects: "4", deleted_bytes: String(2 * MB + 1700), relist: true });

    // Idempotent: nothing more to do, and the record stays as a tombstone that reads as expired.
    mocks.purged.length = 0;
    expect(await extracts.sweepExtracts()).toMatchObject({ deleted: 0, deletedObjects: 0 });
    expect(mocks.purged).toEqual([]);
    expect(extracts.describeExtract((await extracts.getExtractForActor(extract.id, owner))!).status).toBe("expired");

    // Hours later the prefix is listed once more and a late write is removed.
    mocks.objects.set(`${extract.storagePrefix}/raw/late.pdf`, 7);
    await sql`update extracts set relist_after = now() - interval '1 second' where id = ${extract.id}`;
    expect(await extracts.sweepExtracts()).toMatchObject({ deletedObjects: 1 });
    expect(mocks.objects.has(`${extract.storagePrefix}/raw/late.pdf`)).toBe(false);
    expect((await sql`select relist_after from extracts where id = ${extract.id}`)[0]!.relist_after).toBeNull();
  });

  it("deletes copies made from extract documents and audio receipts without stalling other extracts", async () => {
    const audio = await newExtract();
    const runId = await seedRun(audio);
    // An audio extract's media receipts and admissions point at its run and document (migrations 0048/0050).
    await sql`insert into remote_media_jobs (id, request_key, org_id, workspace_id, run_id, document_id, provider, model, status, reserve_cents)
      values ('rmj-1', 'rk-1', 'o', 'w', ${runId}, ${`${runId}-d1`}, 'provider', 'model', 'completed', 1)`;
    await sql`insert into media_video_admissions (document_id, org_id, run_id, duration_seconds, reserved_frames) values (${`${runId}-d1`}, 'o', ${runId}, 60, 10)`;
    // A copy outside the extract run (a re-index from before the guard), chained by reindex_of.
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('kept-run', 'o', 'u', 'w', 'reindex', 'completed', 'completed', '{}')`;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, previous_version_id, reindex_of)
      values ('copy-1', 'o', 'u', 'w', 'kept-run', 'Report.pdf', 'application/pdf', 'u/kept-run/raw/r.pdf', 'completed', 10, ${`${runId}-d1`}, ${`${runId}-d1`})`;
    const second = await newExtract();
    await seedRun(second);
    await sql`update extracts set expires_at = now() - interval '1 minute'`;

    const result = await extracts.sweepExtracts();
    expect(result).toMatchObject({ deleted: 2, failed: 0 });
    expect((await sql`select id from documents`).length).toBe(0);
    // The receipt survives as an accounting record, detached from the deleted run and document.
    expect(await sql`select run_id, document_id from remote_media_jobs where id = 'rmj-1'`).toEqual([{ run_id: null, document_id: null }]);
    expect((await sql`select 1 from media_video_admissions`).length).toBe(0);
  });

  it("backs off a failing extract and still deletes the others", async () => {
    const poisoned = await newExtract();
    await seedRun(poisoned);
    const healthy = await newExtract();
    await seedRun(healthy);
    await sql`update extracts set expires_at = now() - interval '1 minute'`;
    await sql`update extracts set expires_at = now() - interval '2 minutes' where id = ${poisoned.id}`;
    const storage = await import("../lib/storage.js");
    vi.mocked(storage.deleteObjectsUnderPrefix).mockImplementationOnce(async () => ({ objects: 0, bytes: 0, failed: 2, done: false }));
    const first = await extracts.sweepExtracts();
    expect(first).toMatchObject({ deleted: 1, failed: 1 });
    const [state] = await sql<{ state: string; last_error: string; backoff: boolean; failed_objects: string }[]>`
      select state, last_error, lease_expires_at > now() + interval '1 minute' as backoff, failed_objects::text from extracts where id = ${poisoned.id}`;
    expect(state).toMatchObject({ state: "deleting", backoff: true, failed_objects: "2" });
    expect(state!.last_error).toMatch(/refused to delete 2/);
    expect((await sql<{ state: string }[]>`select state from extracts where id = ${healthy.id}`)[0]!.state).toBe("deleted");
  });

  it("charges a paid window at admission, tops it up at settle, and charges an unsettled one at expiry", async () => {
    process.env.DOCSLURP_BILL_STORAGE = "true";
    const paid = "ext_" + "b".repeat(32);
    await sql`insert into extracts (id, org_id, workspace_id, user_id, storage_prefix, retention_hours, paid_retention, expires_at)
      values (${paid}, 'o', 'w', 'u', ${`extracts/o/${paid}`}, 720, true, now() + interval '30 days')`;
    const runId = await seedRun({ id: paid, storagePrefix: `extracts/o/${paid}` });
    const perPage = (96 + 28) * 1024;
    const credits = (bytes: number) => (bytes / 1024 ** 3) * 25 * 2;
    expect(await extracts.chargeExtractRetention(paid, "admission")).toBeCloseTo(credits(2 * MB + 10 * perPage), 6);
    // More pages turned up while processing: settle charges only the difference, once.
    await sql`update documents set page_count = 20 where run_id = ${runId}`;
    await extracts.sweepExtracts();
    await extracts.sweepExtracts();
    const events = await sql<{ id: string; cost_cents: number }[]>`select id, cost_cents::float8 as cost_cents from usage_events where metric = 'storage-extract-retention' and id like ${`extract-retention:${paid}%`} order by id`;
    expect(events.map((event) => event.id)).toEqual([`extract-retention:${paid}`, `extract-retention:${paid}:settle`]);
    expect(events[1]!.cost_cents).toBeCloseTo(credits(10 * perPage), 6);

    // A paid extract whose run never finished pays at expiry, before its rows go.
    const paused = "ext_" + "c".repeat(32);
    await sql`insert into extracts (id, org_id, workspace_id, user_id, storage_prefix, retention_hours, paid_retention, expires_at)
      values (${paused}, 'o', 'w', 'u', ${`extracts/o/${paused}`}, 720, true, now() - interval '1 minute')`;
    const pausedRun = await seedRun({ id: paused, storagePrefix: `extracts/o/${paused}` }, "completed");
    await sql`update workspace_runs set status = 'failed', stage = 'failed' where id = ${pausedRun}`;
    await extracts.sweepExtracts();
    expect((await sql`select id from usage_events where id = ${`extract-retention:${paused}:expiry`}`).length).toBe(1);
  });

  it("leaves live extract documents off the daily storage meter, by the workspace's org", async () => {
    const extract = await newExtract();
    await seedRun(extract);
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('kept', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}')`;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, file_size, page_count)
      values ('kept-1', 'o', 'u', 'w', 'kept', 'Kept.pdf', 'application/pdf', 'u/kept/raw/k.pdf', 'completed', ${3 * MB}, 4)`;
    const { getOrgStorage } = await import("../services/billing/overview.js");
    expect(await getOrgStorage("o", sql as never)).toMatchObject({ sourceBytes: 5 * MB, pages: 14 });
    expect(await getOrgStorage("o", sql as never, { excludeExtracts: true })).toMatchObject({ sourceBytes: 3 * MB, pages: 4 });
    // Another org's meter never subtracts this org's extracts.
    expect(await getOrgStorage("o2", sql as never, { excludeExtracts: true })).toMatchObject({ sourceBytes: 0, pages: 0 });
  });

  it("removes chat evidence spans quoting an extract's documents, and keeps the chat turn", async () => {
    const extract = await newExtract();
    const runId = await seedRun(extract);
    await sql`insert into chat_sessions (id, workspace_id, user_id) values ('chat-1', 'w', 'u')`;
    await sql`insert into chat_turns (id, session_id, role, content) values ('turn-1', 'chat-1', 'user', 'what does the report say?')`;
    await sql`insert into chat_answer_evidence_spans (id, answer_id, session_id, user_id, workspace_id, citation_index, answer_start, answer_end, answer_text, source_text, source_start, source_end, citation)
      values ('span-x', 'a1', 'chat-1', 'u', 'w', 1, 0, 5, 'It is', 'CONFIDENTIAL extract text', 0, 25, ${sql.json({ documentId: `${runId}-d1` })}),
             ('span-kept', 'a1', 'chat-1', 'u', 'w', 2, 0, 5, 'It is', 'kept document text', 0, 18, ${sql.json({ documentId: "kept-doc" })})`;
    await sql`update extracts set expires_at = now() - interval '1 minute' where id = ${extract.id}`;
    await extracts.sweepExtracts();
    expect((await sql`select id from chat_answer_evidence_spans order by id`).map((row) => row.id)).toEqual(["span-kept"]);
    expect((await sql`select id from chat_turns`).length).toBe(1);
    await sql`delete from chat_sessions`;
  });

  it("never creates a run for an expired or deleted extract", async () => {
    const extract = await newExtract();
    await sql`update extracts set state = 'deleted', expires_at = now() - interval '1 hour' where id = ${extract.id}`;
    vi.stubEnv("NODE_ENV", "development");
    try {
      const { createRunCreation } = await import("../services/run-creation.js");
      const creation = createRunCreation({ sql: sql as never, start: async () => ({ status: "started" }) as never });
      await expect(creation.create({
        userId: "u", workspaceId: "w", kind: "direct-upload", pipeline: {} as never, extract,
        sources: { kind: "files", files: [{ filename: "r.pdf", mimeType: "application/pdf", sourceKey: `${extract.storagePrefix}/raw/r.pdf` }] },
      })).rejects.toMatchObject({ status: 410, code: "extract_expired" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await sql`select id from workspace_runs where extract_id = ${extract.id}`).length).toBe(0);
  });

  it("refuses to reprocess an extract run or its documents with 409, single and bulk", async () => {
    const extract = await newExtract();
    const runId = await seedRun(extract);
    const { reprocessRun } = await import("../services/runs.js");
    await expect(reprocessRun(runId, "u")).rejects.toMatchObject({ statusCode: 409, code: "extract_not_reprocessable" });
    const { bulkReprocessDocuments } = await import("../services/documents.js");
    await expect(bulkReprocessDocuments([`${runId}-d1`], "u")).rejects.toMatchObject({ statusCode: 409, code: "extract_not_reprocessable" });
    expect((await sql`select id from workspace_runs`).map((row) => row.id)).toEqual([runId]);
  });

  it("resumes a deletion that failed part-way", async () => {
    const extract = await newExtract();
    await seedRun(extract);
    await sql`update extracts set expires_at = now() - interval '1 minute' where id = ${extract.id}`;
    const storage = await import("../lib/storage.js");
    vi.mocked(storage.deleteObjectsUnderPrefix).mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await extracts.sweepExtracts()).toMatchObject({ failed: 1, deleted: 0 });
    const [failed] = await sql<{ state: string; last_error: string }[]>`select state, last_error from extracts where id = ${extract.id}`;
    expect(failed).toEqual({ state: "deleting", last_error: "storage unavailable" });
    // The rows still went even though the objects could not.
    expect((await sql`select 1 from documents where source_key like ${`${extract.storagePrefix}/%`}`).length).toBe(0);
    await sql`update extracts set lease_expires_at = null where id = ${extract.id}`;
    expect(await extracts.sweepExtracts()).toMatchObject({ deleted: 1, failed: 0 });
    expect([...mocks.objects.keys()].filter((name) => name.startsWith(extract.storagePrefix))).toEqual([]);
  });

  it("expires an extract whose intake created nothing, so its prefix is emptied", async () => {
    const extract = await newExtract();
    mocks.objects.set(`${extract.storagePrefix}/raw/half-written.pdf`, 5);
    await extracts.abandonExtract(extract.id);
    await extracts.sweepExtracts();
    expect(mocks.objects.size).toBe(0);
    expect((await sql<{ state: string }[]>`select state from extracts where id = ${extract.id}`)[0]!.state).toBe("deleted");
  });
});
