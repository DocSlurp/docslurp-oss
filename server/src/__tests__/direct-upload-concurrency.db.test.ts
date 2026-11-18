import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Direct-upload finalization under real concurrency: the real routes and services against a real, migrated Postgres
 * with the real advisory-lock pool at its default size (5 per process: one batch, one run-start and one reconcile slot,
 * and 2 connections only short work may use). Object storage is an in-memory fake; intake runs through the in-memory project fakes so a run can be counted.
 * Opt-in: TEST_DATABASE_URL (a throwaway database; scripts/run-database-tests.mjs provides one per file).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const store = vi.hoisted(() => ({
  objects: new Map<string, { size: number; etag: string }>(),
  copies: 0,
  headDelayMs: 0,
  intakeDelayMs: 0,
  /** Storage calls on keys under this prefix stall until their signal aborts or `releaseStalls` runs. */
  stallPrefix: null as string | null,
  stalls: [] as Array<() => void>,
  ports: null as unknown,
}));
vi.mock("../lib/storage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/storage.js")>(),
  getUploadedObjectMetadata: async (key: string, signal?: AbortSignal) => {
    await stallFor(key, signal);
    if (store.headDelayMs) await new Promise(resolve => setTimeout(resolve, store.headDelayMs));
    const object = store.objects.get(key);
    if (!object) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return { contentLength: object.size, contentType: null, etag: object.etag };
  },
  copyUploadedObject: async (input: { fromKey: string; toKey: string; ifMatch?: string }) => {
    store.copies += 1;
    const source = store.objects.get(input.fromKey);
    if (!source || (input.ifMatch && source.etag !== input.ifMatch)) throw Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    store.objects.set(input.toKey, { ...source });
    return { etag: source.etag };
  },
  deleteUploadedObject: async (key: string) => { store.objects.delete(key); },
  abortMultipartUpload: async (args: { key: string; signal?: AbortSignal }) => { await stallFor(args.key, args.signal); },
  listMultipartUploadParts: async (args: { key: string; signal?: AbortSignal }) => { await stallFor(args.key, args.signal); return []; },
  signMultipartUploadPart: async () => "https://storage.example/part",
  signSingleUploadPut: async () => "https://storage.example/put",
}));
/** A stalled provider: waits until the caller's deadline aborts it, or until the test releases every stall. */
async function stallFor(key: string, signal?: AbortSignal): Promise<void> {
  if (!store.stallPrefix || !key.startsWith(store.stallPrefix)) return;
  await new Promise<void>((resolve, reject) => {
    store.stalls.push(resolve);
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), { once: true });
  });
}

// Every confirm path (the route, the kick, the sweep) runs intake through the same in-memory ports.
vi.mock("../services/project-intake.js", async importOriginal => {
  const original = await importOriginal<typeof import("../services/project-intake.js")>();
  return { ...original, get projectIntakePorts() { return store.ports; } };
});

describe.skipIf(!databaseUrl)("direct-upload finalization on real Postgres", () => {
  let sql: typeof import("../db.js").sql;
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let fakes: ReturnType<typeof import("./helpers/project-intake-fakes.js").createProjectIntakeFakes>;
  let stopReconciler: () => Promise<void>;
  let closeLocks: () => Promise<void>;
  let sessionCounter = 0;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    delete process.env.DOCSLURP_UPLOAD_LOCK_POOL_MAX;
    ({ sql } = await import("../db.js"));
    const { createProjectIntakeFakes, fakeProject } = await import("./helpers/project-intake-fakes.js");
    // The project exists in the database too: a replayed confirm re-authorizes it there.
    fakes = createProjectIntakeFakes({ projects: [fakeProject({ id: "upl-p", orgId: "upl-o", name: "Uploads", slug: "uploads" }), fakeProject({ id: "upl-p2", orgId: "upl-o2", name: "Uploads 2", slug: "uploads-2" })] });
    store.ports = fakes.ports;
    // Intake that takes a while, so the session lock is visibly held during a confirm.
    const createRun = fakes.ports.records.createRun.bind(fakes.ports.records);
    fakes.ports.records.createRun = (async (...args: Parameters<typeof createRun>) => {
      if (store.intakeDelayMs) await new Promise(resolve => setTimeout(resolve, store.intakeDelayMs));
      return createRun(...args);
    }) as typeof createRun;
    const { Hono } = await import("hono");
    const { createUploadsRoutes } = await import("../routes/uploads.js");
    app = new Hono().use("*", async (c, next) => { c.set("sessionUser", { id: c.req.header("x-test-user") ?? "upl-u", email: "u@example.test", name: "U" } as never); await next(); })
      .route("/uploads", createUploadsRoutes(fakes.ports));
    const reconciler = await import("../services/direct-upload-reconciler.js");
    reconciler.startDirectUploadReconciler();
    stopReconciler = reconciler.stopDirectUploadReconciler;
    closeLocks = (await import("../lib/direct-upload-locks.js")).closeDirectUploadLockPool;
    await sql`insert into "user" (id, name, email) values ('upl-u', 'Uploader', 'upl-u@example.test'), ('upl-v', 'Other', 'upl-v@example.test'), ('upl-w', 'Third', 'upl-w@example.test') on conflict do nothing`;
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('upl-o', 'Org', 'upl-o', 'upl-u'), ('upl-o2', 'Org 2', 'upl-o2', 'upl-v'), ('upl-o3', 'Org 3', 'upl-o3', 'upl-w') on conflict do nothing`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('upl-o', 'upl-u', 'owner'), ('upl-o2', 'upl-v', 'owner'), ('upl-o3', 'upl-w', 'owner') on conflict do nothing`;
    await sql`insert into projects (id, org_id, user_id, name) values ('upl-p', 'upl-o', 'upl-u', 'Uploads'), ('upl-p2', 'upl-o2', 'upl-v', 'Uploads 2') on conflict do nothing`;
  }, 60_000);

  afterAll(async () => {
    await stopReconciler?.();
    await closeLocks?.();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => {
    store.headDelayMs = 0; store.intakeDelayMs = 0; store.copies = 0;
    store.stallPrefix = null; for (const release of store.stalls.splice(0)) release();
  });

  /** A pending session of `count` single-part files whose bytes are already in storage. */
  async function seedSession(count: number, user = "upl-u", org = "upl-o", projectId: string | null = null): Promise<{ id: string; fileIds: string[] }> {
    sessionCounter += 1;
    const id = `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, "0")}`;
    await sql`insert into upload_sessions (id, user_id, org_id, project_id, status, next_reconcile_at) values (${id}, ${user}, ${org}, ${projectId}, 'pending', now() + interval '1 hour')`;
    const fileIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const fileId = `${id.slice(-6)}-f${i}`;
      const key = `${user}/${id}/raw/${fileId}-doc.txt`;
      await sql`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, status, request_index)
        values (${fileId}, ${id}, 'doc.txt', 'text/plain', 10, ${key}, 'single', 'pending', ${i})`;
      store.objects.set(key, { size: 10, etag: `"${fileId}"` });
      fileIds.push(fileId);
    }
    return { id, fileIds };
  }
  const post = async (path: string, body?: unknown, user = "upl-u") => await app.request(`/uploads/direct/sessions/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-user": user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const status = async (id: string) => (await sql<Array<{ status: string }>>`select status from upload_sessions where id = ${id}`)[0]!.status;

  it("a client's confirm racing the reconcile kick admits exactly one run", async () => {
    const { id, fileIds } = await seedSession(5, "upl-u", "upl-o", "upl-p");
    const runsBefore = fakes.runs.length;
    store.intakeDelayMs = 600;
    const completed = await post(`${id}/files/complete`, { files: fileIds.map(fileId => ({ fileId })) });
    expect(await completed.json()).toMatchObject({ ok: true, sessionComplete: true });
    // The kick starts its confirm one second after the last complete; the client confirms while it holds the session.
    await new Promise(resolve => setTimeout(resolve, 1_150));
    const confirm = await post(`${id}/confirm`);
    expect(confirm.status).toBeLessThan(300);
    const answer = await confirm.json() as { run: { id: string } };
    await vi.waitFor(async () => expect(await status(id)).toBe("confirmed"), { timeout: 5_000 });
    // One run, and the client's confirm answers with it (whichever of the two admitted it).
    expect(fakes.runs.length - runsBefore).toBe(1);
    expect(answer.run.id).toBe(fakes.runs.at(-1)!.id);
  }, 20_000);

  it("an abort racing a batch waits for the batch, then closes the session", async () => {
    const { id, fileIds } = await seedSession(16);
    store.headDelayMs = 60;
    const batch = post(`${id}/files/complete`, { files: fileIds.map(fileId => ({ fileId })) });
    await new Promise(resolve => setTimeout(resolve, 100));
    const started = Date.now();
    const abort = await post(`${id}/abort`);
    expect(abort.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThan(100);
    const batchResponse = await batch;
    expect(batchResponse.status).toBe(200);
    expect(await status(id)).toBe("aborted");
    // Nothing completes after the abort.
    const late = await post(`${id}/files/complete`, { files: [{ fileId: fileIds[0]! }] });
    expect(late.status).toBe(409);
  }, 20_000);

  it("repeating a batch whose response was lost changes nothing", async () => {
    const { id, fileIds } = await seedSession(4);
    await post(`${id}/files/complete`, { files: fileIds.map(fileId => ({ fileId })) }); // the answer is "lost"
    const keys = await sql<Array<{ id: string; source_key: string }>>`select id, source_key from upload_session_files where session_id = ${id} order by id`;
    const copies = store.copies;
    const repeat = await post(`${id}/files/complete`, { files: fileIds.map(fileId => ({ fileId })) });
    expect(await repeat.json()).toMatchObject({ ok: true, completedCount: 4 });
    expect(store.copies).toBe(copies);
    expect(await sql`select id, source_key from upload_session_files where session_id = ${id} order by id`).toEqual(keys);
  }, 20_000);

  it("with the batch slot held, another organization's batch is refused on schedule while short work still runs", async () => {
    // One slow batch fills the process's only batch slot at the default pool.
    const holder = await seedSession(30);
    const refusedSession = await seedSession(2, "upl-v", "upl-o2");
    const abortable = await seedSession(1, "upl-w", "upl-o3");
    store.headDelayMs = 400; // 30 files, 8 at a time, two HEADs each: the holder keeps its slot for a few seconds
    const holding = post(`${holder.id}/files/complete`, { files: holder.fileIds.map(fileId => ({ fileId })) });
    await new Promise(resolve => setTimeout(resolve, 200));
    const started = Date.now();
    const refused = await post(`${refusedSession.id}/files/complete`, { files: refusedSession.fileIds.map(fileId => ({ fileId })) }, "upl-v");
    const waited = Date.now() - started;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "upload_session_busy" } });
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(3_500);
    // A short operation (abort) gets one of the reserved connections at once.
    const shortStarted = Date.now();
    expect((await post(`${abortable.id}/abort`, undefined, "upl-w")).status).toBe(200);
    expect(Date.now() - shortStarted).toBeLessThan(1_000);
    expect((await holding).status).toBe(200);
  }, 30_000);

  it("many concurrent run starts from one organization never block another organization's abort or part signing", async () => {
    // Org A: six sessions ready to confirm, each with a slow run start.
    const sessions = [];
    for (let i = 0; i < 6; i++) {
      const seeded = await seedSession(1, "upl-u", "upl-o", "upl-p");
      expect((await post(`${seeded.id}/files/complete`, { files: [{ fileId: seeded.fileIds[0]! }] })).status).toBe(200);
      sessions.push(seeded);
    }
    // Org B: an open multipart file to sign parts for, and a session to abort.
    const signable = await seedSession(0, "upl-v", "upl-o2");
    await sql`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
      values (${`${signable.id.slice(-6)}-mp`}, ${signable.id}, 'big.pdf', 'application/pdf', ${20 * 1024 * 1024}, ${`upl-v/${signable.id}/raw/big.pdf`}, 'multipart', 'up-1', ${8 * 1024 * 1024}, 'pending')`;
    const abortable = await seedSession(1, "upl-v", "upl-o2");
    store.intakeDelayMs = 1_500;
    const confirms = sessions.map(session => post(`${session.id}/confirm`));
    await new Promise(resolve => setTimeout(resolve, 400));
    // Org A's starts hold (or wait for) the capped run-start slots; org B's short work answers at once.
    let started = Date.now();
    const signed = await post(`${signable.id}/files/${signable.id.slice(-6)}-mp/parts/sign`, { partNumbers: [1, 2] }, "upl-v");
    expect(signed.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    started = Date.now();
    expect((await post(`${abortable.id}/abort`, undefined, "upl-v")).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Each of org A's confirms either started its run or was told to repeat (its slot wait ran out): never a 5xx.
    for (const response of await Promise.all(confirms)) {
      if (response.status >= 300) expect(await response.json()).toMatchObject({ error: { code: "upload_session_busy" } });
      expect(response.status === 409 || response.status < 300).toBe(true);
    }
  }, 60_000);

  it("replays an idempotent session create whose response was lost, at the default pool", async () => {
    const create = () => app.request("/uploads/direct/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "upl-u", "idempotency-key": "lost-response-1" },
      body: JSON.stringify({ orgId: "upl-o", files: [{ filename: "notes.txt", mimeType: "text/plain", sizeBytes: 10 }] }),
    });
    const first = await create();
    expect(first.status).toBe(201);
    const { sessionId } = await first.json() as { sessionId: string };
    // The client never saw that answer and repeats the request: the same session comes back, not upload_session_busy.
    for (let i = 0; i < 3; i++) {
      const replay = await create();
      expect(replay.status).toBe(200);
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay.json()).toMatchObject({ sessionId });
    }
  }, 20_000);

  it("a stalled provider during one organization's many aborts and signings leaves another's signing and confirm served", async () => {
    // Org A: six sessions, each with an open multipart file; its provider calls stall.
    const orgA = [];
    for (let i = 0; i < 6; i++) {
      const seeded = await seedSession(0);
      const fileId = `${seeded.id.slice(-6)}-mp`;
      await sql`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
        values (${fileId}, ${seeded.id}, 'big.pdf', 'application/pdf', ${20 * 1024 * 1024}, ${`upl-u/${seeded.id}/raw/big.pdf`}, 'multipart', ${`up-${i}`}, ${8 * 1024 * 1024}, 'pending')`;
      orgA.push({ id: seeded.id, fileId });
    }
    // Org B: a file to sign parts for, and a finished session to confirm.
    const signable = await seedSession(0, "upl-v", "upl-o2");
    await sql`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status)
      values (${`${signable.id.slice(-6)}-mp`}, ${signable.id}, 'big.pdf', 'application/pdf', ${20 * 1024 * 1024}, ${`upl-v/${signable.id}/raw/big.pdf`}, 'multipart', 'up-b', ${8 * 1024 * 1024}, 'pending')`;
    const ready = await seedSession(1, "upl-v", "upl-o2", "upl-p2");
    expect((await post(`${ready.id}/files/complete`, { files: [{ fileId: ready.fileIds[0]! }] }, "upl-v")).status).toBe(200);
    store.stallPrefix = "upl-u/";
    const signings = orgA.map(session => post(`${session.id}/files/${session.fileId}/parts/sign`, { partNumbers: [1] }));
    const aborts = orgA.map(session => post(`${session.id}/abort`));
    await new Promise(resolve => setTimeout(resolve, 200));
    let started = Date.now();
    const signed = await post(`${signable.id}/files/${signable.id.slice(-6)}-mp/parts/sign`, { partNumbers: [1, 2] }, "upl-v");
    expect(signed.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_500);
    started = Date.now();
    const confirmed = await post(`${ready.id}/confirm`, undefined, "upl-v");
    expect(confirmed.status).toBeLessThan(300);
    expect(Date.now() - started).toBeLessThan(3_000);
    // Org A's aborts only change state under the lock: they answer promptly although the provider is stalled.
    // (or, behind the org's capped short slots, a retryable busy). Each one that answered 200 closed its session.
    const abortAnswers = await Promise.all(aborts);
    for (const [i, response] of abortAnswers.entries()) {
      expect([200, 409]).toContain(response.status);
      if (response.status === 200) expect(await status(orgA[i]!.id)).toBe("aborted");
    }
    expect(abortAnswers.some(response => response.status === 200)).toBe(true);
    // Its signings give up on their own budget or slot deadline: retryable answers, never a hang.
    for (const response of await Promise.all(signings)) expect([409, 503]).toContain(response.status);
    store.stallPrefix = null;
    for (const release of store.stalls.splice(0)) release();
  }, 30_000);
});
