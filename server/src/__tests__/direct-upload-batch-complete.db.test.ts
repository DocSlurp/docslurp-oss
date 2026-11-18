import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase } from "@docslurp/worker/testing";

// Batched files/complete and the reconciler hold, against a database built from the full migration journal.
// Only the SQL transport, the lock connection and object storage are replaced; ownership, sealing and the
// reconciler's selection run their production queries.
type StoredObject = { size: number; etag: string };
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  lockHeld: false,
  objects: new Map<string, { size: number; etag: string }>(),
  /** Keys whose bytes are replaced between the HEAD that verified them and the sealing copy. */
  replacedBeforeCopy: new Set<string>(),
  copies: [] as Array<{ fromKey: string; toKey: string; ifMatch?: string }>,
  heads: [] as string[],
  confirm: vi.fn(),
}));
vi.mock("../db.js", () => ({ sql: Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, "");
    return { then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      mocks.query(text, values).then((result: { rows: unknown[] }) => result.rows).then(resolve, reject) };
  }, { json: (value: unknown) => JSON.stringify(value), array: (value: unknown) => value }) }));
vi.mock("../lib/direct-upload-locks.js", () => ({ reserveDirectUploadLockConnection: async () => ({
  connection: async (strings: TemplateStringsArray) => strings.join("").includes("pg_try_advisory_lock") ? [{ acquired: !mocks.lockHeld }] : [],
  release: () => {},
}) }));
vi.mock("../lib/storage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/storage.js")>(),
  getUploadedObjectMetadata: async (key: string) => {
    mocks.heads.push(key);
    const object = mocks.objects.get(key);
    if (!object) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return { contentLength: object.size, etag: object.etag };
  },
  copyUploadedObject: async (input: { fromKey: string; toKey: string; ifMatch?: string }) => {
    mocks.copies.push(input);
    if (mocks.replacedBeforeCopy.has(input.fromKey)) mocks.objects.set(input.fromKey, { ...mocks.objects.get(input.fromKey)!, etag: "\"replaced\"" });
    const source = mocks.objects.get(input.fromKey);
    if (!source || (input.ifMatch && source.etag !== input.ifMatch)) throw Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    mocks.objects.set(input.toKey, { ...source });
    return { etag: source.etag };
  },
  deleteUploadedObject: async (key: string) => { mocks.objects.delete(key); },
  abortMultipartUpload: async () => {},
}));
vi.mock("../services/project-intake-actions.js", () => ({ confirmDirectUploadProjectIntake: mocks.confirm }));

const { completeDirectUploadFiles, completeDirectUploadFile, CLIENT_FINALIZING_HOLD_SECONDS } = await import("../services/direct-upload-session.js");
const { reconcileDirectUploads } = await import("../services/direct-upload-reconciler.js");

const SESSION = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;

async function seedFile(sessionId: string, id: string, object?: StoredObject | null, declared = 10) {
  const key = `u/${sessionId}/raw/${id}-doc.pdf`;
  await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, status)
    values ($1, $2, 'doc.pdf', 'application/pdf', $3, $4, 'single', 'pending')`, [id, sessionId, declared, key]);
  if (object) mocks.objects.set(key, object);
  return key;
}
async function fileRow(id: string) {
  return (await db.query<{ status: string; source_key: string }>("select status, source_key from upload_session_files where id = $1", [id])).rows[0]!;
}
async function sessionRow(id = SESSION) {
  return (await db.query<{ status: string; held: boolean; due: boolean }>(`select status,
    coalesce(client_finalizing_until > now(), false) as held, next_reconcile_at <= now() as due
    from upload_sessions where id = $1`, [id])).rows[0]!;
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user" (id,name,email) values ('u','Uploader','uploader@example.test'), ('other','Other','other@example.test');
    insert into organizations (id,name,slug,created_by_user_id) values ('o','Org','batch-complete','u'), ('o2','Other org','batch-complete-2','other');
    insert into org_memberships (org_id,user_id,role) values ('o','u','owner'), ('o2','other','owner');
  `);
  mocks.query.mockImplementation((text: string, values: unknown[]) => db.query(text, values));
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  mocks.lockHeld = false;
  mocks.objects.clear();
  mocks.replacedBeforeCopy.clear();
  mocks.copies.length = 0;
  mocks.heads.length = 0;
  mocks.confirm.mockReset().mockResolvedValue({});
  await db.exec(`delete from upload_session_files; delete from upload_sessions; delete from storage_cleanup_queue; delete from upload_cleanup_owners;
    insert into org_memberships (org_id,user_id,role) values ('o','u','owner') on conflict do nothing;`);
  await db.query(`insert into upload_sessions (id,user_id,org_id,status,next_reconcile_at) values ($1,'u','o','pending', now() + interval '1 hour')`, [SESSION]);
  await db.query(`insert into upload_sessions (id,user_id,org_id,status,next_reconcile_at) values ($1,'other','o2','pending', now() + interval '1 hour')`, [FOREIGN]);
});

describe("batched files/complete", () => {
  it("completes the good files and reports each bad one, including a foreign file id, without touching it", async () => {
    await seedFile(SESSION, "good", { size: 10, etag: "\"a\"" });
    await seedFile(SESSION, "missing", null);
    await seedFile(SESSION, "wrong-size", { size: 11, etag: "\"b\"" });
    const replaced = await seedFile(SESSION, "replaced", { size: 10, etag: "\"c\"" });
    mocks.replacedBeforeCopy.add(replaced);
    const foreignKey = await seedFile(FOREIGN, "theirs", { size: 10, etag: "\"d\"" });

    const result = await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: ["good", "missing", "wrong-size", "replaced", "theirs"].map(fileId => ({ fileId })) });

    expect(result.files.map(file => [file.fileId, file.status === "failed" ? file.error.statusCode : "completed"])).toEqual([
      ["good", "completed"], ["missing", 409], ["wrong-size", 400], ["replaced", 409], ["theirs", 404],
    ]);
    expect(result).toMatchObject({ completedCount: 1, failedCount: 4, sessionComplete: false });
    // Only the verified, sealed file is completed, and it now points at the sealed copy.
    expect(await fileRow("good")).toMatchObject({ status: "completed", source_key: expect.stringContaining("/sealed-good-") });
    for (const id of ["missing", "wrong-size", "replaced"]) expect((await fileRow(id)).status).toBe("pending");
    // The object replaced after verification fails its If-Match copy and is never published.
    expect(mocks.copies.find(copy => copy.fromKey === replaced)).toMatchObject({ ifMatch: "\"c\"" });
    // Another user's file is invisible: never read from storage, never changed.
    expect(mocks.heads).not.toContain(foreignKey);
    expect(await fileRow("theirs")).toMatchObject({ status: "pending", source_key: foreignKey });
    // Files remain open, so this client holds the reconciler off the session; nothing is due yet.
    expect(await sessionRow()).toMatchObject({ held: true, due: false });
  });

  it("refuses another user's session as a whole before reading storage", async () => {
    await seedFile(SESSION, "good", { size: 10, etag: "\"a\"" });
    await expect(completeDirectUploadFiles({ sessionId: SESSION, userId: "other", files: [{ fileId: "good" }] })).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.heads).toEqual([]);
    expect((await fileRow("good")).status).toBe("pending");
    expect(await sessionRow()).toMatchObject({ held: false });
  });

  it("refuses the whole batch once the user lost access to the session's organization", async () => {
    await seedFile(SESSION, "good", { size: 10, etag: "\"a\"" });
    await db.exec("delete from org_memberships where org_id = 'o' and user_id = 'u'");
    await expect(completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "good" }] })).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.heads).toEqual([]);
  });

  it("answers a held lock with a retryable busy error and touches nothing", async () => {
    await seedFile(SESSION, "good", { size: 10, etag: "\"a\"" });
    mocks.lockHeld = true;
    mocks.query.mockClear();
    await expect(completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "good" }] })).rejects.toMatchObject({ statusCode: 409, code: "upload_session_busy" });
    expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining("from upload_session_files"), expect.anything());
    expect(mocks.heads).toEqual([]);
  });

  it("keeps the single-file body: the file's own error, nothing completed", async () => {
    const key = await seedFile(SESSION, "replaced", { size: 10, etag: "\"c\"" });
    mocks.replacedBeforeCopy.add(key);
    await expect(completeDirectUploadFile({ sessionId: SESSION, userId: "u", fileId: "replaced" })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("changed while its upload was being completed") });
    expect((await fileRow("replaced")).status).toBe("pending");
  });

  it("makes the session due at once when the last file completes, and clears the hold", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await seedFile(SESSION, "b", { size: 10, etag: "\"b\"" });
    expect((await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "a" }] })).sessionComplete).toBe(false);
    expect(await sessionRow()).toMatchObject({ held: true, due: false });
    // Completing an already completed file again is idempotent.
    const second = await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "a" }, { fileId: "b" }] });
    expect(second).toMatchObject({ completedCount: 2, sessionComplete: true });
    expect(await sessionRow()).toMatchObject({ held: false, due: true });
  });
});

describe("reconciler while a client completes files", () => {
  it("leaves a held session alone, then finishes it once the client stops", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await seedFile(SESSION, "b", { size: 10, etag: "\"b\"" });
    await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "a" }] });
    // A storage notification (or any nudge) makes the session due; the client hold still wins.
    await db.query("update upload_sessions set next_reconcile_at = now() - interval '1 second' where id = $1", [SESSION]);
    mocks.heads.length = 0;
    await reconcileDirectUploads();
    expect(mocks.heads).toEqual([]);
    expect((await fileRow("b")).status).toBe("pending");
    expect(mocks.confirm).not.toHaveBeenCalled();

    // The client went away: the hold lapses and the reconciler finalizes the rest and confirms.
    await db.query(`update upload_sessions set client_finalizing_until = now() - interval '1 second', next_reconcile_at = now() - interval '1 second' where id = $1`, [SESSION]);
    await reconcileDirectUploads();
    expect((await fileRow("b")).status).toBe("completed");
    expect(mocks.confirm).toHaveBeenCalledWith({ sessionId: SESSION, userId: "u" });
  });

  it("still aborts an expired session that a client was holding", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await db.query(`update upload_sessions set expires_at = now() - interval '1 second', next_reconcile_at = now() - interval '1 second',
      client_finalizing_until = now() + interval '1 hour' where id = $1`, [SESSION]);
    await reconcileDirectUploads();
    expect((await sessionRow()).status).toBe("aborted");
  });

  it("does not hold a session the SDK leaves to the reconciler (no files/complete call)", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await db.query("update upload_sessions set next_reconcile_at = now() - interval '1 second' where id = $1", [SESSION]);
    await reconcileDirectUploads();
    expect((await fileRow("a")).status).toBe("completed");
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });

  it("holds for a bounded window only", () => {
    expect(CLIENT_FINALIZING_HOLD_SECONDS).toBeGreaterThan(0);
    expect(CLIENT_FINALIZING_HOLD_SECONDS).toBeLessThanOrEqual(60);
  });
});
