import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase } from "@docslurp/worker/testing";

// Webhook-driven per-file finalization and early ingestion in waves, against a database built from the full migration
// journal. Only the SQL transport, the session-lock connection, object storage and the intake ports (project and run
// records) are replaced; leases, wave selection, scoping and session state run their production queries.
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  lockHeld: false,
  objects: new Map<string, { size: number; etag: string }>(),
  /** Keys whose bytes are replaced between the HEAD that verified them and the sealing copy. */
  replacedBeforeCopy: new Set<string>(),
  copies: [] as Array<{ fromKey: string; toKey: string; ifMatch?: string }>,
  heads: [] as string[],
  /** Optional pause inside HEAD, to hold a finalizer mid-flight. */
  headGate: null as null | Promise<void>,
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
    if (mocks.headGate) await mocks.headGate;
    const object = mocks.objects.get(key);
    if (!object) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return { contentLength: object.size, etag: object.etag };
  },
  copyUploadedObject: async (input: { fromKey: string; toKey: string; ifMatch?: string }) => {
    mocks.copies.push(input);
    if (mocks.replacedBeforeCopy.has(input.fromKey)) {
      mocks.replacedBeforeCopy.delete(input.fromKey);
      mocks.objects.set(input.fromKey, { ...mocks.objects.get(input.fromKey)!, etag: "\"replaced\"" });
    }
    const source = mocks.objects.get(input.fromKey);
    if (!source || (input.ifMatch && source.etag !== input.ifMatch)) throw Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    mocks.objects.set(input.toKey, { ...source });
    return { etag: source.etag };
  },
  deleteUploadedObject: async (key: string) => { mocks.objects.delete(key); },
  abortMultipartUpload: async () => {},
}));

const { env } = await import("../config.js");
const { completeDirectUploadFiles, abortDirectUploadSession, getDirectUploadSessionDescription } = await import("../services/direct-upload-session.js");
const { advanceDirectUploadWaves, confirmDirectUploadProjectIntake, setDirectUploadWavePortsForTesting } = await import("../services/direct-upload-waves.js");
const { reconcileDirectUploads, reconcilePendingUploadFiles } = await import("../services/direct-upload-reconciler.js");
const { tigrisUploadWebhookRoutes, drainUploadWebhookFinalizations } = await import("../routes/tigris-upload-webhook.js");
const { RunCreationBlockedError } = await import("../services/run-creation.js");
const { createProjectIntakeFakes } = await import("./helpers/project-intake-fakes.js");

const SECRET = "test-webhook-secret";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let fakes: ReturnType<typeof createProjectIntakeFakes>;
const saved = { files: env.directUploadWaveFiles, delay: env.directUploadWaveDelayMs, grace: env.directUploadFinalizeGraceSeconds };

/** Intake fakes whose runs carry the run id waves choose, and whose new projects exist in the database (access checks). */
function installFakes() {
  fakes = createProjectIntakeFakes();
  const { createRun, createProject } = fakes.ports.records;
  fakes.ports.records.createRun = async args => {
    const created = await createRun(args);
    return { ...created, run: { ...created.run, id: args.runId! } };
  };
  fakes.ports.records.createProject = async args => {
    const project = await createProject({ ...args, orgId: args.orgId ?? "o" });
    await db.query("insert into projects (id, org_id, user_id, name) values ($1, $2, 'u', $3) on conflict do nothing", [project.id, project.orgId, project.name]);
    return project;
  };
  setDirectUploadWavePortsForTesting(fakes.ports);
}

type Seeded = { sessionId: string; files: Array<{ id: string; key: string }> };

async function seedSession(count: number, options: { userId?: string; orgId?: string; projectName?: string | null; newProject?: boolean } = {}): Promise<Seeded> {
  const userId = options.userId ?? "u";
  const sessionId = randomUUID();
  await db.query(`insert into upload_sessions (id, user_id, org_id, project_name, status, next_reconcile_at, expires_at)
    values ($1, $2, $3, $4, 'pending', now() + interval '1 hour', now() + interval '1 day')`, [sessionId, userId, options.orgId ?? "o", options.projectName ?? null]);
  const files = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), key: `${userId}/${randomUUID()}/raw/${randomUUID()}-doc-${index}.pdf` }));
  for (let start = 0; start < files.length; start += 500) {
    const values: unknown[] = [];
    const rows = files.slice(start, start + 500).map((file, offset) => {
      values.push(file.id, sessionId, `doc-${start + offset}.pdf`, file.key, start + offset);
      const base = offset * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, 'application/pdf', 10, $${base + 4}, 'single', 'pending', $${base + 5}, now() + interval '1 hour')`;
    });
    await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, status, request_index, next_check_at) values ${rows.join(", ")}`, values);
  }
  return { sessionId, files };
}

function put(key: string, size = 10, etag = `"${randomUUID()}"`) { mocks.objects.set(key, { size, etag }); }

async function webhook(keys: string[], token = SECRET, extra: Record<string, unknown> = {}) {
  const response = await tigrisUploadWebhookRoutes.request("/tigris/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: keys.map(key => ({ eventVersion: "1", eventSource: "tigris", eventName: "OBJECT_CREATED_PUT", bucket: env.s3Bucket, object: { key, ...extra } })) }),
  });
  await drainUploadWebhookFinalizations();
  return response;
}

async function files(sessionId: string) {
  return (await db.query<{ id: string; status: string; run_id: string | null; source_key: string; finalize_error: unknown }>(
    "select id, status, run_id, source_key, finalize_error from upload_session_files where session_id = $1 order by request_index", [sessionId])).rows;
}
async function runs(sessionId: string) {
  return (await db.query<{ wave: number; run_id: string; status: string; file_count: number }>(
    "select wave, run_id, status, file_count from upload_session_runs where session_id = $1 order by wave", [sessionId])).rows;
}
async function session(sessionId: string) {
  return (await db.query<{ status: string; project_id: string | null; result: unknown; last_error: string | null; blocked: boolean }>(
    "select status, project_id, result, last_error, coalesce(wave_blocked_until > now(), false) as blocked from upload_sessions where id = $1", [sessionId])).rows[0]!;
}
/** What the reconciler's sweep and wave timers do for one session, until nothing more is due now. */
async function advance(sessionId: string) { return await advanceDirectUploadWaves(sessionId, (await db.query<{ user_id: string }>("select user_id from upload_sessions where id = $1", [sessionId])).rows[0]!.user_id); }

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user" (id,name,email) values ('u','Uploader','uploader@example.test'), ('other','Other','other@example.test');
    insert into organizations (id,name,slug,created_by_user_id) values ('o','Org','waves','u'), ('o2','Other org','waves-2','other');
    insert into org_memberships (org_id,user_id,role) values ('o','u','owner'), ('o2','other','owner');
  `);
  mocks.query.mockImplementation((text: string, values: unknown[]) => db.query(text, values));
}, 120_000);
afterAll(async () => {
  setDirectUploadWavePortsForTesting(null);
  Object.assign(env, { directUploadWaveFiles: saved.files, directUploadWaveDelayMs: saved.delay, directUploadFinalizeGraceSeconds: saved.grace });
  await db?.close();
});
beforeEach(async () => {
  process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET = SECRET;
  Object.assign(env, { directUploadWaveFiles: 5, directUploadWaveDelayMs: 10_000, directUploadFinalizeGraceSeconds: 60 });
  mocks.lockHeld = false;
  mocks.objects.clear();
  mocks.replacedBeforeCopy.clear();
  mocks.copies.length = 0;
  mocks.heads.length = 0;
  mocks.headGate = null;
  installFakes();
  await db.exec(`delete from upload_session_runs; delete from upload_session_files; delete from upload_sessions; delete from storage_cleanup_queue;
    delete from upload_cleanup_owners; delete from projects;
    insert into org_memberships (org_id,user_id,role) values ('o','u','owner') on conflict do nothing;`);
});

describe("webhook-driven finalization", () => {
  it("finalizes exactly the file a key names, from storage's evidence, and starts a run once five are waiting", async () => {
    const { sessionId, files: seeded } = await seedSession(7, { projectName: null });
    for (const file of seeded) put(file.key);
    for (const file of seeded.slice(0, 4)) expect((await webhook([file.key])).status).toBe(200);
    // Four finalized and sealed, none in a run: below the wave size and inside the wave delay.
    let rows = await files(sessionId);
    expect(rows.filter(row => row.status === "completed")).toHaveLength(4);
    expect(rows.slice(0, 4).every(row => row.source_key.includes("/sealed-"))).toBe(true);
    expect(await advance(sessionId)).toMatchObject({ nextCheckMs: expect.any(Number) });
    expect(await runs(sessionId)).toEqual([]);

    await webhook([seeded[4]!.key]);
    await advance(sessionId);
    const [first] = await runs(sessionId);
    // Wave 1 takes the five waiting files; its run id is the session id, so `result` keeps meaning the first run.
    expect(first).toMatchObject({ wave: 1, run_id: sessionId, status: "started", file_count: 5 });
    rows = await files(sessionId);
    expect(rows.slice(0, 5).every(row => row.run_id === sessionId)).toBe(true);
    expect((await session(sessionId)).status).toBe("pending");

    // The last two files: the final wave goes to the same project, and the session is confirmed.
    await webhook(seeded.slice(5).map(file => file.key));
    await advance(sessionId);
    const all = await runs(sessionId);
    expect(all.map(run => [run.wave, run.file_count])).toEqual([[1, 5], [2, 2]]);
    expect(new Set(fakes.runs.map(run => run.projectId)).size).toBe(1);
    // The project was created (and self-titled) once, by the first wave.
    expect(fakes.createdProjects).toHaveLength(1);
    const final = await session(sessionId);
    expect(final).toMatchObject({ status: "confirmed", project_id: fakes.runs[0]!.projectId });
    expect((final.result as { payload: { run: { id: string } } }).payload.run.id).toBe(sessionId);
    // Every file is in exactly one run.
    rows = await files(sessionId);
    expect(rows.every(row => row.run_id !== null)).toBe(true);
    expect(fakes.runs.flatMap(run => run.files.map(file => file.sourceKey)).sort()).toEqual(rows.map(row => row.source_key).sort());
    // The status read lists both runs and each file's run.
    const described = await getDirectUploadSessionDescription(sessionId, "u", true);
    expect(described?.runs.map(run => [run.wave, run.fileCount, run.status])).toEqual([[1, 5, "started"], [2, 2, "started"]]);
    expect(described?.files.every(file => "runId" in file && file.runId)).toBe(true);
  });

  it("starts a wave below the wave size once the first waiting file has waited the wave delay", async () => {
    Object.assign(env, { directUploadWaveFiles: 100, directUploadWaveDelayMs: 80 });
    const { sessionId, files: seeded } = await seedSession(3);
    for (const file of seeded.slice(0, 2)) put(file.key);
    await webhook(seeded.slice(0, 2).map(file => file.key));
    const outcome = await advance(sessionId);
    expect(outcome.nextCheckMs).toBeGreaterThan(0);
    expect(await runs(sessionId)).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 100));
    await advance(sessionId);
    expect(await runs(sessionId)).toEqual([expect.objectContaining({ wave: 1, file_count: 2 })]);
  });

  it("refuses an unauthenticated or forged notification and touches nothing", async () => {
    const { sessionId, files: seeded } = await seedSession(1);
    put(seeded[0]!.key);
    expect((await webhook([seeded[0]!.key], "wrong-secret")).status).toBe(401);
    const unsigned = await tigrisUploadWebhookRoutes.request("/tigris/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(unsigned.status).toBe(401);
    delete process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET;
    expect((await webhook([seeded[0]!.key])).status).toBe(503);
    expect(mocks.heads).toEqual([]);
    expect((await files(sessionId))[0]!.status).toBe("pending");
  });

  it("finalizes only the file the key maps to: another organization's key never touches this session", async () => {
    const mine = await seedSession(1);
    const theirs = await seedSession(1, { userId: "other", orgId: "o2" });
    put(mine.files[0]!.key);
    put(theirs.files[0]!.key);
    // Fields beyond the key (a claimed size, owner or session) are ignored.
    await webhook([theirs.files[0]!.key], SECRET, { size: 1, sessionId: mine.sessionId, userIdentity: "u" });
    expect((await files(theirs.sessionId))[0]!.status).toBe("completed");
    expect((await files(mine.sessionId))[0]!.status).toBe("pending");
    expect(mocks.heads).not.toContain(mine.files[0]!.key);
  });

  it("refuses keys outside the upload prefixes and ignores unknown keys", async () => {
    const { sessionId, files: seeded } = await seedSession(1);
    put(seeded[0]!.key);
    // A key outside the session's own user prefix, even if a row named it, is not an upload key of that session.
    await db.query("update upload_session_files set source_key = $1 where id = $2", [`other/${randomUUID()}/raw/${randomUUID()}-doc.pdf`, seeded[0]!.id]);
    const moved = (await files(sessionId))[0]!.source_key;
    put(moved);
    const sealed = `u/${randomUUID()}/raw/sealed-${seeded[0]!.id}-doc.pdf`;
    for (const key of [moved, sealed, "artifacts/o/run/page-1.png", `u/${randomUUID()}/raw/${randomUUID()}-never-declared.pdf`]) {
      expect((await webhook([key])).status).toBe(200);
    }
    expect(mocks.heads).toEqual([]);
    expect((await files(sessionId))[0]!.status).toBe("pending");
  });

  it("makes a duplicate event harmless", async () => {
    const { sessionId, files: seeded } = await seedSession(1);
    put(seeded[0]!.key);
    await Promise.all([webhook([seeded[0]!.key, seeded[0]!.key]), webhook([seeded[0]!.key])]);
    await webhook([seeded[0]!.key]);
    expect(mocks.copies).toHaveLength(1);
    expect((await files(sessionId))[0]!.status).toBe("completed");
    await advance(sessionId);
    await advance(sessionId);
    expect(await runs(sessionId)).toHaveLength(1);
  });

  it("never publishes an object replaced between the event and the seal, and seals the new version on its own event", async () => {
    const { sessionId, files: seeded } = await seedSession(1);
    put(seeded[0]!.key, 10, "\"v1\"");
    mocks.replacedBeforeCopy.add(seeded[0]!.key);
    await webhook([seeded[0]!.key]);
    let [row] = await files(sessionId);
    expect(row).toMatchObject({ status: "pending", run_id: null });
    expect([...mocks.objects.keys()].some(key => key.includes("/sealed-"))).toBe(false);
    // The replacing PUT sends its own event: storage's current version is verified and sealed.
    await webhook([seeded[0]!.key]);
    [row] = await files(sessionId);
    expect(row!.status).toBe("completed");
    expect(mocks.copies.at(-1)).toMatchObject({ ifMatch: "\"replaced\"" });
  });

  it("lets a client complete race a webhook finalize of the same file: one seal, both succeed", async () => {
    const { sessionId, files: seeded } = await seedSession(2);
    for (const file of seeded) put(file.key);
    let open!: () => void;
    mocks.headGate = new Promise<void>(resolve => { open = resolve; });
    const hook = webhook([seeded[0]!.key]);
    await vi.waitFor(() => expect(mocks.heads).toContain(seeded[0]!.key));
    const client = completeDirectUploadFiles({ sessionId, userId: "u", files: [{ fileId: seeded[0]!.id }, { fileId: seeded[1]!.id }] });
    setTimeout(() => open(), 50);
    const [result] = await Promise.all([client, hook]);
    expect(result.files.map(file => file.status)).toEqual(["completed", "completed"]);
    expect(mocks.copies.filter(copy => copy.fromKey === seeded[0]!.key)).toHaveLength(1);
    expect((await files(sessionId)).every(row => row.status === "completed")).toBe(true);
  });
});

describe("waves", () => {
  it("confirm flushes the finalized files below the wave size and reports every run", async () => {
    const { sessionId, files: seeded } = await seedSession(4);
    for (const file of seeded.slice(0, 2)) put(file.key);
    await webhook(seeded.slice(0, 2).map(file => file.key));
    const first = await confirmDirectUploadProjectIntake({ sessionId, userId: "u" }, fakes.ports);
    expect(first.payload).toMatchObject({ run: { id: sessionId }, sessionStatus: "pending", pendingFileCount: 2, runs: [expect.objectContaining({ wave: 1, fileCount: 2 })] });
    for (const file of seeded.slice(2)) put(file.key);
    await webhook(seeded.slice(2).map(file => file.key));
    const second = await confirmDirectUploadProjectIntake({ sessionId, userId: "u" }, fakes.ports);
    expect(second.payload.runs.map(run => run.fileCount)).toEqual([2, 2]);
    expect(second.payload).toMatchObject({ sessionStatus: "confirmed", pendingFileCount: 0, run: { id: sessionId } });
    // Replayed after confirmation: the same runs, no new one.
    const again = await confirmDirectUploadProjectIntake({ sessionId, userId: "u" }, fakes.ports);
    expect(again.payload.runs).toHaveLength(2);
    expect(fakes.runs).toHaveLength(2);
  });

  it("answers a confirm with nothing finalized as before: incomplete files", async () => {
    const { sessionId } = await seedSession(2);
    await expect(confirmDirectUploadProjectIntake({ sessionId, userId: "u" }, fakes.ports)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("incomplete") });
  });

  it("an abort during waves stops later waves and leaves started runs and their files alone", async () => {
    const { sessionId, files: seeded } = await seedSession(8);
    for (const file of seeded) put(file.key);
    await webhook(seeded.slice(0, 5).map(file => file.key));
    await advance(sessionId);
    expect(await runs(sessionId)).toHaveLength(1);
    await webhook([seeded[5]!.key]);
    expect(await abortDirectUploadSession(sessionId, "u")).toBe(true);
    // Later events and sweeps do nothing for an aborted session.
    await webhook(seeded.slice(6).map(file => file.key));
    await advance(sessionId);
    expect(await runs(sessionId)).toHaveLength(1);
    const rows = await files(sessionId);
    expect(rows.slice(0, 5).every(row => row.status === "completed" && row.run_id === sessionId)).toBe(true);
    expect(rows.slice(5).every(row => row.status === "aborted" && row.run_id === null)).toBe(true);
    expect((await session(sessionId)).status).toBe("aborted");
    // Cleanup names only files no run took: the started run's sealed sources are never deleted.
    const queued = (await db.query<{ artifact_uris: string[] }>("select artifact_uris from storage_cleanup_queue where kind = 'storage_prefix'")).rows[0]!;
    expect(queued.artifact_uris.sort()).toEqual(rows.slice(5).map(row => row.source_key).sort());
  });

  it("a budget refused for wave 2 after wave 1 started: wave 1 stays, wave 2's files wait, then start once allowed", async () => {
    const { sessionId, files: seeded } = await seedSession(11);
    for (const file of seeded) put(file.key);
    await webhook(seeded.slice(0, 5).map(file => file.key));
    await advance(sessionId);
    fakes.state.blockRunCreation = new RunCreationBlockedError("This project has reached its monthly budget cap", 402, "project_budget_paused");
    await webhook(seeded.slice(5, 10).map(file => file.key));
    await expect(advance(sessionId)).rejects.toMatchObject({ code: "project_budget_paused" });
    expect((await runs(sessionId)).map(run => run.wave)).toEqual([1]);
    let rows = await files(sessionId);
    expect(rows.slice(5, 10).every(row => row.status === "completed" && row.run_id === null)).toBe(true);
    expect(await session(sessionId)).toMatchObject({ status: "pending", blocked: true, last_error: expect.stringContaining("project_budget_paused") });
    // While paused, the sweep does not retry; a confirm does, and still answers the started runs with a warning.
    expect((await advance(sessionId)).nextCheckMs).toBeGreaterThan(0);
    expect(fakes.runs).toHaveLength(1);
    const flushed = await confirmDirectUploadProjectIntake({ sessionId, userId: "u" }, fakes.ports);
    expect(flushed.payload.runs).toHaveLength(1);
    expect(flushed.payload.warnings.join(" ")).toContain("monthly budget cap");
    // Allowed again: the waiting files and the last one start (no file twice), and the session finishes.
    fakes.state.blockRunCreation = null;
    await db.query("update upload_sessions set wave_blocked_until = null where id = $1", [sessionId]);
    await webhook([seeded[10]!.key]);
    await advance(sessionId);
    rows = await files(sessionId);
    expect(rows.every(row => row.run_id !== null)).toBe(true);
    const ingested = fakes.runs.flatMap(run => run.files.map(file => file.sourceKey));
    expect(ingested).toHaveLength(11);
    expect(new Set(ingested).size).toBe(11);
    expect((await session(sessionId)).status).toBe("confirmed");
  });

  it("stops starting runs once the uploader loses access, leaving the started run alone", async () => {
    const { sessionId, files: seeded } = await seedSession(10);
    for (const file of seeded) put(file.key);
    await webhook(seeded.slice(0, 5).map(file => file.key));
    await advance(sessionId);
    await db.exec("delete from org_memberships where org_id = 'o' and user_id = 'u'");
    await webhook(seeded.slice(5).map(file => file.key));
    await expect(advance(sessionId)).rejects.toMatchObject({ statusCode: 403 });
    expect(await runs(sessionId)).toHaveLength(1);
    expect((await session(sessionId)).status).toBe("failed");
    expect(fakes.runs).toHaveLength(1);
  });

  it("fails only the files a wave could not read, and confirms with the rest", async () => {
    Object.assign(env, { directUploadWaveFiles: 2 });
    const { sessionId, files: seeded } = await seedSession(4);
    for (const file of seeded) put(file.key);
    fakes.state.unreadable.add("doc-0.pdf");
    fakes.state.unreadable.add("doc-1.pdf");
    await webhook(seeded.slice(0, 2).map(file => file.key));
    await advance(sessionId);
    let rows = await files(sessionId);
    expect(rows.slice(0, 2).map(row => row.status)).toEqual(["failed", "failed"]);
    expect(rows[0]!.finalize_error).toMatchObject({ code: "unreadable_source" });
    await webhook(seeded.slice(2).map(file => file.key));
    await advance(sessionId);
    rows = await files(sessionId);
    expect(rows.slice(2).every(row => row.run_id === sessionId)).toBe(true);
    expect((await session(sessionId)).status).toBe("confirmed");
    const described = await getDirectUploadSessionDescription(sessionId, "u", true);
    expect(described?.files[0]).toMatchObject({ status: "failed", error: { code: "unreadable_source" } });
  });

  it("recovers a wave whose holder died before its run existed: the files are released and taken again", async () => {
    const { sessionId, files: seeded } = await seedSession(2);
    for (const file of seeded) put(file.key);
    await webhook(seeded.map(file => file.key));
    await db.query("insert into upload_session_runs (session_id, wave, run_id, status, file_count) values ($1, 1, $1, 'creating', 2)", [sessionId]);
    await db.query("update upload_session_files set run_id = $1 where session_id = $1", [sessionId]);
    await advance(sessionId);
    expect(await runs(sessionId)).toEqual([expect.objectContaining({ wave: 1, status: "started", file_count: 2 })]);
    expect(fakes.runs).toHaveLength(1);
  });

  it("re-authorizes a confirmed session's replay: a revoked membership or API key gets 403, not the runs", async () => {
    const { sessionId, files: seeded } = await seedSession(1);
    put(seeded[0]!.key);
    await webhook([seeded[0]!.key]);
    await advance(sessionId);
    expect((await session(sessionId)).status).toBe("confirmed");
    await db.exec("delete from org_memberships where org_id = 'o' and user_id = 'u'");
    await expect(confirmDirectUploadProjectIntake({ sessionId, userId: "u" }, fakes.ports)).rejects.toMatchObject({ statusCode: 403 });
    await db.exec("insert into org_memberships (org_id,user_id,role) values ('o','u','owner')");
    await db.query("update upload_sessions set api_key_id = 'revoked-key' where id = $1", [sessionId]);
    await expect(confirmDirectUploadProjectIntake({ sessionId, userId: "u" }, fakes.ports)).rejects.toMatchObject({ statusCode: 403 });
    // Another user never sees the session at all.
    await expect(confirmDirectUploadProjectIntake({ sessionId, userId: "other" }, fakes.ports)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rolls back a project the first wave created when its run fails, and creates it once on the retry", async () => {
    const { sessionId, files: seeded } = await seedSession(1);
    put(seeded[0]!.key);
    await webhook([seeded[0]!.key]);
    fakes.state.blockRunCreation = new Error("database restarted");
    await expect(advance(sessionId)).rejects.toThrow("database restarted");
    expect(fakes.discardedProjects).toHaveLength(1);
    expect(await session(sessionId)).toMatchObject({ status: "pending", project_id: null });
    expect((await files(sessionId))[0]!.run_id).toBeNull();
    expect(await runs(sessionId)).toEqual([]);
    fakes.state.blockRunCreation = null;
    await advance(sessionId);
    expect(await session(sessionId)).toMatchObject({ status: "confirmed", project_id: fakes.runs[0]!.projectId });
    expect(fakes.runs).toHaveLength(1);
  });

  it("a held session lock is answered busy without touching the session", async () => {
    const { sessionId, files: seeded } = await seedSession(5);
    for (const file of seeded) put(file.key);
    await webhook(seeded.map(file => file.key));
    mocks.lockHeld = true;
    await expect(advance(sessionId)).rejects.toMatchObject({ statusCode: 409, code: "upload_session_busy" });
    // Finalizing never needed the session lock.
    expect((await files(sessionId)).every(row => row.status === "completed")).toBe(true);
    expect(await runs(sessionId)).toEqual([]);
  });
});

describe("reconciler fallback", () => {
  it("finishes 1,000 files whose webhooks were all lost: every file in exactly one run", async () => {
    Object.assign(env, { directUploadWaveFiles: 100 });
    const { sessionId, files: seeded } = await seedSession(1000);
    for (const file of seeded) put(file.key);
    // Inside the grace period the fallback leaves files alone.
    expect(await reconcilePendingUploadFiles()).toBe(0);
    await db.query("update upload_session_files set next_check_at = now() where session_id = $1", [sessionId]);
    let checked = 0;
    for (let pass = 0; pass < 20 && (await files(sessionId)).some(row => row.status === "pending"); pass += 1) {
      checked += await reconcilePendingUploadFiles({ budgetMs: 60_000 });
    }
    expect(checked).toBe(1000);
    await db.query("update upload_sessions set next_reconcile_at = now() where id = $1", [sessionId]);
    await reconcileDirectUploads();
    const rows = await files(sessionId);
    expect(rows.every(row => row.status === "completed" && row.run_id)).toBe(true);
    const ingested = fakes.runs.flatMap(run => run.files.map(file => file.sourceKey));
    expect(ingested).toHaveLength(1000);
    expect(new Set(ingested).size).toBe(1000);
    expect((await session(sessionId)).status).toBe("confirmed");
    expect(mocks.copies).toHaveLength(1000);
  }, 120_000);

  it("leaves a session whose client is completing its files to the client until the hold lapses", async () => {
    const { sessionId, files: seeded } = await seedSession(2);
    for (const file of seeded) put(file.key);
    await completeDirectUploadFiles({ sessionId, userId: "u", files: [{ fileId: seeded[0]!.id }] });
    await db.query("update upload_session_files set next_check_at = now() where session_id = $1", [sessionId]);
    expect(await reconcilePendingUploadFiles()).toBe(0);
    await db.query("update upload_sessions set client_finalizing_until = now() - interval '1 second' where id = $1", [sessionId]);
    expect(await reconcilePendingUploadFiles()).toBe(1);
    expect((await files(sessionId)).every(row => row.status === "completed")).toBe(true);
  });
});
