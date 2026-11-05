import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDatabase } from "@docslurp/worker/testing";
import { createHash, randomBytes } from "node:crypto";
import { LIFT_ONE_ORG_PER_USER_POLICY } from "./helpers/multi-org.js";

// Only the SQL transport is replaced: authentication and ownership run production queries
// against an isolated database built from the full migration journal.
const mocks = vi.hoisted(() => ({ describe: vi.fn(), sign: vi.fn(), query: vi.fn() }));
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
  signDirectUploadParts: mocks.sign,
}));
const { apiKeyAuth } = await import("../middleware/api-key-auth.js");
const { createUploadsRoutes } = await import("../routes/uploads.js");
const id = "11111111-1111-4111-8111-111111111111";
// A session 'other' made in 'excluded', which it may upload into only through a workspace share.
const sharedId = "33333333-3333-4333-8333-333333333333";
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
  await db.exec(LIFT_ONE_ORG_PER_USER_POLICY);
  await db.exec(`
    insert into "user" (id,name,email) values ('u','Test','upload@example.test'), ('other','Other','other@example.test');
    insert into organizations (id,name,slug,created_by_user_id) values ('o','Org','upload-test','u'), ('foreign','Foreign','upload-foreign','u');
    insert into org_memberships (org_id,user_id,role) values ('o','u','owner'), ('foreign','u','owner'), ('o','other','member');
    insert into workspaces (id,org_id,user_id,name) values ('w','o','u','Workspace'), ('excluded','o','u','Excluded');
    insert into upload_sessions (id,user_id,org_id,workspace_id,status) values ('${id}','u','o','w','uploading');
    insert into upload_sessions (id,user_id,org_id,workspace_id,status) values ('${sharedId}','other','o','excluded','uploading');
  `);
  mocks.query.mockImplementation((text, values) => db.query(text, values));
}, 120000);
afterAll(async () => { await (await import("../services/api-key-usage.js")).flushApiKeyUsage(); await db?.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await seedKey();
  mocks.describe.mockResolvedValue({ id, files: [{ uploadUrl: "https://signed.example/put" }] });
  mocks.sign.mockResolvedValue({ parts: [{ partNumber: 1, url: "https://signed.example/part" }] });
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
    // A live key without an organization cannot be inserted: api_keys_org_id_required (migration 0125, api-keys-org-required.db.test.ts).
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

describe("idempotent session replay after a share is revoked", () => {
  it("hands URLs back only while the user may still contribute to the session's workspace", async () => {
    const { assertSessionWorkspaceStillContributable } = await import("../services/direct-session-idempotency.js");
    // 'other' is a plain member of 'o': it may upload into 'excluded' only through a share.
    await db.query("insert into workspace_members (workspace_id, user_id, role) values ('excluded', 'other', 'editor')");
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: "excluded" }, "other")).resolves.toBeUndefined();
    await db.query("delete from workspace_members where workspace_id = 'excluded' and user_id = 'other'");
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: "excluded" }, "other")).rejects.toMatchObject({ statusCode: 403 });
    // A viewer share does not let them upload either; another tenant's user never can.
    await db.query("insert into workspace_members (workspace_id, user_id, role) values ('excluded', 'other', 'viewer')");
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: "excluded" }, "other")).rejects.toMatchObject({ statusCode: 403 });
    await db.query("delete from workspace_members where workspace_id = 'excluded' and user_id = 'other'");
    await db.query(`insert into "user" (id,name,email) values ('outsider','Out','outsider@example.test') on conflict do nothing`);
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: "w" }, "outsider")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("signed URLs for an existing session need current contribute access", () => {
  const headers = () => ({ authorization: `Bearer ${rawKey}`, "content-type": "application/json" });
  const get = (sessionId: string, statusOnly = false) => app.request(`/uploads/direct/sessions/${sessionId}?statusOnly=${statusOnly}`, { headers: headers() });
  const sign = (sessionId: string) => app.request(`/uploads/direct/sessions/${sessionId}/files/f1/parts/sign`, { method: "POST", headers: headers(), body: JSON.stringify({ partNumbers: [1] }) });
  const noUrls = async (response: Response) => expect(await response.text()).not.toContain("signed.example");
  const share = async (role: string | null) => {
    await db.query("delete from workspace_members where workspace_id = 'excluded' and user_id = 'other'");
    if (role) await db.query("insert into workspace_members (workspace_id, user_id, role) values ('excluded', 'other', $1)", [role]);
  };
  beforeEach(async () => { await seedKey({ userId: "other", workspaceIds: ["excluded"] }); await share("editor"); });

  it("mints URLs while the share lets the user upload", async () => {
    expect((await get(sharedId)).status).toBe(200);
    expect((await sign(sharedId)).status).toBe(200);
    expect(mocks.describe).toHaveBeenCalledOnce();
    expect(mocks.sign).toHaveBeenCalledOnce();
  });

  it.each([["revoked", null], ["demoted to viewer", "viewer"]])("refuses a %s share with 403 and mints nothing", async (_label, role) => {
    await share(role);
    for (const response of [await get(sharedId), await sign(sharedId)]) {
      expect(response.status).toBe(403);
      await noUrls(response);
    }
    expect(mocks.describe).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    // A status-only read carries no URLs and stays available.
    expect((await get(sharedId, true)).status).toBe(200);
  });

  it.each([
    ["revoked key", async () => { await db.query("update api_keys set revoked_at = now() where id = 'key'"); }, 403],
    ["key without upload scope", async () => { await seedKey({ userId: "other", workspaceIds: ["excluded"], scopes: ["search"] }); }, 403],
    ["key whose allowlist excludes the workspace", async () => { await seedKey({ userId: "other", workspaceIds: ["w"] }); }, 404],
  ])("refuses part signing for a %s and mints nothing", async (_label, setup, status) => {
    await setup();
    for (const response of [await get(sharedId), await sign(sharedId)]) {
      expect(response.status).toBe(status);
      await noUrls(response);
    }
    expect(mocks.describe).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("refuses a session whose confirm creates its workspace once the user left the organization", async () => {
    const { assertSessionWorkspaceStillContributable } = await import("../services/direct-session-idempotency.js");
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: null, org_id: "o" }, "other")).resolves.toBeUndefined();
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: null, org_id: "foreign" }, "other")).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: null, org_id: null }, "other")).rejects.toMatchObject({ statusCode: 403 });
  });
});
