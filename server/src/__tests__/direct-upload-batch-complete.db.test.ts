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
  /** Remaining copy attempts per source key that fail with the provider's spurious "bucket does not exist". */
  copyOutages: new Map<string, number>(),
  /** Holds a copy's answer (after its bytes were written) until released: an ambiguous, late outcome. */
  copyAnswerGate: null as Promise<void> | null,
  heads: [] as string[],
  confirm: vi.fn(),
  /** Runs when a lock is tried (a client acting just before the holder gets the session). */
  onLock: null as null | (() => Promise<void>),
  /** Runs at each HEAD, after an optional delay. */
  onHead: null as null | ((key: string) => Promise<void>),
  headDelayMs: 0,
  /** Every lock reservation: `class:tenant`. */
  tenants: [] as string[],
  partSignatures: 0,
  putSignatures: 0,
  /** Runs inside each ListParts (a slow provider read during part signing). */
  onListParts: null as null | (() => Promise<void>),
  listParts: 0,
  /** The parts ListParts reports (default none). */
  parts: [] as Array<{ partNumber: number; sizeBytes: number; etag: string }>,
  /** Runs inside each multipart initialization; may throw (a provider failure). */
  onCreateMultipart: null as null | (() => Promise<void>),
  multipartCreates: 0,
  multipartCompletes: 0,
}));
vi.mock("../db.js", () => ({ sql: Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, "");
    return { then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      mocks.query(text, values).then((result: { rows: unknown[] }) => result.rows).then(resolve, reject) };
  }, { json: (value: unknown) => JSON.stringify(value), array: (value: unknown) => value }) }));
vi.mock("../lib/direct-upload-locks.js", () => ({ DirectUploadLockUnavailable: class extends Error {}, reserveDirectUploadLockConnection: async (options: { lockClass?: string; tenant?: string } = {}) => (mocks.tenants.push(`${options.lockClass ?? "short"}:${options.tenant ?? ""}`), {
  connection: async (strings: TemplateStringsArray) => {
    if (!strings.join("").includes("pg_try_advisory_lock")) return [];
    if (mocks.onLock) { const hook = mocks.onLock; mocks.onLock = null; await hook(); }
    return [{ acquired: !mocks.lockHeld }];
  },
  release: () => {},
}) }));
vi.mock("../lib/storage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/storage.js")>(),
  getUploadedObjectMetadata: async (key: string) => {
    mocks.heads.push(key);
    if (mocks.headDelayMs) await new Promise(resolve => setTimeout(resolve, mocks.headDelayMs));
    if (mocks.onHead) await mocks.onHead(key);
    const object = mocks.objects.get(key);
    if (!object) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return { contentLength: object.size, etag: object.etag };
  },
  copyUploadedObject: async (input: { fromKey: string; toKey: string; ifMatch?: string }) => {
    mocks.copies.push(input);
    const outage = mocks.copyOutages.get(input.fromKey) ?? 0;
    if (outage > 0) {
      mocks.copyOutages.set(input.fromKey, outage - 1);
      throw Object.assign(new Error("The specified bucket does not exist"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
    }
    if (mocks.replacedBeforeCopy.has(input.fromKey)) mocks.objects.set(input.fromKey, { ...mocks.objects.get(input.fromKey)!, etag: "\"replaced\"" });
    const source = mocks.objects.get(input.fromKey);
    if (!source || (input.ifMatch && source.etag !== input.ifMatch)) throw Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    mocks.objects.set(input.toKey, { ...source });
    const gate = mocks.copyAnswerGate;
    if (gate) { mocks.copyAnswerGate = null; await gate; }
    return { etag: source.etag };
  },
  deleteUploadedObject: async (key: string) => { mocks.objects.delete(key); },
  abortMultipartUpload: async () => {},
  signSingleUploadPut: async ({ key }: { key: string }) => { mocks.putSignatures += 1; return `https://storage.example/${key}`; },
  signMultipartUploadPart: async () => { mocks.partSignatures += 1; return "https://storage.example/part"; },
  listMultipartUploadParts: async () => { mocks.listParts += 1; if (mocks.onListParts) await mocks.onListParts(); return mocks.parts; },
  createMultipartUpload: async () => { mocks.multipartCreates += 1; if (mocks.onCreateMultipart) await mocks.onCreateMultipart(); return `up-${mocks.multipartCreates}`; },
  completeMultipartUpload: async ({ key }: { key: string }) => { mocks.multipartCompletes += 1; mocks.objects.set(key, { size: 20 * 1024 * 1024, etag: "\"mp\"" }); return {}; },
}));
vi.mock("../services/project-intake-actions.js", () => ({ confirmDirectUploadProjectIntake: mocks.confirm }));

const { completeDirectUploadFiles, completeDirectUploadFile, abortDirectUploadSession, finalizeDirectUploadFile, loadDirectUploadSession, sealedSourceKey, getDirectUploadSessionDescription, signDirectUploadParts, CLIENT_FINALIZING_HOLD_SECONDS } = await import("../services/direct-upload-session.js");
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
  mocks.copyOutages.clear();
  mocks.copyAnswerGate = null;
  mocks.onLock = null;
  mocks.onHead = null;
  mocks.headDelayMs = 0;
  mocks.tenants.length = 0;
  mocks.partSignatures = 0;
  mocks.putSignatures = 0;
  mocks.onListParts = null;
  mocks.listParts = 0;
  mocks.parts = [];
  mocks.onCreateMultipart = null;
  mocks.multipartCreates = 0;
  mocks.multipartCompletes = 0;
  // A held lock is answered at once here (production waits DOCSLURP_UPLOAD_LOCK_WAIT_MS first).
  (await import("../config.js")).env.directUploadLockWaitMs = 0;
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

describe("missing bytes have explicit codes", () => {
  it("answers upload_object_missing for a file without a stored object, and upload_parts_incomplete for an unassembled multipart file", async () => {
    await seedFile(SESSION, "gone", null);
    await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
      values ('mp', $1, 'big.pdf', 'application/pdf', $2, $3, 'multipart', 'up-1', $4, 'pending')`, [SESSION, 20 * 1024 * 1024, `u/${SESSION}/raw/big.pdf`, 8 * 1024 * 1024]);
    const result = await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "gone" }, { fileId: "mp" }] });
    const byId = Object.fromEntries(result.files.map(file => [file.fileId, file]));
    expect(byId.gone).toMatchObject({ status: "failed", error: { statusCode: 409, code: "upload_object_missing", retryable: false, action: "reupload", blocksSession: false } });
    expect(byId.mp).toMatchObject({ status: "failed", error: { statusCode: 409, code: "upload_parts_incomplete", retryable: false, action: "reupload" } });
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

describe("per-call cost does not grow with session size", () => {
  // The full production request path: route middleware (session ownership and contribute checks) and the complete itself.
  async function routeApp() {
    const { Hono } = await import("hono");
    const { createUploadsRoutes } = await import("../routes/uploads.js");
    return new Hono().use("*", async (c, next) => { c.set("sessionUser", { id: "u", email: "uploader@example.test", name: "Uploader" } as never); await next(); })
      .route("/uploads", createUploadsRoutes());
  }
  async function seedSession(id: string, count: number) {
    await db.query(`insert into upload_sessions (id,user_id,org_id,status,next_reconcile_at) values ($1,'u','o','pending', now() + interval '1 hour')`, [id]);
    await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, status, request_index)
      select $1 || '-' || i, $1, 'doc.pdf', 'application/pdf', 10, 'u/' || $1 || '/raw/' || i || '-doc.pdf', 'single', 'pending', i
      from generate_series(0, $2::int - 1) as i`, [id, count]);
    for (let i = 0; i < count; i++) mocks.objects.set(`u/${id}/raw/${i}-doc.pdf`, { size: 10, etag: `"e${i}"` });
  }
  /** Rows fetched from the database and wall time for each of `calls` single-file completes, through the route. */
  async function measure(sessionId: string, calls: number) {
    const app = await routeApp();
    const rows: number[] = [];
    const ms: number[] = [];
    for (let i = 0; i < calls; i++) {
      let fetched = 0;
      mocks.query.mockImplementation(async (text: string, values: unknown[]) => {
        const result = await db.query(text, values);
        fetched += result.rows.length;
        return result;
      });
      const started = performance.now();
      const response = await app.request(`/uploads/direct/sessions/${sessionId}/files/complete`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileId: `${sessionId}-${i}` }),
      });
      ms.push(performance.now() - started);
      expect(response.status).toBe(200);
      rows.push(fetched);
    }
    mocks.query.mockImplementation((text: string, values: unknown[]) => db.query(text, values));
    const median = [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]!;
    return { rows, median };
  }

  it("fetches the same rows per complete for a 10-file and a 1,000-file session", async () => {
    const small = "33333333-3333-4333-8333-333333333333";
    const large = "44444444-4444-4444-8444-444444444444";
    await seedSession(small, 10);
    await seedSession(large, 1000);
    const { loadDirectUploadSession } = await import("../services/direct-upload-session.js");
    const fullLoad = (await loadDirectUploadSession(large, "u"))!.files.length;

    const smallRun = await measure(small, 10);
    const largeRun = await measure(large, 10);
    console.info(`[upload-complete-cost] files=10 rows/call=${smallRun.rows.join(",")} median_ms=${smallRun.median.toFixed(1)}`);
    console.info(`[upload-complete-cost] files=1000 rows/call=${largeRun.rows.join(",")} median_ms=${largeRun.median.toFixed(1)} (a full session load alone fetches ${fullLoad + 1} rows)`);
    // Flat: every call fetches a constant handful of rows, whatever the session size.
    expect(new Set([...smallRun.rows, ...largeRun.rows]).size).toBe(1);
    expect(largeRun.rows[0]).toBeLessThan(10);
    expect(fullLoad).toBe(1000);
  }, 120_000);
});

describe("storage outages and held locks are retryable, never client errors", () => {
  async function routeApp() {
    const { Hono } = await import("hono");
    const { createUploadsRoutes } = await import("../routes/uploads.js");
    return new Hono().use("*", async (c, next) => { c.set("sessionUser", { id: "u", email: "uploader@example.test", name: "Uploader" } as never); await next(); })
      .route("/uploads", createUploadsRoutes());
  }
  const post = async (path: string, body?: unknown) => (await routeApp()).request(`/uploads/direct/sessions/${SESSION}/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  it("retries a transient seal-copy failure and completes the file", async () => {
    const key = await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    mocks.copyOutages.set(key, 1);
    const response = await post("files/complete", { fileId: "a" });
    expect(response.status).toBe(200);
    expect(mocks.copies.filter(copy => copy.fromKey === key)).toHaveLength(2);
    expect((await fileRow("a")).status).toBe("completed");
  });

  it("answers a persistent outage on the single body with 503 upload_storage_unavailable and Retry-After", async () => {
    const key = await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    mocks.copyOutages.set(key, 99);
    const response = await post("files/complete", { fileId: "a" });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upload_storage_unavailable");
    expect(body.error.message).not.toContain("bucket");
    // Bounded: three attempts, and the file stays open for a retry.
    expect(mocks.copies.filter(copy => copy.fromKey === key)).toHaveLength(3);
    expect((await fileRow("a")).status).toBe("pending");
  });

  it("reports a persistent outage per file in a batch while the other files complete", async () => {
    const key = await seedFile(SESSION, "down", { size: 10, etag: "\"d\"" });
    await seedFile(SESSION, "up", { size: 10, etag: "\"u\"" });
    mocks.copyOutages.set(key, 99);
    const response = await post("files/complete", { files: [{ fileId: "down" }, { fileId: "up" }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, completedCount: 1, files: [
      { fileId: "down", status: "failed", error: { statusCode: 503, code: "upload_storage_unavailable", retryable: true } },
      { fileId: "up", status: "completed" },
    ] });
    expect((await fileRow("down")).status).toBe("pending");
  });

  it("keeps a precondition failure (bytes replaced) a per-file 409, not retryable", async () => {
    const key = await seedFile(SESSION, "r", { size: 10, etag: "\"r\"" });
    mocks.replacedBeforeCopy.add(key);
    const response = await post("files/complete", { files: [{ fileId: "r" }] });
    expect(await response.json()).toMatchObject({ files: [{ fileId: "r", status: "failed", error: { statusCode: 409, retryable: false } }] });
    expect(mocks.copies.filter(copy => copy.fromKey === key)).toHaveLength(1);
  });

  it("answers abort of an ingested session with 409, not 500", async () => {
    await db.query("update upload_sessions set status = 'confirmed' where id = $1", [SESSION]);
    const response = await post("abort");
    expect(response.status).toBe(409);
  });

  it("abort refuses a held lock with upload_session_busy, or waits it out", async () => {
    mocks.lockHeld = true;
    await expect(abortDirectUploadSession(SESSION, "u")).rejects.toMatchObject({ statusCode: 409, code: "upload_session_busy" });
    expect((await sessionRow()).status).toBe("pending");
    setTimeout(() => { mocks.lockHeld = false; }, 300);
    await expect(abortDirectUploadSession(SESSION, "u", 3_000)).resolves.toBe(true);
    expect((await sessionRow()).status).toBe("aborted");
  });
});

describe("sealing publishes exactly one verified version", () => {
  it("lets only the fenced winner publish when two finalizers seal different source versions", async () => {
    const key = await seedFile(SESSION, "a", { size: 10, etag: "\"v1\"" });
    const row = (await loadDirectUploadSession(SESSION, "u"))!.files[0]!;
    // Finalizer 1 verifies v1 and copies it, but its copy's answer is held (a lost lock connection lets it run on).
    let release!: () => void;
    mocks.copyAnswerGate = new Promise<void>(resolve => { release = resolve; });
    const first = finalizeDirectUploadFile(row).then(() => "published", error => error);
    await vi.waitFor(() => expect(mocks.copies).toHaveLength(1));
    // Meanwhile the client replaces the bytes (still a valid PUT URL) and finalizer 2 seals and publishes v2.
    mocks.objects.set(key, { size: 10, etag: "\"v2\"" });
    await expect(finalizeDirectUploadFile(row)).resolves.toBe(true);
    const v1 = sealedSourceKey(row, "\"v1\"");
    const v2 = sealedSourceKey(row, "\"v2\"");
    expect(v1).not.toBe(v2);
    expect(await fileRow("a")).toMatchObject({ status: "completed", source_key: v2 });
    // Finalizer 1 resumes: its fenced publish matches nothing, so v1 is never published and its copy is discarded.
    release();
    expect(await first).toMatchObject({ statusCode: 409 });
    expect(await fileRow("a")).toMatchObject({ status: "completed", source_key: v2 });
    expect(mocks.objects.has(v1)).toBe(false);
    expect(mocks.objects.get(v2)).toMatchObject({ etag: "\"v2\"" });
    const queued = await db.query<{ target: string; payload: { sealedKey: string } }>("select target, payload from storage_cleanup_queue where reason = 'losing_seal'");
    expect(queued.rows).toEqual([{ target: v1, payload: { sealedKey: v2 } }]);
  });

  it("treats a repeat of the same version as already published", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"v1\"" });
    const row = (await loadDirectUploadSession(SESSION, "u"))!.files[0]!;
    await expect(finalizeDirectUploadFile(row)).resolves.toBe(true);
    // A stale finalizer still holding the pending row repeats the same version: no error, nothing discarded.
    await expect(finalizeDirectUploadFile(row)).resolves.toBe(true);
    expect(mocks.objects.has(sealedSourceKey(row, "\"v1\""))).toBe(true);
  });
});

describe("the client hold (M2) and guarded reconciler transitions (M1)", () => {
  async function hold() {
    return (await db.query<{ until: string | null; since: string | null; held: boolean; due: string }>(`select client_finalizing_until::text as until,
      client_finalizing_since::text as since, coalesce(client_finalizing_until > now(), false) as held, next_reconcile_at::text as due
      from upload_sessions where id = $1`, [SESSION])).rows[0]!;
  }

  it("opens the hold before taking the lock, so a busy answer still keeps the sweep away", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    mocks.lockHeld = true;
    await expect(completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "a" }] })).rejects.toMatchObject({ code: "upload_session_busy" });
    expect(await hold()).toMatchObject({ held: true });
  });

  it("extends the hold only on new progress, and never past the cap from its start", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await seedFile(SESSION, "missing", null);
    await seedFile(SESSION, "b", { size: 10, etag: "\"b\"" });
    await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "a" }] });
    const first = await hold();
    // No progress (the file is not there yet): the hold is not extended.
    await db.query("update upload_sessions set client_finalizing_until = now() + interval '5 seconds' where id = $1", [SESSION]);
    const before = await hold();
    await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "missing" }] });
    expect((await hold()).until).toBe(before.until);
    expect((await hold()).since).toBe(first.since);
    // Progress after the cap: the hold ends at the cap (already past), so the reconciler may take over.
    await db.query("update upload_sessions set client_finalizing_since = now() - interval '16 minutes' where id = $1", [SESSION]);
    await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "b" }] });
    expect(await hold()).toMatchObject({ held: false });
  });

  it("re-checks the hold under the lock: a client that starts finalizing after selection wins, with no backoff or error", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await db.query("update upload_sessions set next_reconcile_at = now() - interval '1 second' where id = $1", [SESSION]);
    const due = (await hold()).due;
    // The sweep selected the session; before it gets the lock, a client opens a hold.
    mocks.onLock = async () => { await db.query("update upload_sessions set client_finalizing_until = now() + interval '30 seconds' where id = $1", [SESSION]); };
    await reconcileDirectUploads();
    expect(mocks.heads).toEqual([]);
    expect((await fileRow("a")).status).toBe("pending");
    const after = await db.query<{ due: string; attempts: number; last_error: string | null }>(
      "select next_reconcile_at::text as due, reconcile_attempts as attempts, last_error from upload_sessions where id = $1", [SESSION]);
    expect(after.rows[0]).toEqual({ due, attempts: 0, last_error: null });
  });

  it("does not push back a session that newer work made due during the pass", async () => {
    await seedFile(SESSION, "missing", null);
    await db.query("update upload_sessions set next_reconcile_at = now() - interval '1 second' where id = $1", [SESSION]);
    // While the sweep inspects the file, a client's last complete (or a webhook) makes the session due again.
    mocks.onHead = async () => { mocks.onHead = null; await db.query("update upload_sessions set next_reconcile_at = now() where id = $1", [SESSION]); };
    await reconcileDirectUploads();
    const after = await db.query<{ backed_off: boolean; attempts: number }>(
      "select next_reconcile_at > now() + interval '1 second' as backed_off, reconcile_attempts as attempts from upload_sessions where id = $1", [SESSION]);
    expect(after.rows[0]).toEqual({ backed_off: false, attempts: 0 });
  });

  it("applies a terminal confirm failure only to the state that produced it", async () => {
    const { ProjectIntakeError } = await import("../services/project-intake.js");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await db.query("update upload_sessions set next_reconcile_at = now() - interval '1 second' where id = $1", [SESSION]);
    // A client changes the session (a file is re-sealed) while the confirm runs; the confirm then fails terminally.
    mocks.confirm.mockImplementationOnce(async () => {
      await db.query("update upload_session_files set updated_at = now() + interval '1 second' where id = 'a'");
      throw new ProjectIntakeError("Upload refused", 400);
    });
    await reconcileDirectUploads();
    expect((await sessionRow()).status).toBe("pending");
    // The same failure on an unchanged session is applied.
    await db.query("update upload_sessions set next_reconcile_at = now() - interval '1 second' where id = $1", [SESSION]);
    mocks.confirm.mockRejectedValueOnce(new ProjectIntakeError("Upload refused", 400));
    await reconcileDirectUploads();
    expect((await sessionRow()).status).toBe("failed");
    log.mockRestore();
  });

  it("stops starting files when the hold's budget is spent and reports the rest as retryable busy", async () => {
    const { env } = await import("../config.js");
    const budget = env.directUploadLockHoldBudgetMs;
    env.directUploadLockHoldBudgetMs = 30;
    try {
      for (let i = 0; i < 20; i++) await seedFile(SESSION, `f${i}`, { size: 10, etag: `"e${i}"` });
      mocks.headDelayMs = 20;
      const result = await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: Array.from({ length: 20 }, (_, i) => ({ fileId: `f${i}` })) });
      const skipped = result.files.filter(file => file.status === "failed");
      expect(result.completedCount).toBeGreaterThan(0);
      expect(skipped.length).toBeGreaterThan(0);
      for (const file of skipped) expect(file).toMatchObject({ error: { statusCode: 409, code: "upload_session_busy", retryable: true, action: "retry" } });
      for (const file of skipped) expect((await fileRow(file.fileId)).status).toBe("pending");
    } finally { env.directUploadLockHoldBudgetMs = budget; }
  });
});

describe("the full session read on a large session (C-H1)", () => {
  it("answers when its budget cannot inspect every file: unreached files stay pending, with targets, uninspected", async () => {
    const { env } = await import("../config.js");
    const budget = env.directUploadLockHoldBudgetMs;
    env.directUploadLockHoldBudgetMs = 30;
    try {
      // 40 files whose bytes never arrived: no read makes progress on them, so a read that needed all of them inspected
      // would fail the same way forever.
      for (let i = 0; i < 40; i++) await seedFile(SESSION, `m${i}`, null);
      mocks.headDelayMs = 20;
      const described = await getDirectUploadSessionDescription(SESSION, "u");
      expect(described!.files).toHaveLength(40);
      const files = described!.files as Array<{ id: string; status: string; inspected?: boolean; putUrl?: string }>;
      for (const file of files) expect(file).toMatchObject({ status: "pending", putUrl: expect.any(String) });
      const uninspected = files.filter(file => file.inspected === false);
      expect(uninspected.length).toBeGreaterThan(0);
      expect(uninspected.length).toBeLessThan(40);
      expect(mocks.heads.length).toBeLessThan(40);
    } finally { env.directUploadLockHoldBudgetMs = budget; }
  });

  it("describes and inspects only the files named with fileId", async () => {
    for (let i = 0; i < 10; i++) await seedFile(SESSION, `n${i}`, null);
    const described = await getDirectUploadSessionDescription(SESSION, "u", false, undefined, ["n3", "n7"]);
    expect((described!.files as Array<{ id: string }>).map(file => file.id).sort()).toEqual(["n3", "n7"]);
    expect(mocks.heads.sort()).toEqual([`u/${SESSION}/raw/n3-doc.pdf`, `u/${SESSION}/raw/n7-doc.pdf`]);
  });
});

describe("lock accounting uses the principal's organization, never a stored or requested one (M2)", () => {
  it("bills a spoofed session organization's calls to the caller's own organization", async () => {
    // A browser session created naming another organization ('o2', the victim): its stored org is the request's.
    await db.query("update upload_sessions set org_id = 'o2' where id = $1", [SESSION]);
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
      values ('mp', $1, 'big.pdf', 'application/pdf', $2, $3, 'multipart', 'up-1', $4, 'pending')`, [SESSION, 20 * 1024 * 1024, `u/${SESSION}/raw/big.pdf`, 8 * 1024 * 1024]);
    await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "a" }] }).catch(() => null);
    await signDirectUploadParts(SESSION, "u", "mp", [1]).catch(() => null);
    await getDirectUploadSessionDescription(SESSION, "u").catch(() => null);
    await abortDirectUploadSession(SESSION, "u").catch(() => null);
    expect(mocks.tenants.length).toBeGreaterThanOrEqual(4);
    // Every reservation counted against u's own organization ('o', its membership), none against the victim's.
    for (const tenant of mocks.tenants) expect(tenant.endsWith(":org:o")).toBe(true);
  });
});

describe("minting targets re-checks the caller under the lock (H2)", () => {
  beforeEach(async () => {
    await db.query("delete from api_keys where id = 'k-u'");
    await db.query(`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, allowed_domains, project_ids)
      values ('k-u', 'u', 'o', 'hash-k-u', 'Ingest', 'server', '{ingest}', '{}', '{}')`);
    await db.query("update upload_sessions set api_key_id = 'k-u' where id = $1", [SESSION]);
  });

  it("returns no targets when the key is revoked while the read waits for the lock", async () => {
    await seedFile(SESSION, "a", null);
    await expect(getDirectUploadSessionDescription(SESSION, "u", false, undefined, undefined, "k-u")).resolves.toMatchObject({ files: [{ id: "a", putUrl: expect.any(String) }] });
    mocks.onLock = async () => { await db.query("update api_keys set revoked_at = now() where id = 'k-u'"); };
    await expect(getDirectUploadSessionDescription(SESSION, "u", false, undefined, undefined, "k-u")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("signs no parts when the key loses its scope while signing waits for the lock", async () => {
    await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
      values ('mp', $1, 'big.pdf', 'application/pdf', $2, $3, 'multipart', 'up-1', $4, 'pending')`, [SESSION, 20 * 1024 * 1024, `u/${SESSION}/raw/big.pdf`, 8 * 1024 * 1024]);
    mocks.onLock = async () => { await db.query("update api_keys set scopes = '{search:hybrid}' where id = 'k-u'"); };
    await expect(signDirectUploadParts(SESSION, "u", "mp", [1, 2], "k-u")).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.partSignatures).toBe(0);
  });

  async function seedMultipart() {
    await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
      values ('mp', $1, 'big.pdf', 'application/pdf', $2, $3, 'multipart', 'up-1', $4, 'pending')`, [SESSION, 20 * 1024 * 1024, `u/${SESSION}/raw/big.pdf`, 8 * 1024 * 1024]);
  }

  it("signs no parts when the key is revoked during a slow ListParts (checked after it, right before signing)", async () => {
    await seedMultipart();
    mocks.onListParts = async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      await db.query("update api_keys set revoked_at = now() where id = 'k-u'");
    };
    await expect(signDirectUploadParts(SESSION, "u", "mp", [1, 2], "k-u")).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.listParts).toBe(1);
    expect(mocks.partSignatures).toBe(0);
  });

  it("signs no parts when the key's project allowlist stops covering the session during ListParts", async () => {
    await db.query("insert into projects (id, org_id, user_id, name) values ('44444444-4444-4444-8444-444444444444', 'o', 'u', 'Results') on conflict do nothing");
    await db.query("update upload_sessions set project_id = '44444444-4444-4444-8444-444444444444' where id = $1", [SESSION]);
    await db.query("update api_keys set project_ids = '{44444444-4444-4444-8444-444444444444}' where id = 'k-u'");
    await seedMultipart();
    mocks.onListParts = async () => { await db.query("update api_keys set project_ids = '{33333333-3333-4333-8333-333333333333}' where id = 'k-u'"); };
    await expect(signDirectUploadParts(SESSION, "u", "mp", [1], "k-u")).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.partSignatures).toBe(0);
  });

  it("starts nothing when the client disconnects while signing waits for the lock", async () => {
    await seedMultipart();
    const client = new AbortController();
    mocks.onLock = async () => { client.abort(); };
    await expect(signDirectUploadParts(SESSION, "u", "mp", [1], "k-u", client.signal)).rejects.toBeTruthy();
    expect(mocks.heads).toHaveLength(0);
    expect(mocks.listParts).toBe(0);
    expect(mocks.partSignatures).toBe(0);
  });

  it("seals no uploaded object when the key is revoked after the read's HEAD (checked before each seal)", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    mocks.onHead = async () => { await db.query("update api_keys set revoked_at = now() where id = 'k-u'"); };
    await expect(getDirectUploadSessionDescription(SESSION, "u", false, undefined, undefined, "k-u")).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.copies).toHaveLength(0);
    expect((await fileRow("a")).status).toBe("pending");
    expect(mocks.putSignatures).toBe(0);
  });

  it("signs no targets in a fresh create whose key was revoked after provider setup, and aborts that session", async () => {
    await db.query("update api_keys set revoked_at = now() where id = 'k-u'");
    const { createDirectUploadSession } = await import("../services/direct-upload-session.js");
    await expect(createDirectUploadSession({ userId: "u", orgId: "o", apiKeyId: "k-u", pipeline: {},
      files: [{ filename: "results.pdf", mimeType: "application/pdf", sizeBytes: 10, singlePart: true }] })).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.putSignatures).toBe(0);
    const created = (await db.query<{ status: string }>("select status from upload_sessions where id <> $1 and id <> $2 and api_key_id = 'k-u'", [SESSION, FOREIGN])).rows;
    expect(created.map(row => row.status)).toEqual(["aborted"]);
  });

  it("checks the key before each multipart initialization in a fresh create, retries included", async () => {
    // The first initialization fails transiently after the key is revoked: its retry is refused before it is sent.
    mocks.onCreateMultipart = async () => {
      if (mocks.multipartCreates > 1) return;
      await db.query("update api_keys set revoked_at = now() where id = 'k-u'");
      throw Object.assign(new Error("slow down"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    };
    const { createDirectUploadSession } = await import("../services/direct-upload-session.js");
    await expect(createDirectUploadSession({ userId: "u", orgId: "o", apiKeyId: "k-u", pipeline: {},
      files: [{ filename: "results.pdf", mimeType: "application/pdf", sizeBytes: 40 * 1024 * 1024 }] })).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.multipartCreates).toBe(1);
    expect(mocks.putSignatures + mocks.partSignatures).toBe(0);
  });

  it("opens no provider upload in a fresh create whose key is already revoked", async () => {
    await db.query("update api_keys set revoked_at = now() where id = 'k-u'");
    const { createDirectUploadSession } = await import("../services/direct-upload-session.js");
    await expect(createDirectUploadSession({ userId: "u", orgId: "o", apiKeyId: "k-u", pipeline: {},
      files: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 40 * 1024 * 1024 }, { filename: "b.pdf", mimeType: "application/pdf", sizeBytes: 40 * 1024 * 1024 }] }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.multipartCreates).toBe(0);
  });

  it("files/complete from a key caller seals nothing when the key is revoked before the copy", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    mocks.onHead = async () => { await db.query("update api_keys set revoked_at = now() where id = 'k-u'"); };
    const result = await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "a" }], credentialKeyId: "k-u" });
    expect(result.files[0]).toMatchObject({ status: "failed", error: { statusCode: 403 } });
    expect(mocks.copies).toHaveLength(0);
    expect((await fileRow("a")).status).toBe("pending");
  });

  it("files/complete from a key caller completes no multipart upload when the allowlist drops the project during ListParts", async () => {
    await db.query("insert into projects (id, org_id, user_id, name) values ('44444444-4444-4444-8444-444444444444', 'o', 'u', 'Results') on conflict do nothing");
    await db.query("update upload_sessions set project_id = '44444444-4444-4444-8444-444444444444' where id = $1", [SESSION]);
    await db.query("update api_keys set project_ids = '{44444444-4444-4444-8444-444444444444}' where id = 'k-u'");
    await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
      values ('mp', $1, 'big.pdf', 'application/pdf', $2, $3, 'multipart', 'up-1', $4, 'pending')`, [SESSION, 20 * 1024 * 1024, `u/${SESSION}/raw/big.pdf`, 8 * 1024 * 1024]);
    mocks.parts = [{ partNumber: 1, sizeBytes: 8 * 1024 * 1024, etag: "\"1\"" }, { partNumber: 2, sizeBytes: 8 * 1024 * 1024, etag: "\"2\"" }, { partNumber: 3, sizeBytes: 4 * 1024 * 1024, etag: "\"3\"" }];
    mocks.onListParts = async () => { await db.query("update api_keys set project_ids = '{33333333-3333-4333-8333-333333333333}' where id = 'k-u'"); };
    const result = await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "mp" }], credentialKeyId: "k-u" });
    expect(result.files[0]).toMatchObject({ status: "failed", error: { statusCode: 403 } });
    expect(mocks.multipartCompletes).toBe(0);
  });

  it("files/complete from a browser caller (no key) still seals: the user acts on their own access", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    await db.query("update api_keys set revoked_at = now() where id = 'k-u'");
    const result = await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "a" }] });
    expect(result.files[0]).toMatchObject({ status: "completed" });
    expect(mocks.copies).toHaveLength(1);
  });

  it("the REST route passes the caller's own key to the finalizer (the path MCP completeUpload takes too)", async () => {
    await seedFile(SESSION, "a", { size: 10, etag: "\"a\"" });
    mocks.onHead = async () => { await db.query("update api_keys set revoked_at = now() where id = 'k-u'"); };
    const { Hono } = await import("hono");
    const { createUploadsRoutes } = await import("../routes/uploads.js");
    const { setRequestActor } = await import("../lib/request-actor.js");
    const apiKey = { keyId: "k-u", orgId: "o", keyType: "server", scopes: ["ingest"], projectIds: [], allowedDomains: [] };
    const app = new Hono().use("*", async (c, next) => {
      setRequestActor(c, { type: "apiKey", userId: "u", apiKey } as never);
      c.set("sessionUser", { id: "u", email: "uploader@example.test", name: "Uploader" } as never);
      c.set("apiKey", apiKey as never);
      await next();
    }).route("/uploads", createUploadsRoutes());
    const response = await app.request(`/uploads/direct/sessions/${SESSION}/files/complete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: [{ fileId: "a" }] }),
    });
    expect(await response.json()).toMatchObject({ ok: false, files: [{ fileId: "a", status: "failed", error: { statusCode: 403 } }] });
    expect(mocks.copies).toHaveLength(0);
  });
});

describe("a session read signs a bounded number of part URLs (M1)", () => {
  it("signs at most 1,000 part URLs and describes the rest without one, for parts/sign", async () => {
    // Three open multipart files of 500 parts each: 1,500 parts a read could sign.
    for (const id of ["x", "y", "z"]) {
      await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
        values ($1, $2, 'big.pdf', 'application/pdf', $3, $4, 'multipart', $5, $6, 'pending')`, [id, SESSION, 500 * 8 * 1024 * 1024, `u/${SESSION}/raw/${id}.pdf`, `up-${id}`, 8 * 1024 * 1024]);
    }
    const described = await getDirectUploadSessionDescription(SESSION, "u");
    const files = described!.files as Array<{ pendingParts: Array<{ url?: string }>; partUrlsOmitted?: boolean }>;
    const parts = files.flatMap(file => file.pendingParts);
    expect(parts).toHaveLength(1_500);
    expect(parts.filter(part => part.url)).toHaveLength(1_000);
    expect(mocks.partSignatures).toBe(1_000);
    expect(files.some(file => file.partUrlsOmitted === true)).toBe(true);
    // Every part is still described (number and size), so a client can sign the rest.
    expect(parts.every(part => typeof (part as { partNumber?: number }).partNumber === "number")).toBe(true);
  });
});

describe("the fileId filter at the route (boundaries)", () => {
  async function read(query: string) {
    const { Hono } = await import("hono");
    const { createUploadsRoutes } = await import("../routes/uploads.js");
    const app = new Hono().use("*", async (c, next) => { c.set("sessionUser", { id: "u", email: "uploader@example.test", name: "Uploader" } as never); await next(); })
      .route("/uploads", createUploadsRoutes());
    return await app.request(`/uploads/direct/sessions/${SESSION}?${query}`);
  }

  it("never returns or inspects a file of another session of the same user", async () => {
    const OTHER = "33333333-3333-4333-8333-000000000001";
    await db.query(`insert into upload_sessions (id,user_id,org_id,status,next_reconcile_at) values ($1,'u','o','pending', now() + interval '1 hour')`, [OTHER]);
    const key = await seedFile(OTHER, "elsewhere", { size: 10, etag: "\"e\"" });
    await seedFile(SESSION, "mine", null);
    const response = await read("fileId=elsewhere&fileId=mine");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { files: Array<{ id: string }> }).files.map(file => file.id)).toEqual(["mine"]);
    expect(mocks.heads).not.toContain(key);
  });

  it("never returns or inspects a file of another organization's session", async () => {
    const key = await seedFile(FOREIGN, "theirs", { size: 10, etag: "\"t\"" });
    const response = await read("fileId=theirs");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { files: unknown[] }).files).toEqual([]);
    expect(mocks.heads).not.toContain(key);
    expect(await fileRow("theirs")).toMatchObject({ status: "pending", source_key: key });
  });

  it("returns a completed file in a filtered read as completed, with no upload target", async () => {
    await seedFile(SESSION, "done", { size: 10, etag: "\"d\"" });
    await db.query("update upload_session_files set status = 'completed' where id = 'done'");
    const response = await read("fileId=done");
    const [file] = ((await response.json()) as { files: Array<Record<string, unknown>> }).files;
    expect(file).toMatchObject({ id: "done", status: "completed", transferState: "complete" });
    expect(file).not.toHaveProperty("putUrl");
    expect(file).not.toHaveProperty("pendingParts");
  });

  it.each([
    ["an empty fileId", "fileId="],
    ["an over-long fileId", `fileId=${"x".repeat(65)}`],
    ["more than 1,000 fileIds", Array.from({ length: 1_001 }, (_, i) => `fileId=f${i}`).join("&")],
  ])("refuses %s with 400", async (_label, query) => {
    expect((await read(query)).status).toBe(400);
    expect(mocks.heads).toEqual([]);
  });
});

describe("steer items on the session read", () => {
  it("never attaches parts to an uninspected multipart file", async () => {
    const { env } = await import("../config.js");
    const budget = env.directUploadLockHoldBudgetMs;
    env.directUploadLockHoldBudgetMs = 1;
    try {
      mocks.headDelayMs = 20;
      for (let i = 0; i < 12; i++) {
        await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
          values ($1, $2, 'big.pdf', 'application/pdf', $3, $4, 'multipart', $5, $6, 'pending')`, [`mp${i}`, SESSION, 24 * 1024 * 1024, `u/${SESSION}/raw/mp${i}.pdf`, `up-${i}`, 8 * 1024 * 1024]);
      }
      const described = await getDirectUploadSessionDescription(SESSION, "u");
      const uninspected = (described!.files as Array<Record<string, unknown>>).filter(file => file.inspected === false);
      expect(uninspected.length).toBeGreaterThan(0);
      for (const file of uninspected) {
        expect(file).not.toHaveProperty("pendingParts");
        expect(file).toMatchObject({ mode: "multipart", transferState: "unknown" });
      }
    } finally { env.directUploadLockHoldBudgetMs = budget; }
  });

  it("refuses fileId together with statusOnly", async () => {
    const { Hono } = await import("hono");
    const { createUploadsRoutes } = await import("../routes/uploads.js");
    const app = new Hono().use("*", async (c, next) => { c.set("sessionUser", { id: "u", email: "uploader@example.test", name: "Uploader" } as never); await next(); })
      .route("/uploads", createUploadsRoutes());
    expect((await app.request(`/uploads/direct/sessions/${SESSION}?statusOnly=true&fileId=a`)).status).toBe(400);
  });
});
