import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The workspace access rule has one definition, the SQL function
 * docslurp_workspace_access (migration 0124). Every reader of the rule calls
 * it; this test pins the rule itself against an explicit table and proves the
 * TypeScript entry points (getWorkspaceAccess, the accessible-id listing, the
 * search session context, realtime authorization and the org workspace count)
 * agree with it for every user and workspace, including cross-tenant ones.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let orgs: typeof import("../services/organizations.js");
let search: typeof import("../search/session-setup.js");
let realtime: typeof import("../realtime/backend.js");

const USERS = ["owner", "admin", "member", "shared", "removed", "outsider", "pOwner", "pShared", "bob"] as const;
const WORKSPACES = ["wsDefault", "wsPrivate", "wsMemberOwned", "wsShared", "wsPersonal", "wsB"] as const;

/** Explicit expectation: who may see what. Anything missing from a row is denied. */
const EXPECTED: Record<(typeof USERS)[number], readonly (typeof WORKSPACES)[number][]> = {
  owner: ["wsDefault", "wsPrivate", "wsMemberOwned", "wsShared"],
  admin: ["wsDefault", "wsPrivate", "wsMemberOwned", "wsShared"],
  // A plain member sees the default workspace and what they own or were added to; not others' private ones.
  member: ["wsDefault", "wsMemberOwned"],
  shared: ["wsDefault", "wsShared"],
  // Still has a leftover workspace_members row for wsShared but no membership in the team org: nothing.
  removed: [],
  outsider: [],
  pOwner: ["wsPersonal"],
  // A direct share out of a personal org stands alone, without an org membership.
  pShared: ["wsPersonal"],
  bob: ["wsB"],
};

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  for (const id of USERS) await sql`insert into "user"(id, name, email) values (${id}, ${id}, ${`${id}@example.test`})`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
    ('team', 'Team', 'team', 'owner', false, null),
    ('personal', 'Personal', 'personal', 'pOwner', true, 'pOwner'),
    ('orgB', 'Org B', 'org-b', 'bob', false, null)`;
  await sql`insert into org_memberships(org_id, user_id, role) values
    ('team', 'owner', 'owner'), ('team', 'admin', 'admin'), ('team', 'member', 'member'), ('team', 'shared', 'member'),
    ('personal', 'pOwner', 'owner'), ('orgB', 'bob', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name, is_default) values
    ('wsDefault', 'team', 'owner', 'Default', true),
    ('wsPrivate', 'team', 'owner', 'Private', false),
    ('wsMemberOwned', 'team', 'member', 'Member owned', false),
    ('wsShared', 'team', 'owner', 'Shared', false),
    ('wsPersonal', 'personal', 'pOwner', 'Personal', false),
    ('wsB', 'orgB', 'bob', 'B', false)`;
  await sql`insert into workspace_members(workspace_id, user_id, role) values
    ('wsShared', 'shared', 'viewer'), ('wsShared', 'removed', 'editor'), ('wsPersonal', 'pShared', 'viewer')`;
  orgs = await import("../services/organizations.js");
  search = await import("../search/session-setup.js");
  realtime = await import("../realtime/backend.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

const allowed = (user: (typeof USERS)[number], workspace: (typeof WORKSPACES)[number]) => EXPECTED[user].includes(workspace);

describe("docslurp_workspace_access", () => {
  it.each(USERS)("matches the explicit access table for %s", async (user) => {
    for (const workspace of WORKSPACES) {
      const [row] = await sql<{ ok: boolean }[]>`select docslurp_workspace_access(${workspace}, ${user}) as ok`;
      expect(row!.ok, `${user} -> ${workspace}`).toBe(allowed(user, workspace));
    }
  });

  it("denies unknown users, unknown workspaces and null users", async () => {
    const [row] = await sql<{ a: boolean; b: boolean; c: boolean }[]>`select
      docslurp_workspace_access('wsDefault', 'nobody') as a,
      docslurp_workspace_access('missing', 'owner') as b,
      docslurp_workspace_access('wsDefault', null) as c`;
    expect(row).toEqual({ a: false, b: false, c: false });
  });
});

describe("every reader of the rule agrees with the SQL function", () => {
  it.each(USERS)("getWorkspaceAccess and the accessible-id listing for %s", async (user) => {
    const listed = new Set(await orgs.listAccessibleWorkspaceIds(user));
    for (const workspace of WORKSPACES) {
      const [row] = await sql<{ ok: boolean }[]>`select docslurp_workspace_access(${workspace}, ${user}) as ok`;
      expect(Boolean(await orgs.getWorkspaceAccess(workspace, user)), `getWorkspaceAccess ${user} -> ${workspace}`).toBe(row!.ok);
      expect(listed.has(workspace), `listAccessibleWorkspaceIds ${user} -> ${workspace}`).toBe(row!.ok);
    }
  });

  it.each(USERS)("the search session context and realtime authorization for %s", async (user) => {
    for (const workspace of WORKSPACES) {
      const ok = allowed(user, workspace);
      const context = await search.loadSearchWorkspaceContext(workspace, user).then(() => true, () => false);
      expect(context, `loadSearchWorkspaceContext ${user} -> ${workspace}`).toBe(ok);
      const authorized = await realtime.realtimeBackend.authorize(user, { kind: "workspace", workspaceId: workspace });
      expect(Boolean(authorized), `realtime authorize ${user} -> ${workspace}`).toBe(ok);
    }
  });

  it("counts only workspaces the user can see in the organization details", async () => {
    for (const user of ["owner", "admin", "member", "shared"] as const) {
      const details = await orgs.getOrganizationDetails("team", user);
      const visible = WORKSPACES.filter((workspace) => workspace !== "wsPersonal" && workspace !== "wsB" && allowed(user, workspace));
      expect(details.counts.workspaces, user).toBe(visible.length);
    }
  });

  it("realtime delivery filters an activity payload to workspaces the user may see", async () => {
    const delivery = (user: string, workspaceIds: string[]) => realtime.realtimeBackend.authorizeDelivery!(
      user, { kind: "activity", orgId: "team" }, { runs: workspaceIds.map((workspaceId) => ({ workspaceId })) });
    expect(await delivery("member", ["wsDefault", "wsMemberOwned"])).toBe(true);
    // One workspace the member may not see poisons the whole payload.
    expect(await delivery("member", ["wsDefault", "wsPrivate"])).toBe(false);
    expect(await delivery("shared", ["wsDefault", "wsShared"])).toBe(true);
    // Another tenant's workspace is never deliverable through this org's activity resource.
    expect(await delivery("owner", ["wsDefault", "wsB"])).toBe(false);
    expect(await delivery("outsider", ["wsDefault"])).toBe(false);
  });
});
