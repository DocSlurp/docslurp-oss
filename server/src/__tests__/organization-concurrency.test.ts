import postgres from "postgres";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ url: process.env.ORG_TEST_DATABASE_URL, schema: `org_test_${process.pid}_${Date.now()}` }));
vi.mock("../db.js", async () => {
  const { default: postgres } = await import("postgres");
  return { sql: postgres(database.url ?? "postgres://unused", { max: 4, connection: { search_path: database.schema } }) };
});
vi.mock("../services/notifications.js", () => ({ sendWorkspaceInviteEmail: vi.fn() }));
const { sql } = await import("../db.js");
const { createOrganization, getWorkspaceAccess, updateOrganizationMemberRole, removeOrganizationMember } = await import("../services/organizations.js");
// Org membership is invite-only now (G-02); seed the second owner directly.
async function addOwner(orgId: string, userId: string) {
  await sql`insert into org_memberships (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
}
const { validateApiKey, createApiKey, updateApiKey, rotateApiKey } = await import("../services/api-keys.js");
const admin = database.url ? postgres(database.url, { max: 1 }) : null;

// Opt-in disposable database only; each execution creates/drops its own isolated schema.
describe.skipIf(!database.url)("PostgreSQL organization ownership concurrency", () => {
  beforeAll(async () => {
    await admin!.unsafe(`create schema ${database.schema}`);
    await sql.unsafe(`
      create table "user" (id text primary key, name text not null, email text not null);
      create table organizations (id text primary key, name text not null, slug text unique, is_personal boolean default false,
        personal_owner_user_id text, created_by_user_id text references "user", credit_balance_cents integer default 0,
        created_at timestamptz default now(), updated_at timestamptz default now());
      create table org_memberships (org_id text references organizations, user_id text references "user", role text not null,
        created_at timestamptz default now(), primary key(org_id,user_id));
      create table api_keys (id text primary key, org_id text, user_id text, key_hash text, name text default 'Test', key_type text default 'server',
        allowed_domains text[] default '{}', scopes text[] default '{ingest}', rate_limit_rpm integer default 60, rate_limit_ppd integer default 100,
        rate_limits jsonb default '[]', workspace_ids text[] default '{}',
        last_used_at timestamptz, created_at timestamptz default now(), revoked_at timestamptz);
      create table api_key_usage (key_id text, minute_bucket timestamptz, request_count integer, page_count integer, primary key(key_id,minute_bucket));
      create table workspace_members (workspace_id text, user_id text, role text);
      create table workspaces (id text primary key, org_id text, user_id text, is_default boolean default false, updated_at timestamptz default now());
      create table mcp_oauth_grants (id text primary key, org_id text, user_id text, revoked_at timestamptz);
      create table audit_log (id text primary key, org_id text, user_id text, action text, resource_type text, resource_id text, metadata jsonb);
      insert into "user" values ('a','A','a@example.test'),('b','B','b@example.test'),('c','C','c@example.test');
    `);
  });
  afterAll(async () => {
    await sql.end();
    await admin!.unsafe(`drop schema if exists ${database.schema} cascade`);
    await admin!.end();
  });

  async function twoOwners(name: string) {
    const org = await createOrganization({ userId: "a", name });
    await addOwner(org.id, "b");
    return org.id;
  }

  it("serializes two self-demotions so the last owner remains", async () => {
    const orgId = await twoOwners("Concurrent demotion");
    const outcomes = await Promise.allSettled(["a", "b"].map(userId => updateOrganizationMemberRole({ orgId, userId, memberUserId: userId, role: "admin" })));
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(o => o.status === "rejected").map(o => (o as PromiseRejectedResult).reason.code)).toEqual(["last_owner"]);
    const [count] = await sql`select count(*)::int as count from org_memberships where org_id = ${orgId} and role = 'owner'`;
    expect(count!.count).toBe(1);
  });
  it("rechecks actor membership after simultaneous reciprocal removals", async () => {
    const orgId = await twoOwners("Concurrent removal");
    const outcomes = await Promise.allSettled([
      removeOrganizationMember({ orgId, userId: "a", memberUserId: "b" }),
      removeOrganizationMember({ orgId, userId: "b", memberUserId: "a" }),
    ]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(o => o.status === "rejected").map(o => (o as PromiseRejectedResult).reason.code)).toEqual(["organization_not_found"]);
    const [count] = await sql`select count(*)::int as count from org_memberships where org_id = ${orgId} and role = 'owner'`;
    expect(count!.count).toBe(1);
  });
  it("serializes provisioning with removal so re-adding a member cannot resurrect raced keys", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const orgId = await twoOwners(`Provision removal ${attempt}`);
      const outcomes = await Promise.allSettled([
        createApiKey("b", "Concurrent", { orgId, scopes: ["organizations:manage"] }),
        removeOrganizationMember({ orgId, userId: "a", memberUserId: "b" }),
      ]);
      expect(outcomes[1]!.status).toBe("fulfilled");
      const rows = await sql`select * from api_keys where org_id = ${orgId} and user_id = 'b'`;
      if (outcomes[0]!.status === "fulfilled") {
        expect(rows).toHaveLength(1);
        expect(rows[0]!.revoked_at).not.toBeNull();
      } else {
        expect(rows).toHaveLength(0);
        expect((outcomes[0] as PromiseRejectedResult).reason.code).toBe("organization_not_found");
      }
      await addOwner(orgId, "b");
      const active = await sql`select * from api_keys where org_id = ${orgId} and user_id = 'b' and revoked_at is null`;
      expect(active).toHaveLength(0);
      if (outcomes[0]!.status === "fulfilled") expect(await validateApiKey(outcomes[0].value.rawKey)).toBeNull();
    }
  });
  it("rechecks management authority on update and rotation after demotion", async () => {
    const orgId = await twoOwners("Key demotion");
    const key = await createApiKey("b", "Management", { orgId, scopes: ["organizations:manage"] });
    await updateOrganizationMemberRole({ orgId, userId: "a", memberUserId: "b", role: "member" });
    await expect(updateApiKey(key.key.id, "b", { name: "Changed" })).rejects.toMatchObject({ code: "organization_forbidden" });
    await expect(rotateApiKey(key.key.id, "b")).rejects.toMatchObject({ code: "organization_forbidden" });
    const [row] = await sql`select name,key_hash from api_keys where id = ${key.key.id}`;
    expect(row!.name).toBe("Management");
    expect(row!.key_hash).toBe(createHash("sha256").update(key.rawKey).digest("hex"));
  });
  it("rejects a race-created organization key after removal and ends the member's workspace access (G-06)", async () => {
    const orgId = await twoOwners("Race-created key");
    const existingRawKey = "dslp_before_removal";
    const raceRawKey = "dslp_created_after_removal";
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    await sql`insert into api_keys (id,org_id,user_id,key_hash) values ('before',${orgId},'b',${hash(existingRawKey)})`;
    await sql`insert into workspaces (id, org_id, user_id) values (${`owned-${orgId}`}, ${orgId}, 'b'), (${`shared-${orgId}`}, ${orgId}, 'a')`;
    await sql`insert into workspace_members values (${`shared-${orgId}`},'b','editor')`;
    await sql`insert into mcp_oauth_grants values (${`grant-${orgId}`}, ${orgId}, 'b', null)`;
    expect(await getWorkspaceAccess(`shared-${orgId}`, "b")).not.toBeNull();
    expect(await validateApiKey(existingRawKey)).toMatchObject({ userId: "b", orgId });
    await removeOrganizationMember({ orgId, userId: "a", memberUserId: "b" });
    // Model provisioning that authorized before removal but committed afterward.
    await sql`insert into api_keys (id,org_id,user_id,key_hash) values ('race',${orgId},'b',${hash(raceRawKey)})`;
    expect(await validateApiKey(existingRawKey)).toBeNull();
    expect(await validateApiKey(raceRawKey)).toBeNull();
    const grants = await sql`select * from workspace_members where user_id = 'b'`;
    expect(grants).toHaveLength(0);
    const [owned] = await sql`select user_id from workspaces where id = ${`owned-${orgId}`}`;
    expect(owned!.user_id).toBe("a");
    const [grant] = await sql`select revoked_at from mcp_oauth_grants where id = ${`grant-${orgId}`}`;
    expect(grant!.revoked_at).not.toBeNull();
    // Even a stale share row would not grant access without org membership.
    await sql`insert into workspace_members values (${`shared-${orgId}`},'b','editor')`;
    expect(await getWorkspaceAccess(`shared-${orgId}`, "b")).toBeNull();
    expect(await getWorkspaceAccess(`owned-${orgId}`, "a")).not.toBeNull();
    const usages = await sql`select * from api_key_usage where key_id = 'race'`;
    expect(usages).toHaveLength(0);
  });
  it("rolls back duplicate-slug creation without orphan organizations or owner memberships", async () => {
    const outcomes = await Promise.allSettled(["a", "b"].map(userId => createOrganization({ userId, name: "Same", slug: "same-slug" })));
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const rows = await sql`select o.id, count(om.user_id)::int as members from organizations o left join org_memberships om on om.org_id = o.id where o.slug = 'same-slug' group by o.id`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.members).toBe(1);
    const orphans = await sql`select o.id from organizations o where not exists (select 1 from org_memberships om where om.org_id = o.id and role = 'owner')`;
    expect(orphans).toHaveLength(0);
  });
});
