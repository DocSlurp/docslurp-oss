import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

import { maxOrgsPerUser, warnOrgLimitAboveOneWithUniqueIndex } from "../services/org-membership-limit.js";

/**
 * The one-organization-per-user policy (DOCSLURP_MAX_ORGS_PER_USER=1, index org_memberships_one_org_per_user): joining or
 * creating a second organization answers 409 user_already_in_org unless the user's current organization is an empty personal
 * one, which is then replaced; leaving gives the user their personal organization back; a user moved out loses access at once.
 */
vi.mock("../services/notifications.js", () => ({ sendWorkspaceInviteEmail: vi.fn(async () => null), sendOrganizationInviteEmail: vi.fn(async () => null) }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let orgs: typeof import("../services/organizations.js");

const membershipsOf = async (userId: string) =>
  (await sql<{ org_id: string; role: string }[]>`select org_id, role from org_memberships where user_id = ${userId} order by org_id`);

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql, apiPool: undefined }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  orgs = await import("../services/organizations.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

let seq = 0;
async function user(name: string): Promise<string> {
  const id = `${name}-${++seq}`;
  await sql`insert into "user"(id, name, email, "emailVerified") values (${id}, ${name}, ${`${id}@example.test`}, true)`;
  return id;
}
async function team(ownerId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`select id from organizations where id = ${(await orgs.createOrganization({ userId: ownerId, name: `Team ${++seq}` })).id}`;
  return id!;
}
async function invite(orgId: string, ownerId: string, inviteeId: string) {
  const { token } = await orgs.inviteOrganizationMember(orgId, ownerId, { email: `${inviteeId}@example.test`, role: "member", expiresInDays: 7 });
  return token;
}

describe("one organization per user", () => {
  beforeEach(() => { vi.unstubAllEnvs(); });

  it("defaults to one and never widens on a malformed value", () => {
    expect(maxOrgsPerUser({})).toBe(1);
    expect(maxOrgsPerUser({ DOCSLURP_MAX_ORGS_PER_USER: "3" })).toBe(3);
    expect(maxOrgsPerUser({ DOCSLURP_MAX_ORGS_PER_USER: "0" })).toBe(1);
    expect(maxOrgsPerUser({ DOCSLURP_MAX_ORGS_PER_USER: "lots" })).toBe(1);
  });

  it("warns at startup when a limit above one meets the one-organization index", async () => {
    const lines: string[] = [];
    const indexExists = async () => (await sql<{ present: boolean }[]>`select to_regclass('public.org_memberships_one_org_per_user') is not null as present`)[0]!.present;
    expect(await warnOrgLimitAboveOneWithUniqueIndex(indexExists, { DOCSLURP_MAX_ORGS_PER_USER: "3" }, (line) => lines.push(line))).toBe(true);
    expect(lines.join("\n")).toMatch(/DOCSLURP_MAX_ORGS_PER_USER=3 has no effect/);
    expect(await warnOrgLimitAboveOneWithUniqueIndex(indexExists, {}, (line) => lines.push(line))).toBe(false);
    expect(await warnOrgLimitAboveOneWithUniqueIndex(async () => false, { DOCSLURP_MAX_ORGS_PER_USER: "3" }, (line) => lines.push(line))).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it("refuses a second membership row outright", async () => {
    const owner = await user("owner");
    const other = await user("other");
    const orgId = await team(owner);
    await orgs.resolveDefaultOrganization(other);
    await expect(sql`insert into org_memberships (org_id, user_id, role) values (${orgId}, ${other}, 'member')`)
      .rejects.toMatchObject({ constraint_name: "org_memberships_one_org_per_user" });
  });

  it("replaces an empty personal organization when an invite is accepted", async () => {
    const owner = await user("owner");
    const invitee = await user("invitee");
    const orgId = await team(owner);
    const personal = await orgs.resolveDefaultOrganization(invitee);
    expect(personal.isPersonal).toBe(true);
    const [defaultWorkspace] = await sql<{ id: string }[]>`select id from workspaces where org_id = ${personal.id} and is_default`;
    expect(defaultWorkspace).toBeDefined();
    await orgs.acceptOrganizationInvite(await invite(orgId, owner, invitee), invitee);
    expect(await membershipsOf(invitee)).toEqual([{ org_id: orgId, role: "member" }]);
    expect(await sql`select id from organizations where id = ${personal.id}`).toEqual([]);
    // Its default workspace goes with it: workspaces.org_id has no foreign key, so nothing else would remove it.
    expect(await sql`select id from workspaces where org_id = ${personal.id}`).toEqual([]);
  });

  it.each([
    ["a chat session in its default workspace", async (orgId: string, userId: string) => {
      const [ws] = await sql<{ id: string }[]>`select id from workspaces where org_id = ${orgId} and is_default`;
      await sql`insert into chat_sessions (id, workspace_id, user_id) values (${`chat-${userId}`}, ${ws!.id}, ${userId})`;
    }],
    ["a pending upload session", async (orgId: string, userId: string) => {
      await sql`insert into upload_sessions (id, user_id, org_id, status) values (${`up-${userId}`}, ${userId}, ${orgId}, 'pending')`;
    }],
    ["auto top-up enabled", async (orgId: string) => { await sql`update organizations set auto_recharge_enabled = true where id = ${orgId}`; }],
    ["an unrevoked MCP grant", async (orgId: string, userId: string) => {
      await sql`insert into mcp_oauth_clients (id, name, redirect_uris) values (${`c-${userId}`}, 'c', '[]'::jsonb) on conflict do nothing`;
      // The grant's key is revoked (a revoked key is not data); the live grant is.
      await sql`insert into api_keys (id, user_id, org_id, key_hash, name, revoked_at) values (${`gk-${userId}`}, ${userId}, ${orgId}, ${`gh-${userId}`}, 'n', now())`;
      await sql`insert into mcp_oauth_grants (id, client_id, user_id, org_id, resource, scopes, api_key_id) values (${`g-${userId}`}, ${`c-${userId}`}, ${userId}, ${orgId}, 'r', '[]'::jsonb, ${`gk-${userId}`})`;
    }],
  ])("keeps a personal organization with %s and refuses the invite", async (_label, seed) => {
    const owner = await user("owner");
    const invitee = await user("invitee");
    const orgId = await team(owner);
    const personal = await orgs.resolveDefaultOrganization(invitee);
    await seed(personal.id, invitee);
    const token = await invite(orgId, owner, invitee);
    await expect(orgs.acceptOrganizationInvite(token, invitee)).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
    expect(await membershipsOf(invitee)).toEqual([{ org_id: personal.id, role: "owner" }]);
    expect(await sql`select id from workspaces where org_id = ${personal.id} and is_default`).toHaveLength(1);
  });

  it("answers 409 user_already_in_org when the current organization has data, and changes nothing", async () => {
    const owner = await user("owner");
    const invitee = await user("invitee");
    const orgId = await team(owner);
    const personal = await orgs.resolveDefaultOrganization(invitee);
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name) values (${`k-${invitee}`}, ${invitee}, ${personal.id}, ${`h-${invitee}`}, 'n')`;
    const token = await invite(orgId, owner, invitee);
    await expect(orgs.acceptOrganizationInvite(token, invitee)).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
    expect(await membershipsOf(invitee)).toEqual([{ org_id: personal.id, role: "owner" }]);
    expect(await sql`select status from org_invites where org_id = ${orgId}`).toEqual([{ status: "pending" }]);
  });

  it("answers 409 for an invite from a team member to a member of another team", async () => {
    const ownerA = await user("owner-a");
    const ownerB = await user("owner-b");
    const orgA = await team(ownerA);
    await team(ownerB);
    await expect(orgs.acceptOrganizationInvite(await invite(orgA, ownerA, ownerB), ownerB)).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
  });

  it("refuses creating a second organization the same way, unless the current one is an empty personal one", async () => {
    const someone = await user("creator");
    const personal = await orgs.resolveDefaultOrganization(someone);
    const first = await orgs.createOrganization({ userId: someone, name: "First" });
    expect(await membershipsOf(someone)).toEqual([{ org_id: first.id, role: "owner" }]);
    expect(await sql`select id from organizations where id = ${personal.id}`).toEqual([]);
    await expect(orgs.createOrganization({ userId: someone, name: "Second" })).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
    expect(await membershipsOf(someone)).toEqual([{ org_id: first.id, role: "owner" }]);
  });

  it("answers 409 for a workspace invite that would add a second organization", async () => {
    const ownerA = await user("owner-a");
    const ownerB = await user("owner-b");
    const orgA = await team(ownerA);
    await team(ownerB);
    const [workspace] = await sql<{ id: string }[]>`select id from workspaces where org_id = ${orgA} and is_default`;
    await orgs.inviteWorkspaceMember(workspace!.id, { userId: ownerA, email: `${ownerB}@example.test`, role: "viewer", expiresInDays: 7 });
    const [{ token }] = await sql<{ token: string }[]>`select token from workspace_invites where workspace_id = ${workspace!.id}`;
    await expect(orgs.acceptWorkspaceInvite(token!, ownerB)).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
    expect(await sql`select 1 from workspace_members where workspace_id = ${workspace!.id} and user_id = ${ownerB}`).toEqual([]);
  });

  it("answers 409 when a workspace invite's join passes the check but loses the race to the one-organization index", async () => {
    // A concurrent join that commits between the check and the insert leaves exactly this state: the check passed, the
    // index refuses. A limit of 2 lets the check pass while the index (still present) refuses the second membership.
    const ownerA = await user("owner-a");
    const ownerB = await user("owner-b");
    const orgA = await team(ownerA);
    const orgB = await team(ownerB);
    const [workspace] = await sql<{ id: string }[]>`select id from workspaces where org_id = ${orgA} and is_default`;
    await orgs.inviteWorkspaceMember(workspace!.id, { userId: ownerA, email: `${ownerB}@example.test`, role: "viewer", expiresInDays: 7 });
    const [{ token }] = await sql<{ token: string }[]>`select token from workspace_invites where workspace_id = ${workspace!.id}`;
    vi.stubEnv("DOCSLURP_MAX_ORGS_PER_USER", "2");
    await expect(orgs.acceptWorkspaceInvite(token!, ownerB)).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
    expect(await membershipsOf(ownerB)).toEqual([{ org_id: orgB, role: "owner" }]);
    expect(await sql`select 1 from workspace_members where workspace_id = ${workspace!.id} and user_id = ${ownerB}`).toEqual([]);
    expect(await sql`select status from workspace_invites where workspace_id = ${workspace!.id}`).toEqual([{ status: "pending" }]);
  });

  it("gives a member who leaves exactly one organization again: their personal one", async () => {
    const owner = await user("owner");
    const leaver = await user("leaver");
    const orgId = await team(owner);
    await orgs.acceptOrganizationInvite(await invite(orgId, owner, leaver), leaver);
    await orgs.removeOrganizationMember({ orgId, userId: leaver, memberUserId: leaver });
    const memberships = await membershipsOf(leaver);
    expect(memberships).toHaveLength(1);
    const [personal] = await sql<{ is_personal: boolean; personal_owner_user_id: string }[]>`
      select is_personal, personal_owner_user_id from organizations where id = ${memberships[0]!.org_id}`;
    expect(personal).toEqual({ is_personal: true, personal_owner_user_id: leaver });
    expect((await orgs.resolveDefaultOrganization(leaver)).id).toBe(memberships[0]!.org_id);
  });

  it("cuts a removed member off from the organization's data at once", async () => {
    const owner = await user("owner");
    const removed = await user("removed");
    const orgId = await team(owner);
    await orgs.acceptOrganizationInvite(await invite(orgId, owner, removed), removed);
    const [workspace] = await sql<{ id: string }[]>`select id from workspaces where org_id = ${orgId} and is_default`;
    await sql`update org_memberships set role = 'admin' where org_id = ${orgId} and user_id = ${removed}`;
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name) values (${`k-${removed}`}, ${removed}, ${orgId}, ${`h-${removed}`}, 'n')`;
    expect(await orgs.getWorkspaceAccess(workspace!.id, removed)).not.toBeNull();
    await orgs.removeOrganizationMember({ orgId, userId: owner, memberUserId: removed });
    expect(await orgs.getWorkspaceAccess(workspace!.id, removed)).toBeNull();
    expect(await orgs.getOrganization(orgId, removed)).toBeNull();
    expect(await sql`select revoked_at is not null as revoked from api_keys where id = ${`k-${removed}`}`).toEqual([{ revoked: true }]);
    // The org's data stays the org's: the removed user's new organization is a fresh personal one with none of it.
    const [mine] = await membershipsOf(removed);
    expect(mine!.org_id).not.toBe(orgId);
  });
});
