import postgres from "postgres";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ORG_TEST_DATABASE_URL must point at a disposable database built by applying
// server/db/migrations (pnpm db:migrate). The test runs against that real
// schema and isolates itself with run-unique ids instead of a private schema.
const database = vi.hoisted(() => ({ url: process.env.ORG_TEST_DATABASE_URL, run: `${process.pid}-${Date.now()}` }));
vi.mock("../db.js", async () => {
  const { default: postgres } = await import("postgres");
  const { numericType } = await import("../lib/api-pool.js");
  // Same numeric parsing as the production API pool (credit balances are numeric).
  return { sql: postgres(database.url ?? "postgres://unused", { max: 4, onnotice: () => {}, types: { numeric: numericType } }) };
});
vi.mock("../services/notifications.js", () => ({ sendWorkspaceInviteEmail: vi.fn() }));
const { sql } = await import("../db.js");
const { createOrganization, getWorkspaceAccess, updateOrganizationMemberRole, removeOrganizationMember } = await import("../services/organizations.js");
// Org membership is invite-only now (G-02); seed the second owner directly.
async function addOwner(orgId: string, userId: string) {
  await sql`insert into org_memberships (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
}
const { validateApiKey, createApiKey, updateApiKey, rotateApiKey } = await import("../services/api-keys.js");

const run = database.run;
const A = `org-conc-a-${run}`;
const B = `org-conc-b-${run}`;
const C = `org-conc-c-${run}`;
const users = [A, B, C];
const mcpClientId = `org-conc-client-${run}`;

describe.skipIf(!database.url)("PostgreSQL organization ownership concurrency", () => {
  beforeAll(async () => {
    for (const id of users) {
      await sql`insert into "user" (id, name, email) values (${id}, ${id}, ${`${id}@example.test`})`;
    }
    await sql`insert into mcp_oauth_clients (id, name, redirect_uris) values (${mcpClientId}, 'Org concurrency test', '[]'::jsonb)`;
  });
  afterAll(async () => {
    const orgs = await sql<{ id: string }[]>`select distinct org_id as id from org_memberships where user_id in ${sql(users)}
      union select id from organizations where created_by_user_id in ${sql(users)}`;
    const orgIds = orgs.map(row => row.id);
    if (orgIds.length) {
      await sql`delete from audit_log where org_id in ${sql(orgIds)}`;
      await sql`delete from workspaces where org_id in ${sql(orgIds)}`;
      await sql`delete from organizations where id in ${sql(orgIds)}`;
    }
    await sql`delete from mcp_oauth_clients where id = ${mcpClientId}`;
    await sql`delete from "user" where id in ${sql(users)}`;
    await sql.end();
  });

  async function twoOwners(name: string) {
    const org = await createOrganization({ userId: A, name });
    await addOwner(org.id, B);
    return org.id;
  }

  it("serializes two self-demotions so the last owner remains", async () => {
    const orgId = await twoOwners("Concurrent demotion");
    const outcomes = await Promise.allSettled([A, B].map(userId => updateOrganizationMemberRole({ orgId, userId, memberUserId: userId, role: "admin" })));
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(o => o.status === "rejected").map(o => (o as PromiseRejectedResult).reason.code)).toEqual(["last_owner"]);
    const [count] = await sql`select count(*)::int as count from org_memberships where org_id = ${orgId} and role = 'owner'`;
    expect(count!.count).toBe(1);
  });
  it("rechecks actor membership after simultaneous reciprocal removals", async () => {
    const orgId = await twoOwners("Concurrent removal");
    const outcomes = await Promise.allSettled([
      removeOrganizationMember({ orgId, userId: A, memberUserId: B }),
      removeOrganizationMember({ orgId, userId: B, memberUserId: A }),
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
        createApiKey(B, "Concurrent", { orgId, scopes: ["organizations:manage"] }),
        removeOrganizationMember({ orgId, userId: A, memberUserId: B }),
      ]);
      expect(outcomes[1]!.status).toBe("fulfilled");
      const rows = await sql`select * from api_keys where org_id = ${orgId} and user_id = ${B}`;
      if (outcomes[0]!.status === "fulfilled") {
        expect(rows).toHaveLength(1);
        expect(rows[0]!.revoked_at).not.toBeNull();
      } else {
        expect(rows).toHaveLength(0);
        expect((outcomes[0] as PromiseRejectedResult).reason.code).toBe("organization_not_found");
      }
      await addOwner(orgId, B);
      const active = await sql`select * from api_keys where org_id = ${orgId} and user_id = ${B} and revoked_at is null`;
      expect(active).toHaveLength(0);
      if (outcomes[0]!.status === "fulfilled") expect(await validateApiKey(outcomes[0].value.rawKey)).toBeNull();
    }
  });
  it("rechecks management authority on update and rotation after demotion", async () => {
    const orgId = await twoOwners("Key demotion");
    const key = await createApiKey(B, "Management", { orgId, scopes: ["organizations:manage"] });
    await updateOrganizationMemberRole({ orgId, userId: A, memberUserId: B, role: "member" });
    await expect(updateApiKey(key.key.id, B, { name: "Changed" })).rejects.toMatchObject({ code: "organization_forbidden" });
    await expect(rotateApiKey(key.key.id, B)).rejects.toMatchObject({ code: "organization_forbidden" });
    const [row] = await sql`select name,key_hash from api_keys where id = ${key.key.id}`;
    expect(row!.name).toBe("Management");
    expect(row!.key_hash).toBe(createHash("sha256").update(key.rawKey).digest("hex"));
  });
  it("rejects a race-created organization key after removal and ends the member's workspace access (G-06)", async () => {
    const orgId = await twoOwners("Race-created key");
    const existingRawKey = `dslp_before_removal_${run}`;
    const raceRawKey = `dslp_created_after_removal_${run}`;
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    await sql`insert into api_keys (id,org_id,user_id,key_hash,name) values (${`before-${orgId}`},${orgId},${B},${hash(existingRawKey)},'Test')`;
    await sql`insert into workspaces (id, org_id, user_id, name) values (${`owned-${orgId}`}, ${orgId}, ${B}, 'Owned'), (${`shared-${orgId}`}, ${orgId}, ${A}, 'Shared')`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${`shared-${orgId}`},${B},'editor')`;
    await sql`insert into mcp_oauth_grants (id, client_id, user_id, org_id, resource, scopes, api_key_id)
      values (${`grant-${orgId}`}, ${mcpClientId}, ${B}, ${orgId}, 'https://example.test/mcp', '["search"]'::jsonb, ${`before-${orgId}`})`;
    expect(await getWorkspaceAccess(`shared-${orgId}`, B)).not.toBeNull();
    expect(await validateApiKey(existingRawKey)).toMatchObject({ userId: B, orgId });
    await removeOrganizationMember({ orgId, userId: A, memberUserId: B });
    // Model provisioning that authorized before removal but committed afterward.
    await sql`insert into api_keys (id,org_id,user_id,key_hash,name) values (${`race-${orgId}`},${orgId},${B},${hash(raceRawKey)},'Test')`;
    expect(await validateApiKey(existingRawKey)).toBeNull();
    expect(await validateApiKey(raceRawKey)).toBeNull();
    const grants = await sql`select * from workspace_members where user_id = ${B}`;
    expect(grants).toHaveLength(0);
    const [owned] = await sql`select user_id from workspaces where id = ${`owned-${orgId}`}`;
    expect(owned!.user_id).toBe(A);
    const [grant] = await sql`select revoked_at from mcp_oauth_grants where id = ${`grant-${orgId}`}`;
    expect(grant!.revoked_at).not.toBeNull();
    // Even a stale share row would not grant access without org membership.
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${`shared-${orgId}`},${B},'editor')`;
    expect(await getWorkspaceAccess(`shared-${orgId}`, B)).toBeNull();
    expect(await getWorkspaceAccess(`owned-${orgId}`, A)).not.toBeNull();
    const usages = await sql`select * from api_key_usage where key_id = ${`race-${orgId}`}`;
    expect(usages).toHaveLength(0);
  });
  it("rolls back duplicate-slug creation without orphan organizations or owner memberships", async () => {
    const outcomes = await Promise.allSettled([A, B].map(userId => createOrganization({ userId, name: "Same", slug: `same-slug-${run}` })));
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const rows = await sql`select o.id, count(om.user_id)::int as members from organizations o left join org_memberships om on om.org_id = o.id where o.slug = ${`same-slug-${run}`} group by o.id`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.members).toBe(1);
    const orphans = await sql`select o.id from organizations o where o.created_by_user_id in ${sql(users)} and not exists (select 1 from org_memberships om where om.org_id = o.id and role = 'owner')`;
    expect(orphans).toHaveLength(0);
  });
});
