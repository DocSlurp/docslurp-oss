import { beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({ responses: [] as unknown[][], statements: [] as string[], transactions: 0 }));
vi.mock("../db.js", () => {
  const query = Object.assign(async (strings: TemplateStringsArray) => {
    queries.statements.push(strings.join("?"));
    const response = queries.responses.shift();
    if (!response) throw new Error("Unexpected SQL");
    return response;
  }, { json: (value: unknown) => value, begin: async (fn: (tx: unknown) => Promise<unknown>) => { queries.transactions++; return fn(query); } });
  return { sql: query };
});
vi.mock("../services/notifications.js", () => ({ sendWorkspaceInviteEmail: vi.fn(), sendOrganizationInviteEmail: vi.fn(async () => null) }));

const { assertMembershipMutation, inviteOrganizationMember, updateOrganizationMemberRole, removeOrganizationMember, organizationCapabilities, createOrganization, OrganizationError } = await import("../services/organizations.js");
const member = (role: string, userId = "actor") => ({ org_id: "org", user_id: userId, role, created_at: "2026-10-06" });
beforeEach(() => { queries.responses = []; queries.statements = []; queries.transactions = 0; });

function locked(actor: string, target: string | null, owners = 1, personal = false) {
  queries.responses.push([{ is_personal: personal }], [member(actor)], target ? [member(target, "target")] : [], [{ count: owners }]);
}

describe("organization membership invariants", () => {
  it.each([
    ["admin", "owner", "member"], ["admin", "admin", "member"], ["admin", "member", "admin"],
    ["admin", null, "owner"], ["member", "member", "billing"],
  ] as const)("denies %s changing %s to %s", (actor, target, next) => {
    expect(() => assertMembershipMutation(actor, target, next, false, 2)).toThrow(OrganizationError);
  });
  it("allows admins to manage regular members and owners to grant another owner", () => {
    expect(() => assertMembershipMutation("admin", "member", "billing", false, 1)).not.toThrow();
    expect(() => assertMembershipMutation("owner", "member", "owner", false, 1)).not.toThrow();
  });
  it("keeps the last owner and personal membership intact", () => {
    expect(() => assertMembershipMutation("owner", "owner", null, false, 1, true)).toThrow("retain an owner");
    expect(() => assertMembershipMutation("owner", "owner", "admin", false, 1)).toThrow("retain an owner");
    expect(() => assertMembershipMutation("owner", null, "member", true, 1)).toThrow("Personal organization");
  });
  it("allows members to leave and an owner to leave when another owner remains", () => {
    expect(() => assertMembershipMutation("billing", "billing", null, false, 1, true)).not.toThrow();
    expect(() => assertMembershipMutation("owner", "owner", null, false, 2, true)).not.toThrow();
  });
  it("advertises narrow capabilities", () => {
    expect(organizationCapabilities("member")).toMatchObject({ read: true, update: false, manageMembers: false, manageOwners: false, manageApiKeys: false });
    expect(organizationCapabilities("owner", true)).toMatchObject({ leave: false, manageOwners: false });
  });
});

describe("transactional membership service", () => {
  it("rejects inviting an existing member's email without changing their role", async () => {
    queries.responses.push([{ is_personal: false }], [member("owner")], [{ count: 1 }], [{ user_id: "target" }]);
    await expect(inviteOrganizationMember("org", "actor", { email: "Target@Example.com", role: "owner" })).rejects.toMatchObject({ status: 409, code: "membership_exists" });
    expect(queries.transactions).toBe(1);
    expect(queries.statements[0]).toContain("for update");
    expect(queries.statements.some(s => s.includes("update org_memberships") || s.includes("insert into org_memberships"))).toBe(false);
  });
  it("lets admins invite members but not owners", async () => {
    queries.responses.push([{ is_personal: false }], [member("admin")], [{ count: 1 }]);
    await expect(inviteOrganizationMember("org", "actor", { email: "new@example.com", role: "owner" })).rejects.toMatchObject({ status: 403, code: "membership_forbidden" });
    expect(queries.statements.some(s => s.includes("insert into org_invites"))).toBe(false);
  });
  it("reads actor authority inside the lock and refuses a removed actor", async () => {
    queries.responses.push([{ is_personal: false }], []);
    await expect(updateOrganizationMemberRole({ orgId: "org", userId: "actor", memberUserId: "target", role: "member" })).rejects.toMatchObject({ status: 404 });
    expect(queries.statements).toHaveLength(2);
    expect(queries.statements[0]).toContain("for update");
  });
  it("refuses last-owner removal before any deletion", async () => {
    locked("owner", "owner");
    await expect(removeOrganizationMember({ orgId: "org", userId: "actor", memberUserId: "target" })).rejects.toMatchObject({ status: 409, code: "last_owner" });
    expect(queries.statements.some(s => s.includes("delete"))).toBe(false);
  });
  it("removes membership, revokes keys and MCP grants, hands over workspaces and audits in one transaction (G-06)", async () => {
    locked("owner", "member");
    queries.responses.push([], [], [], [], [], []);
    await expect(removeOrganizationMember({ orgId: "org", userId: "actor", memberUserId: "target" })).resolves.toBe(true);
    expect(queries.transactions).toBe(1);
    expect(queries.statements.slice(-6).map(s => s.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "delete from org_memberships", "update api_keys set", "update mcp_oauth_grants set", "update workspaces set", "delete from workspace_members", "insert into audit_log",
    ]);
    expect(queries.statements.find(s => s.startsWith("update workspaces"))).toContain("role = 'owner'");
  });
  it("creates owner membership, default workspace and audit before leaving the creation transaction", async () => {
    queries.responses.push([{ id: "actor" }], [], [], [], [], [{ id: "org", name: "New", slug: null, is_personal: false, personal_owner_user_id: null, created_by_user_id: "actor", credit_balance_cents: 0, member_role: "owner", created_at: "2026-10-06", updated_at: "2026-10-06" }]);
    await expect(createOrganization({ userId: "actor", name: "New" })).resolves.toMatchObject({ memberRole: "owner" });
    expect(queries.transactions).toBe(1);
    expect(queries.statements.slice(1, 5).map(s => s.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual(["insert into organizations", "insert into org_memberships", "insert into workspaces", "insert into audit_log"]);
  });
});
