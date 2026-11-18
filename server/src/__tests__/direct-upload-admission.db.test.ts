import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase } from "@docslurp/worker/testing";
import { createProjectIntakeFakes } from "./helpers/project-intake-fakes.js";

// Billable admission of a direct-upload session re-validates its principal on every path that starts a run: the
// client's confirm (a flush) and the reconciler's waves (sweep and wave timers), once per wave. Real migrations and SQL on PGlite;
// only the SQL transport, the lock connection and object storage are replaced.
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ sql: Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, "");
    return { then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      mocks.query(text, values).then((result: { rows: unknown[] }) => result.rows).then(resolve, reject) };
  }, { json: (value: unknown) => JSON.stringify(value), array: (value: unknown) => value }) }));
vi.mock("../lib/direct-upload-locks.js", () => ({
  DirectUploadLockUnavailable: class extends Error {},
  reserveDirectUploadLockConnection: async () => ({
    connection: async (strings: TemplateStringsArray) => strings.join("").includes("pg_try_advisory_lock") ? [{ acquired: true }] : [],
    release: () => {},
  }),
}));
vi.mock("../lib/storage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/storage.js")>(),
  getUploadedObjectMetadata: async () => ({ contentLength: 10, etag: "\"e\"" }),
  abortMultipartUpload: async () => {},
  deleteUploadedObject: async () => {},
}));

const { liveDirectUploadAdmission } = await import("../services/project-intake-actions.js");
const { confirmDirectUploadProjectIntake, setDirectUploadWavePortsForTesting } = await import("../services/direct-upload-waves.js");
const { reconcileDirectUploads } = await import("../services/direct-upload-reconciler.js");

const SESSION = "11111111-1111-4111-8111-111111111111";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;

async function sessionStatus() {
  return (await db.query<{ status: string }>("select status from upload_sessions where id = $1", [SESSION])).rows[0]!.status;
}
async function runCount() {
  return Number((await db.query<{ n: string }>("select count(*) as n from project_runs where id = $1", [SESSION])).rows[0]!.n);
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user" (id,name,email) values ('u','Uploader','admission@example.test');
    insert into organizations (id,name,slug,created_by_user_id) values ('o','Org','admission-test','u');
    insert into projects (id,org_id,user_id,name) values ('p','o','u','Project'), ('other','o','u','Other');
  `);
  mocks.query.mockImplementation((text: string, values: unknown[]) => db.query(text, values));
}, 120_000);
afterAll(async () => { setDirectUploadWavePortsForTesting(null); await db?.close(); });
beforeEach(async () => {
  await db.exec(`delete from upload_session_files; delete from upload_sessions; delete from api_keys;
    delete from storage_cleanup_queue; delete from org_memberships;
    insert into org_memberships (org_id,user_id,role) values ('o','u','owner');`);
  await db.query(`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, allowed_domains, project_ids)
    values ('k', 'u', 'o', 'hash-admission', 'Ingest', 'server', $1, '{}', $2)`, [["ingest"], ["p"]]);
  // A session opened by the key, every file transferred and sealed: only admission is left.
  await db.query(`insert into upload_sessions (id, user_id, org_id, project_id, api_key_id, allowed_project_ids, status, next_reconcile_at)
    values ($1, 'u', 'o', 'p', 'k', $2, 'pending', now() - interval '1 second')`, [SESSION, ["p"]]);
  await db.query(`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, status)
    values ('f', $1, 'doc.pdf', 'application/pdf', 10, 'u/x/raw/sealed-f-doc.pdf', 'single', 'completed')`, [SESSION]);
});

const changes: Array<[string, string]> = [
  ["the key is revoked", "update api_keys set revoked_at = now() where id = 'k'"],
  ["the key lost its ingest scope", "update api_keys set scopes = '{search:hybrid}' where id = 'k'"],
  ["the project left the key's allowlist", "update api_keys set project_ids = '{other}' where id = 'k'"],
  ["the user left the organization", "delete from org_memberships where org_id = 'o' and user_id = 'u'"],
];

describe("billable admission re-validates the principal", () => {
  it("admits the session while key, scope, allowlist and membership hold", async () => {
    await expect(liveDirectUploadAdmission({ org_id: "o", project_id: "p", api_key_id: "k", allowed_project_ids: ["p"] }, "u"))
      .resolves.toEqual({ allowedProjectIds: ["p"] });
  });

  it.each(changes)("refuses the client's confirm when %s between transfer and confirm: no run, nothing billed", async (_label, change) => {
    await db.exec(change);
    const fakes = createProjectIntakeFakes();
    await expect(confirmDirectUploadProjectIntake({ sessionId: SESSION, userId: "u" }, fakes.ports)).rejects.toMatchObject({ statusCode: 403 });
    expect(fakes.runs).toHaveLength(0);
    expect(await runCount()).toBe(0);
    expect(await sessionStatus()).toBe("pending");
  });

  it.each(changes)("makes the reconciler fail the session when %s: no run, nothing billed", async (_label, change) => {
    await db.exec(change);
    const fakes = createProjectIntakeFakes();
    setDirectUploadWavePortsForTesting(fakes.ports);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await reconcileDirectUploads();
    expect(fakes.runs).toHaveLength(0);
    log.mockRestore();
    expect(await runCount()).toBe(0);
    expect(await sessionStatus()).toBe("failed");
  });

  it("narrows to the live allowlist, never wider than the session's own", async () => {
    await db.exec("update api_keys set project_ids = '{p,other}' where id = 'k'");
    await expect(liveDirectUploadAdmission({ org_id: "o", project_id: "p", api_key_id: "k", allowed_project_ids: ["p"] }, "u"))
      .resolves.toEqual({ allowedProjectIds: ["p"] });
    // A scoped key never creates a project.
    await expect(liveDirectUploadAdmission({ org_id: "o", project_id: null, project_name: null, api_key_id: "k", allowed_project_ids: ["p"] }, "u"))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
