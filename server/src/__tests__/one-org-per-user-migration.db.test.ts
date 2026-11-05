import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";

/**
 * Migration 0127 enforces the current one-organization-per-user policy (DOCSLURP_MAX_ORGS_PER_USER=1): existing users with
 * several memberships keep one, chosen deterministically, the removed ones are backed up, and a unique index refuses a second.
 */
const MIGRATION = "one_org_per_user";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
const rows = async <T>(text: string) => (await db.query<T>(text.replaceAll("workspace", "project"))).rows;

beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: MIGRATION });
  await db.exec(`
    insert into "user"(id, name, email) values
      ('solo', 'S', 'solo@example.test'), ('empty-personal', 'E', 'e@example.test'), ('data-personal', 'D', 'd@example.test'),
      ('two-teams', 'T', 't@example.test'), ('tomb', 'X', 'x@example.test'), ('owner-t1', 'O', 'o@example.test');
    insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
      ('p-solo', 'P', 'p-solo', 'solo', true, 'solo'),
      ('p-empty', 'P', 'p-empty', 'empty-personal', true, 'empty-personal'),
      ('p-data', 'P', 'p-data', 'data-personal', true, 'data-personal'),
      ('p-tomb', 'P', 'p-tomb', 'tomb', true, 'tomb'),
      ('t1', 'T1', 't1', 'owner-t1', false, null), ('t2', 'T2', 't2', 'two-teams', false, null),
      ('dead', 'Dead', 'dead', 'tomb', false, null);
    update organizations set deleted_at = now() where id = 'dead';
    insert into org_memberships (org_id, user_id, role, created_at) values
      ('p-solo', 'solo', 'owner', now()),
      ('t1', 'owner-t1', 'owner', now() - interval '10 days'),
      ('p-empty', 'empty-personal', 'owner', now()), ('t1', 'empty-personal', 'member', now()),
      ('p-data', 'data-personal', 'owner', now()), ('t1', 'data-personal', 'member', now()),
      ('t1', 'two-teams', 'admin', now()), ('t2', 'two-teams', 'owner', now() - interval '1 day'),
      ('p-tomb', 'tomb', 'owner', now()), ('dead', 'tomb', 'owner', now());
    insert into workspaces (id, org_id, user_id, name) values ('ws-t1', 't1', 'two-teams', 'T1'), ('ws-t2', 't2', 'two-teams', 'T2');
    insert into workspace_members (workspace_id, user_id, role) values ('ws-t1', 'two-teams', 'editor');
    -- t2 has the most recent run, so two-teams (owner/admin of both) keeps t2.
    insert into workspace_runs (id, workspace_id, user_id, org_id, kind, status, stage, pipeline, created_at) values
      ('run-t1', 'ws-t1', 'two-teams', 't1', 'upload', 'completed', 'completed', '{}'::jsonb, now() - interval '5 days'),
      ('run-t2', 'ws-t2', 'two-teams', 't2', 'upload', 'completed', 'completed', '{}'::jsonb, now());
    insert into api_keys (id, user_id, org_id, key_hash, name) values
      ('k-data', 'data-personal', 'p-data', 'h1', 'n'), ('k-t1', 'two-teams', 't1', 'h2', 'n'), ('k-t2', 'two-teams', 't2', 'h3', 'n');
  `);
  await applyRemainingMigrations(db, MIGRATION);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("0127 one organization per user", () => {
  it("keeps exactly one membership per user, chosen by the documented rules", async () => {
    expect(await rows("select user_id, org_id, role from org_memberships order by user_id")).toEqual([
      // A personal org with an API key is not empty; as its owner it beats a member seat in t1.
      { user_id: "data-personal", org_id: "p-data", role: "owner" },
      // An empty personal org is deleted; the team membership stays.
      { user_id: "empty-personal", org_id: "t1", role: "member" },
      { user_id: "owner-t1", org_id: "t1", role: "owner" },
      { user_id: "solo", org_id: "p-solo", role: "owner" },
      { user_id: "tomb", org_id: "p-tomb", role: "owner" },
      // Owner/admin of both teams: the one with the most recent run.
      { user_id: "two-teams", org_id: "t2", role: "owner" },
    ]);
  });

  it("deletes only the empty personal organization and keeps every organization that has data", async () => {
    expect(await rows("select id from organizations order by id")).toEqual(
      ["dead", "p-data", "p-solo", "p-tomb", "t1", "t2"].map((id) => ({ id })),
    );
  });

  it("backs up every removed membership with its reason", async () => {
    expect(await rows("select org_id, user_id, role, reason from org_memberships_removed_backup order by user_id, org_id")).toEqual([
      { org_id: "t1", user_id: "data-personal", role: "member", reason: "not_kept" },
      { org_id: "p-empty", user_id: "empty-personal", role: "owner", reason: "empty_personal_organization" },
      { org_id: "dead", user_id: "tomb", role: "owner", reason: "deleted_organization" },
      { org_id: "t1", user_id: "two-teams", role: "admin", reason: "not_kept" },
    ]);
  });

  it("cuts a removed member off from that organization at once: keys revoked, shares gone, workspaces handed to an owner", async () => {
    expect(await rows("select id, revoked_at is not null as revoked from api_keys order by id")).toEqual([
      { id: "k-data", revoked: false },
      { id: "k-t1", revoked: true },
      { id: "k-t2", revoked: false },
    ]);
    expect(await rows("select * from workspace_members where user_id = 'two-teams'")).toEqual([]);
    expect(await rows("select id, user_id from workspaces where id in ('ws-t1', 'ws-t2') order by id")).toEqual([
      { id: "ws-t1", user_id: "owner-t1" },
      { id: "ws-t2", user_id: "two-teams" },
    ]);
    expect(await rows("select docslurp_workspace_access('ws-t1', 'two-teams') as access")).toEqual([{ access: false }]);
  });

  it("refuses a second membership for a user", async () => {
    await expect(db.query("insert into org_memberships (org_id, user_id, role) values ('t2', 'solo', 'member')"))
      .rejects.toThrow(/org_memberships_one_org_per_user/);
  });

  it("reports a personal organization with no data as empty, and one with data or of a team as not", async () => {
    expect(await rows("select docslurp_personal_org_is_empty('p-solo') as a, docslurp_personal_org_is_empty('p-data') as b, docslurp_personal_org_is_empty('t1') as c, docslurp_personal_org_is_empty('missing') as d"))
      .toEqual([{ a: true, b: false, c: false, d: false }]);
  });
});
