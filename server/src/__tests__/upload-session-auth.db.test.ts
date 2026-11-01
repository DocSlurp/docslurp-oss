import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase } from "@docslurp/worker/testing";
import { createHash, randomBytes } from "node:crypto";

// Only the SQL transport is replaced: authentication and ownership run production queries
// against an isolated database built from the full migration journal.
const mocks = vi.hoisted(() => ({ describe: vi.fn(), query: vi.fn() }));
vi.mock("../db.js", () => ({ sql: Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, "");
    return { then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      mocks.query(text, values).then((result: { rows: unknown[] }) => result.rows).then(resolve, reject) };
  }, { json: (value: unknown) => JSON.stringify(value), array: (value: unknown) => value }) }));
vi.mock("../services/direct-upload-session.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/direct-upload-session.js")>(),
  // This is the serialization/signing boundary. Denied requests must never reach it.
  getDirectUploadSessionDescription: mocks.describe,
}));
const { apiKeyAuth } = await import("../middleware/api-key-auth.js");
const { createUploadsRoutes } = await import("../routes/uploads.js");
const id = "11111111-1111-4111-8111-111111111111";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
const app = new Hono().use("*", apiKeyAuth).route("/uploads", createUploadsRoutes());
let rawKey: string;
async function seedKey(overrides: { keyType?: string; scopes?: string[]; orgId?: string | null; workspaceIds?: string[]; userId?: string } = {}) {
  const keyType = overrides.keyType ?? "server";
  rawKey = `dslp_${keyType === "client" ? "pub" : "priv"}_${randomBytes(32).toString("hex")}`;
  await db.query(`insert into api_keys
    (id, user_id, org_id, key_hash, name, key_type, scopes, allowed_domains, workspace_ids)
    values ('key', $1, $2, $3, 'Upload test', $4, $5, $6, $7)
    on conflict (id) do update set user_id=excluded.user_id, org_id=excluded.org_id,
    key_hash=excluded.key_hash, key_type=excluded.key_type, scopes=excluded.scopes,
    allowed_domains=excluded.allowed_domains, workspace_ids=excluded.workspace_ids, revoked_at=null`,
    [overrides.userId ?? "u", overrides.orgId === undefined ? "o" : overrides.orgId,
      createHash("sha256").update(rawKey).digest("hex"), keyType, overrides.scopes ?? ["ingest"],
      keyType === "client" ? ["docs.example.com"] : [], overrides.workspaceIds ?? ["w"]]);
}
const ownershipQueries = () => mocks.query.mock.calls.filter(([sql]) => /from upload_sessions/i.test(sql));
beforeAll(async () => {
  vi.stubEnv("API_RATE_LIMIT_ENABLED", "false");
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user" (id,name,email) values ('u','Test','upload@example.test'), ('other','Other','other@example.test');
    insert into organizations (id,name,slug,created_by_user_id) values ('o','Org','upload-test','u'), ('foreign','Foreign','upload-foreign','u');
    insert into org_memberships (org_id,user_id,role) values ('o','u','owner'), ('foreign','u','owner'), ('o','other','member');
    insert into workspaces (id,org_id,user_id,name) values ('w','o','u','Workspace'), ('excluded','o','u','Excluded');
    insert into upload_sessions (id,user_id,org_id,workspace_id,status) values ('${id}','u','o','w','uploading');
  `);
  mocks.query.mockImplementation((text, values) => db.query(text, values));
}, 120000);
afterAll(async () => { await (await import("../services/api-key-usage.js")).flushApiKeyUsage(); await db?.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await seedKey();
  mocks.describe.mockResolvedValue({ id, files: [] });
});

describe.each([false, true])("direct session authorization, statusOnly=%s", statusOnly => {
  const request = (sessionId = id) => app.request(`/uploads/direct/sessions/${sessionId}?statusOnly=${statusOnly}`, {
    headers: { authorization: `Bearer ${rawKey}`, origin: "https://docs.example.com" },
  });
  it("permits a server ingest key bound to the owning workspace", async () => {
    expect((await request()).status).toBe(200);
    expect(mocks.query.mock.calls.some(([sql]) => /from api_keys/i.test(sql))).toBe(true);
    expect(mocks.query).toHaveBeenCalled();
    expect(mocks.describe).toHaveBeenCalledWith(id, "u", statusOnly);
  });
  it.each([
    ["browser", { keyType: "client", scopes: ["search"] }, 403],
    ["legacy elevated browser", { keyType: "client", scopes: ["ingest", "artifacts", "workspaces:manage"] }, 403],
    ["wrong scope", { scopes: ["search"] }, 403],
    ["other tenant", { orgId: "foreign" }, 404],
    ["other workspace", { workspaceIds: ["excluded"] }, 404],
    ["other owner", { userId: "other" }, 404],
    ["missing organization", { orgId: null }, 403],
  ])("rejects %s before serialization or signing", async (_label, overrides, status) => {
    await seedKey(overrides);
    expect((await request()).status).toBe(status);
    expect(mocks.describe).not.toHaveBeenCalled();
  });
  it("hides an absent session before serialization", async () => {
    expect((await request("22222222-2222-4222-8222-222222222222")).status).toBe(404);
    expect(mocks.describe).not.toHaveBeenCalled();
  });
  it("rejects an unassigned session for a workspace-bound key", async () => {
    await db.query("update upload_sessions set workspace_id = null where id = $1", [id]);
    try {
      expect((await request()).status).toBe(404);
      expect(mocks.describe).not.toHaveBeenCalled();
    } finally {
      await db.query("update upload_sessions set workspace_id = 'w' where id = $1", [id]);
    }
  });
  it("rejects revoked credentials before ownership lookup", async () => {
    expect((await request()).status).toBe(200);
    await db.query("update api_keys set revoked_at = now() where id = 'key'");
    mocks.describe.mockClear();
    mocks.query.mockClear();
    expect((await request()).status).toBe(403);
    expect(ownershipQueries()).toHaveLength(0);
    expect(mocks.describe).not.toHaveBeenCalled();
  });
  it("rejects an incorrect secret before ownership lookup", async () => {
    rawKey += "incorrect";
    expect((await request()).status).toBe(403);
    expect(ownershipQueries()).toHaveLength(0);
    expect(mocks.describe).not.toHaveBeenCalled();
  });
  it("rejects the same credential after its owner leaves the organization", async () => {
    expect((await request()).status).toBe(200);
    await db.query("delete from org_memberships where org_id = 'o' and user_id = 'u'");
    mocks.describe.mockClear();
    mocks.query.mockClear();
    try {
      expect((await request()).status).toBe(403);
      expect(ownershipQueries()).toHaveLength(0);
      expect(mocks.describe).not.toHaveBeenCalled();
    } finally {
      await db.query("insert into org_memberships (org_id,user_id,role) values ('o','u','owner')");
    }
  });
  it.each(["malformed", "x".repeat(8192)])("rejects invalid identifiers before ownership SQL", async sessionId => {
    expect((await request(sessionId)).status).toBe(400);
    expect(ownershipQueries()).toHaveLength(0);
    expect(mocks.describe).not.toHaveBeenCalled();
  });
});
