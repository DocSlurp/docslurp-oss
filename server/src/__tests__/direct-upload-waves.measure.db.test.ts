import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase } from "@docslurp/worker/testing";

// LOCAL MEASUREMENT, skipped unless DOCSLURP_MEASURE_UPLOAD_WAVES=1. Time from the last PUT to the first and the last
// run created, for a direct upload whose files are announced by the storage webhook (no client complete calls) or
// completed by a CLI-style client (batches of 100 as PUTs finish, then confirm; no webhook), on
// PGlite with a fake object store and fake intake records. Simulated latencies (identical in the comparison run against
// the base branch): client PUT 20 ms with 8 in flight, storage HEAD 5 ms, sealing copy 15 ms, run creation 50 ms plus
// 0.5 ms per file. This measures the orchestration (finalize, waves, scheduling), not real storage or workflow start.
const MEASURE = process.env.DOCSLURP_MEASURE_UPLOAD_WAVES === "1";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const mocks = vi.hoisted(() => ({ query: vi.fn(), objects: new Map<string, { size: number; etag: string }>() }));
vi.mock("../db.js", () => ({ sql: Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, "");
    return { then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      mocks.query(text, values).then((result: { rows: unknown[] }) => result.rows).then(resolve, reject) };
  }, { json: (value: unknown) => JSON.stringify(value), array: (value: unknown) => value }) }));
vi.mock("../lib/direct-upload-locks.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/direct-upload-locks.js")>(),
  reserveDirectUploadLockConnection: async () => ({
    connection: async (strings: TemplateStringsArray) => strings.join("").includes("pg_try_advisory_lock") ? [{ acquired: true }] : [],
    release: () => {},
  }),
}));
vi.mock("../lib/storage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/storage.js")>(),
  getUploadedObjectMetadata: async (key: string) => {
    await delay(5);
    const object = mocks.objects.get(key);
    if (!object) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return { contentLength: object.size, etag: object.etag };
  },
  copyUploadedObject: async (input: { fromKey: string; toKey: string; ifMatch?: string }) => {
    await delay(15);
    const source = mocks.objects.get(input.fromKey)!;
    mocks.objects.set(input.toKey, { ...source });
    return { etag: source.etag };
  },
  deleteUploadedObject: async (key: string) => { mocks.objects.delete(key); },
  abortMultipartUpload: async () => {},
}));

const { env } = await import("../config.js");
const { confirmDirectUploadProjectIntake, setDirectUploadWavePortsForTesting } = await import("../services/direct-upload-waves.js");
const { completeDirectUploadFiles } = await import("../services/direct-upload-session.js");
const { startDirectUploadReconciler, stopDirectUploadReconciler } = await import("../services/direct-upload-reconciler.js");
const { tigrisUploadWebhookRoutes } = await import("../routes/tigris-upload-webhook.js");
const { createProjectIntakeFakes } = await import("./helpers/project-intake-fakes.js");

let db: Awaited<ReturnType<typeof createMigratedDatabase>>;

beforeAll(async () => {
  if (!MEASURE) return;
  db = await createMigratedDatabase();
  await db.exec(`insert into "user" (id,name,email) values ('u','Uploader','uploader@example.test');
    insert into organizations (id,name,slug,created_by_user_id) values ('o','Org','measure','u');
    insert into org_memberships (org_id,user_id,role) values ('o','u','owner');`);
  mocks.query.mockImplementation((text: string, values: unknown[]) => db.query(text, values));
  process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET = "measure";
}, 120_000);
afterAll(async () => { await stopDirectUploadReconciler(); setDirectUploadWavePortsForTesting(null); await db?.close(); });

async function measure(count: number, mode: "webhook" | "client" = "webhook") {
  const fakes = createProjectIntakeFakes();
  const created: number[] = [];
  const { createRun, createProject } = fakes.ports.records;
  fakes.ports.records.createRun = async args => {
    await delay(50 + args.files.length * 0.5);
    created.push(Date.now());
    const result = await createRun(args);
    return { ...result, run: { ...result.run, id: args.runId! } };
  };
  fakes.ports.records.createProject = async args => {
    const project = await createProject({ ...args, orgId: "o" });
    await db.query("insert into projects (id, org_id, user_id, name) values ($1, 'o', 'u', $2) on conflict do nothing", [project.id, project.name]);
    return project;
  };
  setDirectUploadWavePortsForTesting(fakes.ports);
  const sessionId = randomUUID();
  await db.query(`insert into upload_sessions (id, user_id, org_id, status, next_reconcile_at, expires_at)
    values ($1, 'u', 'o', 'pending', now() + interval '1 hour', now() + interval '1 day')`, [sessionId]);
  const keys = Array.from({ length: count }, () => `u/${randomUUID()}/raw/${randomUUID()}-doc.pdf`);
  const ids = keys.map(() => randomUUID());
  for (let start = 0; start < count; start += 500) {
    const values: unknown[] = [];
    const rows = keys.slice(start, start + 500).map((key, offset) => {
      values.push(ids[start + offset], sessionId, key, start + offset);
      const base = offset * 4;
      return `($${base + 1}, $${base + 2}, 'doc.pdf', 'application/pdf', 10, $${base + 3}, 'single', 'pending', $${base + 4}, now() + interval '1 hour')`;
    });
    await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, status, request_index, next_check_at) values ${rows.join(", ")}`, values);
  }
  // The client: 8 PUTs in flight. With notifications, storage announces each object as it lands; without, a CLI-style
  // client completes each 100 files as their PUTs finish, then confirms.
  let next = 0;
  let lastPut = 0;
  const pending: Array<Promise<unknown>> = [];
  const batch: string[] = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < count) {
      const index = next++;
      const key = keys[index]!;
      await delay(20);
      mocks.objects.set(key, { size: 10, etag: `"${randomUUID()}"` });
      lastPut = Date.now();
      if (mode === "client") {
        batch.push(ids[index]!);
        if (batch.length === 100) pending.push(completeDirectUploadFiles({ sessionId, userId: "u", files: batch.splice(0).map(fileId => ({ fileId })) }));
        continue;
      }
      pending.push(Promise.resolve(tigrisUploadWebhookRoutes.request("/tigris/uploads", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer measure" },
        body: JSON.stringify({ events: [{ eventVersion: "1", eventSource: "tigris", eventName: "OBJECT_CREATED_PUT", bucket: env.s3Bucket, object: { key } }] }),
      })));
    }
  }));
  if (batch.length) pending.push(completeDirectUploadFiles({ sessionId, userId: "u", files: batch.splice(0).map(fileId => ({ fileId })) }));
  await Promise.all(pending);
  if (mode === "client") await confirmDirectUploadProjectIntake({ sessionId, userId: "u", lockWaitMs: 10_000 }, fakes.ports);
  for (let i = 0; i < 6000; i += 1) {
    const [row] = (await db.query<{ status: string }>("select status from upload_sessions where id = $1", [sessionId])).rows;
    if (row?.status === "confirmed") break;
    await delay(10);
  }
  const ingested = fakes.runs.flatMap(run => run.files.map(file => file.sourceKey));
  expect(new Set(ingested).size).toBe(count);
  return { mode, files: count, runs: created.length, firstRunMs: created[0]! - lastPut, lastRunMs: created.at(-1)! - lastPut };
}

describe.skipIf(!MEASURE)("LOCAL: last PUT to first and last run (webhook without client completes, or client completes without webhook)", () => {
  it("50 and 1,000 files", async () => {
    startDirectUploadReconciler();
    for (const growth of [1, 2]) {
      env.directUploadWaveGrowth = growth;
      const results = [];
      for (const mode of ["webhook", "client"] as const) for (const count of [50, 1000]) for (let i = 0; i < 3; i += 1) results.push(await measure(count, mode));
      console.log(`[measure] branch=waves K=${env.directUploadWaveFiles} T=${env.directUploadWaveDelayMs}ms growth=${growth}\n${results.map(r => JSON.stringify(r)).join("\n")}`);
    }
  }, 600_000);
});
