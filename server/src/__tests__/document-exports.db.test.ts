import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

const mocks = vi.hoisted(() => ({
  startWorkflow: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
  sign: vi.fn(async ({ key, expiresInSeconds }: { key: string; expiresInSeconds?: number }) => `https://storage.test/${key}?X-Amz-Expires=${expiresInSeconds}`),
  email: vi.fn(async () => undefined),
}));
vi.mock("../lib/temporal.js", () => ({ startDocumentExportWorkflow: mocks.startWorkflow }));
vi.mock("../lib/storage.js", () => ({ deleteUploadedObject: mocks.deleteObject, signDownloadGet: mocks.sign }));
vi.mock("../services/notifications.js", () => ({ sendExportReadyEmail: mocks.email }));
vi.mock("../config.js", async (original) => ({ ...await original<typeof import("../config.js")>(), env: { ...(await original<typeof import("../config.js")>()).env, s3Bucket: "bucket" } }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let exportsService: typeof import("../services/document-exports.js");
let documents: typeof import("../services/documents.js");

const MB = 1024 * 1024;
const DOC_COLUMNS = "id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, file_size, stored_page_text_bytes";

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'export@example.test'), ('stranger', 'S', 's@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'exports', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Finance / Q3'), ('empty', 'o', 'u', 'Empty')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts)
    values ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}', '{"small:page-1":"s3://b/p1.png","small:page-2":"s3://b/p2.png"}')`;
  await sql.unsafe(`insert into documents (${DOC_COLUMNS}) values
    ('small', 'o', 'u', 'w', 'r', 'Plan.pdf', 'application/pdf', 'k1', 'completed', ${2 * MB}, ${100 * 1024}),
    ('big', 'o', 'u', 'w', 'r', 'Scan.pdf', 'application/pdf', 'k2', 'completed', ${400 * MB}, 1000),
    ('huge', 'o', 'u', 'w', 'r', 'Video.mp4', 'video/mp4', 'k3', 'completed', ${4 * 1024 * MB}, 0),
    ('pending', 'o', 'u', 'w', 'r', 'Draft.pdf', 'application/pdf', 'k4', 'processing', 0, 0)`);
  exportsService = await import("../services/document-exports.js");
  documents = await import("../services/documents.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await sql`delete from document_exports`;
});

const doc = (id: string, filename: string, status = "completed") => ({ id, filename, workspaceId: "w", orgId: "o", status });
const finance = { id: "w", name: "Finance / Q3", orgId: "o" };
/** The hourly orphan scan runs when the sweep's clock has moved an hour on. */
let clock = Date.now();
const sweep = (orphanScan = false) => exportsService.sweepDocumentExports(orphanScan ? (clock += 2 * 3_600_000) : clock);
/** What the worker writes when an attempt finishes. */
const markReady = (id: string, extra: { sizeBytes?: number; documentIds?: string[] } = {}) => sql`
  update document_exports set status = 'ready', completed_at = now(), object_key = object_key || 'a1.zip',
    expires_at = now() + interval '7 days', size_bytes = ${extra.sizeBytes ?? 1234}, document_ids = ${sql.array(extra.documentIds ?? [])}
  where id = ${id}`;

describe("document exports", () => {
  it("queues a small export under exports/<org>/<workspace>/<export>/ on the small queue", async () => {
    const exported = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });

    expect(exported).toMatchObject({ status: "queued", filename: "Plan.zip", documentCount: 1, notifyEmail: false, downloadUrl: null });
    expect(mocks.startWorkflow).toHaveBeenCalledWith({ exportId: exported.id }, { large: false });
    const [row] = await sql<{ object_key: string; hours: number }[]>`
      select object_key, round(extract(epoch from expires_at - created_at) / 3600)::int as hours from document_exports where id = ${exported.id}`;
    expect(row!.object_key).toBe(`exports/o/w/${exported.id}/`);
    // An upper bound (7 days + the 10-hour build budget) until the worker starts the 7 days at ready.
    expect(row!.hours).toBe(7 * 24 + 10);
  });

  it("emails exports estimated over 250 MB on the large queue, and refuses ones over the limit", async () => {
    const big = await exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("big", "Scan.pdf") });
    expect(big.notifyEmail).toBe(true);
    expect(big.estimatedBytes).toBeGreaterThan(250 * MB);
    expect(mocks.startWorkflow).toHaveBeenLastCalledWith({ exportId: big.id }, { large: true });
    expect((await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("big", "Scan.pdf") })).notifyEmail).toBe(false);

    await expect(exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("huge", "Video.mp4") }))
      .rejects.toMatchObject({ status: 413, code: "payload_too_large" });
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "all", workspace: finance }))
      .rejects.toMatchObject({ status: 413 });
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "markdown", workspace: { id: "empty", name: "Empty", orgId: "o" } }))
      .rejects.toMatchObject({ status: 404 });
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("pending", "Draft.pdf", "processing") }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("still processing") });
  });

  it("reuses the same export asked for twice, and limits exports in flight and per day", async () => {
    const first = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", workspace: finance });
    expect(first.filename).toBe("Finance - Q3.zip");
    const again = await Promise.all([1, 2, 3].map(() => exportsService.requestDocumentExport({ userId: "u", content: "markdown", workspace: finance })));
    expect(new Set(again.map((entry) => entry.id))).toEqual(new Set([first.id]));
    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);

    await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });
    await exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("small", "Plan.pdf") });
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("big", "Scan.pdf") }))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining("in progress") });

    await sql`update document_exports set status = 'ready'`;
    await sql`insert into document_exports (id, org_id, workspace_id, user_id, content, filename, object_key, status, expires_at)
      select 'old-' || n, 'o', 'w', 'u', 'markdown', 'x.zip', 'exports/o/w/old/', 'ready', now() + interval '1 day' from generate_series(1, 17) as n`;
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("big", "Scan.pdf") }))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining("today's export limit") });
  });

  it("marks the export failed, without an email, when the worker cannot be reached", async () => {
    mocks.startWorkflow.mockRejectedValueOnce(new Error("temporal down"));
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("big", "Scan.pdf") })).rejects.toThrow("temporal down");
    expect(await sql`select status, notify_email from document_exports`).toEqual([{ status: "failed", notify_email: false }]);
  });

  it("signs two-minute storage links only for the requester's ready, unexpired exports whose documents still exist", async () => {
    const exported = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });
    const key = `exports/o/w/${exported.id}/a1.zip`;
    expect(await exportsService.signDocumentExportDownload(exported.id, "u")).toBeNull();

    await markReady(exported.id, { documentIds: ["small"] });
    expect((await exportsService.getDocumentExport(exported.id, "u"))?.downloadUrl).toBe(`/v1/exports/${exported.id}/download`);
    expect(await exportsService.signDocumentExportDownload(exported.id, "u")).toBe(`https://storage.test/${key}?X-Amz-Expires=120`);
    expect(mocks.sign).toHaveBeenCalledWith({ key, filename: "Plan.zip", expiresInSeconds: 120 });
    expect(await exportsService.getDocumentExport(exported.id, "stranger")).toBeNull();
    expect(await exportsService.signDocumentExportDownload(exported.id, "stranger")).toBeNull();
    // Exports are never readable through the file proxy.
    expect(await documents.userCanAccessArtifactUri(`s3://bucket/${key}`, "u")).toBe(false);

    // A purged document withdraws the export at once, before any sweep.
    await sql`update documents set purged_at = now() where id = 'small'`;
    expect(await exportsService.signDocumentExportDownload(exported.id, "u")).toBeNull();
    await sql`update documents set purged_at = null where id = 'small'`;

    await sql`update document_exports set expires_at = now() - interval '1 second' where id = ${exported.id}`;
    expect(await exportsService.getDocumentExport(exported.id, "u")).toMatchObject({ status: "expired", downloadUrl: null });
    expect(await exportsService.signDocumentExportDownload(exported.id, "u")).toBeNull();
  });

  it("emails finished large exports once, backs off and gives up on failures, and deletes expired objects", async () => {
    const big = await exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("big", "Scan.pdf") });
    const small = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });
    await markReady(big.id, { sizeBytes: 300 * MB });
    await markReady(small.id);

    mocks.email.mockRejectedValueOnce(new Error("resend down"));
    await sweep();
    expect(mocks.email).toHaveBeenCalledTimes(1);
    const [backoff] = await sql<{ emailed_at: Date | null; waiting: boolean }[]>`
      select emailed_at, next_email_at > now() as waiting from document_exports where id = ${big.id}`;
    expect(backoff).toEqual({ emailed_at: null, waiting: true });
    await sweep();
    expect(mocks.email).toHaveBeenCalledTimes(1);

    await sql`update document_exports set next_email_at = now() where id = ${big.id}`;
    await sweep();
    await sweep();
    expect(mocks.email).toHaveBeenCalledTimes(2);
    expect(mocks.email).toHaveBeenLastCalledWith(expect.objectContaining({
      recipientEmail: "export@example.test", filename: "Scan.zip", ready: true, sizeLabel: "300 MB",
      url: expect.stringContaining(`/app?export=${big.id}`),
    }));

    await sql`update document_exports set expires_at = now() - interval '1 second' where id = ${small.id}`;
    mocks.deleteObject.mockRejectedValueOnce(new Error("storage down"));
    await sweep();
    expect((await sql`select status from document_exports where id = ${small.id}`)[0]).toEqual({ status: "ready" });
    await sweep();
    expect(mocks.deleteObject).toHaveBeenLastCalledWith(`exports/o/w/${small.id}/a1.zip`);
    expect((await sql`select status from document_exports where id = ${small.id}`)[0]).toEqual({ status: "expired" });
    expect((await sql`select status from document_exports where id = ${big.id}`)[0]).toEqual({ status: "ready" });
  });

  it("stops retrying an email after five failures", async () => {
    const big = await exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("big", "Scan.pdf") });
    await markReady(big.id);
    mocks.email.mockRejectedValue(new Error("rejected"));
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await sql`update document_exports set next_email_at = now() where id = ${big.id}`;
      await sweep();
    }
    expect(mocks.email).toHaveBeenCalledTimes(5);
    mocks.email.mockReset();
  });

  it("withdraws a workspace export when a document in it is deleted", async () => {
    await sql.unsafe(`insert into documents (${DOC_COLUMNS}) values ('gone', 'o', 'u', 'w', 'r', 'Gone.pdf', 'application/pdf', 'k-gone', 'completed', 10, 10)`);
    const exported = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", workspace: finance });
    await markReady(exported.id, { documentIds: ["small", "gone"] });
    await sql`delete from documents where id = 'gone'`;

    await sweep();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    await sweep(true);

    expect(mocks.deleteObject).toHaveBeenCalledWith(`exports/o/w/${exported.id}/a1.zip`);
    expect(await sql`select id from document_exports where id = ${exported.id}`).toEqual([]);
  });

  it("treats a deleted (tombstoned) requester's exports as orphans and never emails them", async () => {
    await sql`insert into "user" (id, name, email) values ('leaver', 'Leaver', 'leaver@example.test')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'leaver', 'owner')`;
    const exported = await exportsService.requestDocumentExport({ userId: "leaver", content: "all", document: doc("big", "Scan.pdf") });
    await markReady(exported.id);
    await sql`update "user" set deleted_at = now(), email = 'deleted-leaver@deleted.invalid' where id = 'leaver'`;

    await sweep(true);

    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.deleteObject).toHaveBeenCalledWith(`exports/o/w/${exported.id}/a1.zip`);
    expect(await sql`select id from document_exports where id = ${exported.id}`).toEqual([]);
  });

  it("does not email someone removed from the workspace since asking", async () => {
    await sql`insert into "user" (id, name, email) values ('removed', 'Removed', 'removed@example.test')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'removed', 'owner')`;
    const exported = await exportsService.requestDocumentExport({ userId: "removed", content: "all", document: doc("big", "Scan.pdf") });
    await markReady(exported.id);
    await sql`delete from org_memberships where user_id = 'removed'`;

    await sweep();

    expect(mocks.email).not.toHaveBeenCalled();
  });
});
