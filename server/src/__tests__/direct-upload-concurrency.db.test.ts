import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Direct-upload finalization under real concurrency: the real routes and services against a real, migrated Postgres
 * with the real advisory-lock pool (DOCSLURP_UPLOAD_LOCK_POOL_MAX=3: one batch slot, one reconcile slot, one or more
 * short). Object storage is an in-memory fake; intake runs through the in-memory project fakes so a run can be counted.
 * Opt-in: TEST_DATABASE_URL (a throwaway database; scripts/run-database-tests.mjs provides one per file).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const store = vi.hoisted(() => ({
  objects: new Map<string, { size: number; etag: string }>(),
  copies: 0,
  headDelayMs: 0,
  intakeDelayMs: 0,
  ports: null as unknown,
}));
vi.mock("../lib/storage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/storage.js")>(),
  getUploadedObjectMetadata: async (key: string) => {
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
  abortMultipartUpload: async () => {},
}));
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
    process.env.DOCSLURP_UPLOAD_LOCK_POOL_MAX = "3";
    ({ sql } = await import("../db.js"));
    const { createProjectIntakeFakes, fakeProject } = await import("./helpers/project-intake-fakes.js");
    // The project exists in the database too: a replayed confirm re-authorizes it there.
    fakes = createProjectIntakeFakes({ projects: [fakeProject({ id: "upl-p", orgId: "upl-o", name: "Uploads", slug: "uploads" })] });
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
    await sql`insert into "user" (id, name, email) values ('upl-u', 'Uploader', 'upl-u@example.test'), ('upl-v', 'Other', 'upl-v@example.test') on conflict do nothing`;
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('upl-o', 'Org', 'upl-o', 'upl-u'), ('upl-o2', 'Org 2', 'upl-o2', 'upl-v') on conflict do nothing`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('upl-o', 'upl-u', 'owner'), ('upl-o2', 'upl-v', 'owner') on conflict do nothing`;
    await sql`insert into projects (id, org_id, user_id, name) values ('upl-p', 'upl-o', 'upl-u', 'Uploads') on conflict do nothing`;
  }, 60_000);

  afterAll(async () => {
    await stopReconciler?.();
    await closeLocks?.();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => { store.headDelayMs = 0; store.intakeDelayMs = 0; store.copies = 0; });

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

  it("a saturated lock pool refuses a second batch on schedule while short operations still run", async () => {
    const first = await seedSession(30);
    const second = await seedSession(2, "upl-v", "upl-o2");
    const third = await seedSession(1);
    store.headDelayMs = 400; // 30 files, 8 at a time: the first batch holds the only batch slot for a few seconds
    const holding = post(`${first.id}/files/complete`, { files: first.fileIds.map(fileId => ({ fileId })) });
    await new Promise(resolve => setTimeout(resolve, 150));
    const started = Date.now();
    const refused = await post(`${second.id}/files/complete`, { files: second.fileIds.map(fileId => ({ fileId })) }, "upl-v");
    const waited = Date.now() - started;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "upload_session_busy" } });
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(3_500);
    // A short operation (abort) gets a connection at once despite the held batch slot.
    const shortStarted = Date.now();
    expect((await post(`${third.id}/abort`)).status).toBe(200);
    expect(Date.now() - shortStarted).toBeLessThan(1_000);
    expect((await holding).status).toBe(200);
  }, 30_000);
});
