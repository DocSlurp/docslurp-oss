import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The project access rule has one definition, the SQL function
 * docslurp_project_access (migration 0124). Every reader of the rule calls
 * it; this test pins the rule itself against an explicit table and proves the
 * TypeScript entry points (getProjectAccess, the accessible-id listing, the
 * search session context, realtime authorization and the org project count)
 * agree with it for every user and project, including cross-tenant ones.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let orgs: typeof import("../services/organizations.js");
let search: typeof import("../search/session-setup.js");
let realtime: typeof import("../realtime/backend.js");

const USERS = ["owner", "admin", "member", "shared", "removed", "outsider", "pOwner", "pShared", "bob"] as const;
const PROJECTS = ["wsDefault", "wsPrivate", "wsMemberOwned", "wsShared", "wsPersonal", "wsB"] as const;

/** Explicit expectation: who may see what. Anything missing from a row is denied. */
const EXPECTED: Record<(typeof USERS)[number], readonly (typeof PROJECTS)[number][]> = {
  owner: ["wsDefault", "wsPrivate", "wsMemberOwned", "wsShared"],
  admin: ["wsDefault", "wsPrivate", "wsMemberOwned", "wsShared"],
  // A plain member sees the default project and what they own or were added to; not others' private ones.
  member: ["wsDefault", "wsMemberOwned"],
  shared: ["wsDefault", "wsShared"],
  // Still has a leftover project_members row for wsShared but no membership in the team org: nothing.
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
  await sql`insert into projects(id, org_id, user_id, name, is_default) values
    ('wsDefault', 'team', 'owner', 'Default', true),
    ('wsPrivate', 'team', 'owner', 'Private', false),
    ('wsMemberOwned', 'team', 'member', 'Member owned', false),
    ('wsShared', 'team', 'owner', 'Shared', false),
    ('wsPersonal', 'personal', 'pOwner', 'Personal', false),
    ('wsB', 'orgB', 'bob', 'B', false)`;
  await sql`insert into project_members(project_id, user_id, role) values
    ('wsShared', 'shared', 'viewer'), ('wsShared', 'removed', 'editor'), ('wsPersonal', 'pShared', 'viewer')`;
  orgs = await import("../services/organizations.js");
  search = await import("../search/session-setup.js");
  realtime = await import("../realtime/backend.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

const allowed = (user: (typeof USERS)[number], project: (typeof PROJECTS)[number]) => EXPECTED[user].includes(project);

describe("docslurp_project_access", () => {
  it.each(USERS)("matches the explicit access table for %s", async (user) => {
    for (const project of PROJECTS) {
      const [row] = await sql<{ ok: boolean }[]>`select docslurp_project_access(${project}, ${user}) as ok`;
      expect(row!.ok, `${user} -> ${project}`).toBe(allowed(user, project));
    }
  });

  it("denies unknown users, unknown projects and null users", async () => {
    const [row] = await sql<{ a: boolean; b: boolean; c: boolean }[]>`select
      docslurp_project_access('wsDefault', 'nobody') as a,
      docslurp_project_access('missing', 'owner') as b,
      docslurp_project_access('wsDefault', null) as c`;
    expect(row).toEqual({ a: false, b: false, c: false });
  });
});

describe("every reader of the rule agrees with the SQL function", () => {
  it.each(USERS)("getProjectAccess and the accessible-id listing for %s", async (user) => {
    const listed = new Set(await orgs.listAccessibleProjectIds(user));
    for (const project of PROJECTS) {
      const [row] = await sql<{ ok: boolean }[]>`select docslurp_project_access(${project}, ${user}) as ok`;
      expect(Boolean(await orgs.getProjectAccess(project, user)), `getProjectAccess ${user} -> ${project}`).toBe(row!.ok);
      expect(listed.has(project), `listAccessibleProjectIds ${user} -> ${project}`).toBe(row!.ok);
    }
  });

  it.each(USERS)("the search session context and realtime authorization for %s", async (user) => {
    for (const project of PROJECTS) {
      const ok = allowed(user, project);
      const context = await search.loadSearchProjectContext(project, user).then(() => true, () => false);
      expect(context, `loadSearchProjectContext ${user} -> ${project}`).toBe(ok);
      const authorized = await realtime.realtimeBackend.authorize(user, { kind: "project", projectId: project });
      expect(Boolean(authorized), `realtime authorize ${user} -> ${project}`).toBe(ok);
    }
  });

  it("counts only projects the user can see in the organization details", async () => {
    for (const user of ["owner", "admin", "member", "shared"] as const) {
      const details = await orgs.getOrganizationDetails("team", user);
      const visible = PROJECTS.filter((project) => project !== "wsPersonal" && project !== "wsB" && allowed(user, project));
      expect(details.counts.projects, user).toBe(visible.length);
    }
  });

  it("realtime delivery filters an activity payload to projects the user may see", async () => {
    const delivery = (user: string, projectIds: string[]) => realtime.realtimeBackend.authorizeDelivery!(
      user, { kind: "activity", orgId: "team" }, { runs: projectIds.map((projectId) => ({ projectId })) });
    expect(await delivery("member", ["wsDefault", "wsMemberOwned"])).toBe(true);
    // One project the member may not see poisons the whole payload.
    expect(await delivery("member", ["wsDefault", "wsPrivate"])).toBe(false);
    expect(await delivery("shared", ["wsDefault", "wsShared"])).toBe(true);
    // Another tenant's project is never deliverable through this org's activity resource.
    expect(await delivery("owner", ["wsDefault", "wsB"])).toBe(false);
    expect(await delivery("outsider", ["wsDefault"])).toBe(false);
  });
});
