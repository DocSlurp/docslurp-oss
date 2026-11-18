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
  heads: [] as string[],
  advance: vi.fn(),
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
    const outage = mocks.copyOutages.get(input.fromKey) ?? 0;
    if (outage > 0) {
      mocks.copyOutages.set(input.fromKey, outage - 1);
      throw Object.assign(new Error("The specified bucket does not exist"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
    }
    if (mocks.replacedBeforeCopy.has(input.fromKey)) mocks.objects.set(input.fromKey, { ...mocks.objects.get(input.fromKey)!, etag: "\"replaced\"" });
    const source = mocks.objects.get(input.fromKey);
    if (!source || (input.ifMatch && source.etag !== input.ifMatch)) throw Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    mocks.objects.set(input.toKey, { ...source });
    return { etag: source.etag };
  },
  deleteUploadedObject: async (key: string) => { mocks.objects.delete(key); },
  abortMultipartUpload: async () => {},
}));
// Waves have their own suite (direct-upload-waves.db.test.ts); here only whether the sweep asks for them.
vi.mock("../services/direct-upload-waves.js", () => ({ advanceDirectUploadWaves: mocks.advance, WAVE_BLOCKED_RETRY_SECONDS: 60 }));

const { completeDirectUploadFiles, completeDirectUploadFile, abortDirectUploadSession, CLIENT_FINALIZING_HOLD_SECONDS } = await import("../services/direct-upload-session.js");
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
  mocks.heads.length = 0;
  mocks.advance.mockReset().mockResolvedValue({ nextCheckMs: null });
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

  it("completes files while another holder (a wave, an abort) has the session lock: files have their own leases", async () => {
    await seedFile(SESSION, "good", { size: 10, etag: "\"a\"" });
    mocks.lockHeld = true;
    const result = await completeDirectUploadFiles({ sessionId: SESSION, userId: "u", files: [{ fileId: "good" }] });
    expect(result).toMatchObject({ completedCount: 1, sessionComplete: true });
    expect((await fileRow("good")).status).toBe("completed");
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

describe("fallback reconciler while a client completes files", () => {
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

    // The client went away: the hold lapses, the fallback finalizes the rest, and the session's waves are checked.
    await db.query(`update upload_sessions set client_finalizing_until = now() - interval '1 second', next_reconcile_at = now() - interval '1 second' where id = $1`, [SESSION]);
    await reconcileDirectUploads();
    expect((await fileRow("b")).status).toBe("completed");
    expect(mocks.advance).toHaveBeenCalledWith(SESSION, "u");
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
    expect(mocks.advance).toHaveBeenCalledOnce();
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
