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
vi.mock("../config.js", async (original) => ({ ...await original<typeof import("../config.js")>(), env: { ...(await original<typeof import("../config.js")>()).env, s3Bucket: "bucket" } }));
vi.mock("../services/notifications.js", () => ({ sendExportReadyEmail: mocks.email }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let exportsService: typeof import("../services/document-exports.js");
let documents: typeof import("../services/documents.js");

const MB = 1024 * 1024;

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
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, file_size, stored_page_text_bytes)
    values ('small', 'o', 'u', 'w', 'r', 'Plan.pdf', 'application/pdf', 'k1', 'completed', ${2 * MB}, ${100 * 1024}),
           ('big', 'o', 'u', 'w', 'r', 'Scan.pdf', 'application/pdf', 'k2', 'completed', ${400 * MB}, 1000),
           ('huge', 'o', 'u', 'w', 'r', 'Video.mp4', 'video/mp4', 'k3', 'completed', ${4 * 1024 * MB}, 0)`;
  exportsService = await import("../services/document-exports.js");
  documents = await import("../services/documents.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await sql`delete from document_exports`;
});

const doc = (id: string, filename: string) => ({ id, filename, workspaceId: "w", orgId: "o" });

describe("document exports", () => {
  it("queues a small export for download now, with a 7-day link, under exports/<org>/<workspace>/", async () => {
    const exported = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });

    expect(exported).toMatchObject({ status: "queued", filename: "Plan.zip", documentCount: 1, notifyEmail: false, downloadUrl: null });
    const days = (new Date(exported.expiresAt).getTime() - new Date(exported.createdAt).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
    expect(mocks.startWorkflow).toHaveBeenCalledWith({ exportId: exported.id });
    const [row] = await sql<{ object_key: string }[]>`select object_key from document_exports where id = ${exported.id}`;
    expect(row!.object_key).toBe(`exports/o/w/${exported.id}.zip`);
  });

  it("emails exports estimated over 250 MB and refuses ones over the limit", async () => {
    const big = await exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("big", "Scan.pdf") });
    expect(big.notifyEmail).toBe(true);
    expect(big.estimatedBytes).toBeGreaterThan(250 * MB);
    // The same document as Markdown only is small.
    expect((await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("big", "Scan.pdf") })).notifyEmail).toBe(false);

    await expect(exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("huge", "Video.mp4") }))
      .rejects.toMatchObject({ status: 413, code: "payload_too_large" });
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "all", workspace: { id: "w", name: "Finance / Q3", orgId: "o" } }))
      .rejects.toMatchObject({ status: 413 });
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "markdown", workspace: { id: "empty", name: "Empty", orgId: "o" } }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("names workspace exports safely and limits exports in flight per user", async () => {
    const first = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", workspace: { id: "w", name: "Finance / Q3", orgId: "o" } });
    expect(first.filename).toBe("Finance - Q3.zip");
    await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });
    await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") }))
      .rejects.toMatchObject({ status: 429 });
  });

  it("marks the export failed when the worker cannot be reached", async () => {
    mocks.startWorkflow.mockRejectedValueOnce(new Error("temporal down"));
    await expect(exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") })).rejects.toThrow("temporal down");
    expect(await sql`select status from document_exports`).toEqual([{ status: "failed" }]);
  });

  it("signs short storage links only for the requester's ready, unexpired exports", async () => {
    const exported = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });
    const key = `exports/o/w/${exported.id}.zip`;
    expect(await exportsService.signDocumentExportDownload(exported.id, "u")).toBeNull();

    await sql`update document_exports set status = 'ready', size_bytes = 1234 where id = ${exported.id}`;
    expect((await exportsService.getDocumentExport(exported.id, "u"))?.downloadUrl).toBe(`/v1/exports/${exported.id}/download`);
    expect(await exportsService.signDocumentExportDownload(exported.id, "u")).toBe(`https://storage.test/${key}?X-Amz-Expires=120`);
    expect(mocks.sign).toHaveBeenCalledWith({ key, filename: "Plan.zip", expiresInSeconds: 120 });
    expect(await exportsService.getDocumentExport(exported.id, "stranger")).toBeNull();
    expect(await exportsService.signDocumentExportDownload(exported.id, "stranger")).toBeNull();
    // Exports are never readable through the file proxy.
    expect(await documents.userCanAccessArtifactUri(`s3://bucket/${key}`, "u")).toBe(false);

    await sql`update document_exports set expires_at = now() - interval '1 second' where id = ${exported.id}`;
    expect(await exportsService.getDocumentExport(exported.id, "u")).toMatchObject({ status: "expired", downloadUrl: null });
    expect(await exportsService.signDocumentExportDownload(exported.id, "u")).toBeNull();
  });

  it("sweeps: emails finished large exports once, retries failed emails, and deletes expired objects", async () => {
    const big = await exportsService.requestDocumentExport({ userId: "u", content: "all", document: doc("big", "Scan.pdf") });
    const small = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("small", "Plan.pdf") });
    await sql`update document_exports set status = 'ready', size_bytes = ${300 * MB}`;

    mocks.email.mockRejectedValueOnce(new Error("resend down"));
    await exportsService.sweepDocumentExports();
    expect(mocks.email).toHaveBeenCalledTimes(1);
    expect((await sql`select emailed_at from document_exports where id = ${big.id}`)[0]).toEqual({ emailed_at: null });

    await exportsService.sweepDocumentExports();
    await exportsService.sweepDocumentExports();
    expect(mocks.email).toHaveBeenCalledTimes(2);
    expect(mocks.email).toHaveBeenLastCalledWith(expect.objectContaining({
      recipientEmail: "export@example.test", filename: "Scan.zip", ready: true, sizeLabel: "300 MB",
      url: expect.stringContaining(`/app?export=${big.id}`),
    }));

    await sql`update document_exports set expires_at = now() - interval '1 second' where id = ${small.id}`;
    mocks.deleteObject.mockRejectedValueOnce(new Error("storage down"));
    await exportsService.sweepDocumentExports();
    expect((await sql`select status from document_exports where id = ${small.id}`)[0]).toEqual({ status: "ready" });
    await exportsService.sweepDocumentExports();
    expect(mocks.deleteObject).toHaveBeenLastCalledWith(`exports/o/w/${small.id}.zip`);
    expect((await sql`select status from document_exports where id = ${small.id}`)[0]).toEqual({ status: "expired" });
    expect((await sql`select status from document_exports where id = ${big.id}`)[0]).toEqual({ status: "ready" });
  });

  it("removes the object and the row when the exported document or workspace is deleted", async () => {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values ('gone', 'o', 'u', 'w', 'r', 'Gone.pdf', 'application/pdf', 'k-gone', 'completed')`;
    const exported = await exportsService.requestDocumentExport({ userId: "u", content: "markdown", document: doc("gone", "Gone.pdf") });
    await sql`update document_exports set status = 'ready' where id = ${exported.id}`;
    await sql`delete from documents where id = 'gone'`;

    await exportsService.sweepDocumentExports();

    expect(mocks.deleteObject).toHaveBeenCalledWith(`exports/o/w/${exported.id}.zip`);
    expect(await sql`select id from document_exports where id = ${exported.id}`).toEqual([]);
  });

  it("treats a deleted (tombstoned) requester's exports as orphans and never emails them", async () => {
    await sql`insert into "user" (id, name, email) values ('leaver', 'Leaver', 'leaver@example.test')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'leaver', 'owner')`;
    const exported = await exportsService.requestDocumentExport({ userId: "leaver", content: "all", document: doc("big", "Scan.pdf") });
    await sql`update document_exports set status = 'ready' where id = ${exported.id}`;
    await sql`update "user" set deleted_at = now(), email = 'deleted-leaver@deleted.invalid' where id = 'leaver'`;

    await exportsService.sweepDocumentExports();

    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.deleteObject).toHaveBeenCalledWith(`exports/o/w/${exported.id}.zip`);
    expect(await sql`select id from document_exports where id = ${exported.id}`).toEqual([]);
  });
});
