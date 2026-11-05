import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyRemainingMigrations, createMigratedDatabase, serveOnRandomPort } from "@docslurp/worker/testing";

import { collectReport, fundedRemovalsHash, oneOrgPlanSql } from "../../db/predeploy-check.mjs";

/**
 * Migration 0127 enforces the current one-organization-per-user policy (DOCSLURP_MAX_ORGS_PER_USER=1): existing users with
 * several memberships keep one, chosen deterministically, the removed ones are backed up, no live team organization is left
 * without an owner while it has members, and a unique index refuses a second membership. The pre-deploy report runs the
 * migration's own plan SQL, so what it lists is what the migration does.
 */
const MIGRATION = "one_org_per_user";
const migrationSql = readFileSync(new URL("../../db/migrations/0127_one_org_per_user.sql", import.meta.url), "utf8");
const journal = JSON.parse(readFileSync(new URL("../../db/migrations/meta/_journal.json", import.meta.url), "utf8"));
type Removal = { org_id: string; user_id: string; reason: string };
type Promotion = { org_id: string; user_id: string; previous_role: string };
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
const rows = async <T>(text: string) => (await db.query<T>(text)).rows;
let plannedRemovals: Removal[];
let plannedPromotions: Promotion[];
let report: { title: string; level: string; lines: string[] };
let acknowledgedReport: { title: string; level: string; lines: string[] };
let before: Record<string, number>;
const COUNTS = `select (select count(*)::int from org_memberships) as memberships, (select count(*)::int from organizations) as organizations,
  (select count(*)::int from api_keys where revoked_at is null) as live_keys, (select count(*)::int from mcp_oauth_grants where revoked_at is null) as live_grants,
  (select count(*)::int from workspace_members) as shares`;

beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: MIGRATION });
  await db.exec(`
    insert into "user"(id, name, email) values
      ('solo', 'S', 'solo@example.test'), ('empty-personal', 'E', 'e@example.test'), ('data-personal', 'D', 'd@example.test'),
      ('two-teams', 'T', 't@example.test'), ('tomb', 'X', 'x@example.test'), ('owner-t1', 'O', 'o@example.test'),
      ('revoked-personal', 'R', 'r@example.test'), ('only-tomb', 'Z', 'z@example.test'),
      ('sole-owner', 'U', 'u@example.test'), ('t3-member', 'M', 'm3@example.test'), ('t3-admin', 'A', 'a3@example.test'),
      ('sole-owner-5', 'V', 'v@example.test'), ('t5-old', 'M5', 'm5a@example.test'), ('t5-new', 'M5', 'm5b@example.test'),
      ('owner-t4', 'O4', 'o4@example.test');
    insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
      ('p-solo', 'P', 'p-solo', 'solo', true, 'solo'),
      ('p-empty', 'P', 'p-empty', 'empty-personal', true, 'empty-personal'),
      ('p-data', 'P', 'p-data', 'data-personal', true, 'data-personal'),
      ('p-tomb', 'P', 'p-tomb', 'tomb', true, 'tomb'),
      ('p-rev', 'P', 'p-rev', 'revoked-personal', true, 'revoked-personal'),
      ('t1', 'T1', 't1', 'owner-t1', false, null), ('t2', 'T2', 't2', 'two-teams', false, null),
      ('t3', 'T3', 't3', 'sole-owner', false, null), ('t4', 'T4', 't4', 'owner-t4', false, null), ('t5', 'T5', 't5', 'sole-owner-5', false, null),
      ('dead', 'Dead', 'dead', 'tomb', false, null), ('dead2', 'Dead2', 'dead2', 'only-tomb', false, null);
    update organizations set deleted_at = now() where id in ('dead', 'dead2');
    -- t3 is funded: removing its sole owner is what the pre-deploy report blocks on.
    update organizations set funded_at = now() where id = 't3';
    insert into org_memberships (org_id, user_id, role, created_at) values
      ('p-solo', 'solo', 'owner', now()),
      ('t1', 'owner-t1', 'owner', now() - interval '10 days'),
      ('p-empty', 'empty-personal', 'owner', now()), ('t1', 'empty-personal', 'member', now()),
      ('p-data', 'data-personal', 'owner', now()), ('t1', 'data-personal', 'member', now()),
      ('t1', 'two-teams', 'admin', now()), ('t2', 'two-teams', 'owner', now() - interval '1 day'),
      ('p-tomb', 'tomb', 'owner', now()), ('dead', 'tomb', 'owner', now()),
      ('p-rev', 'revoked-personal', 'owner', now()), ('t1', 'revoked-personal', 'member', now()),
      ('dead2', 'only-tomb', 'owner', now()),
      ('t3', 'sole-owner', 'owner', now() - interval '30 days'), ('t3', 't3-member', 'member', now() - interval '20 days'),
      ('t3', 't3-admin', 'admin', now() - interval '5 days'), ('t4', 'owner-t4', 'owner', now() - interval '30 days'),
      ('t4', 'sole-owner', 'member', now() - interval '2 days'),
      ('t5', 'sole-owner-5', 'owner', now() - interval '30 days'), ('t5', 't5-new', 'member', now() - interval '3 days'),
      ('t5', 't5-old', 'member', now() - interval '9 days'), ('t4', 'sole-owner-5', 'member', now() - interval '2 days');
    insert into workspaces (id, org_id, user_id, name) values
      ('ws-t1', 't1', 'two-teams', 'T1'), ('ws-t2', 't2', 'two-teams', 'T2'), ('ws-t3', 't3', 'sole-owner', 'T3'),
      ('ws-t4', 't4', 'owner-t4', 'T4'), ('ws-t5', 't5', 'sole-owner-5', 'T5');
    insert into workspace_members (workspace_id, user_id, role) values ('ws-t1', 'two-teams', 'editor'), ('ws-t3', 't3-member', 'viewer');
    -- t2 has the most recent run, so two-teams (owner/admin of both) keeps t2; t4 is more recent than t3 and t5.
    insert into workspace_runs (id, workspace_id, user_id, org_id, kind, status, stage, pipeline, created_at) values
      ('run-t1', 'ws-t1', 'two-teams', 't1', 'upload', 'completed', 'completed', '{}'::jsonb, now() - interval '5 days'),
      ('run-t2', 'ws-t2', 'two-teams', 't2', 'upload', 'completed', 'completed', '{}'::jsonb, now()),
      ('run-t3', 'ws-t3', 'sole-owner', 't3', 'upload', 'completed', 'completed', '{}'::jsonb, now() - interval '3 days'),
      ('run-t4', 'ws-t4', 'owner-t4', 't4', 'upload', 'completed', 'completed', '{}'::jsonb, now());
    insert into api_keys (id, user_id, org_id, key_hash, name, revoked_at) values
      ('k-data', 'data-personal', 'p-data', 'h1', 'n', null), ('k-t1', 'two-teams', 't1', 'h2', 'n', null),
      ('k-t2', 'two-teams', 't2', 'h3', 'n', null), ('k-rev', 'revoked-personal', 'p-rev', 'h4', 'n', now() - interval '1 day'),
      ('k-t3', 'sole-owner', 't3', 'h5', 'n', null);
    analyze;
  `);
  plannedRemovals = (await db.query<Removal>(`select * from (${oneOrgPlanSql(migrationSql).plan}) plan order by user_id, org_id`)).rows;
  const { plan, promotions } = oneOrgPlanSql(migrationSql);
  plannedPromotions = (await db.query<Promotion>(`with removed_memberships as (${plan}) select * from (${promotions}) p order by org_id`)).rows;
  // The pre-deploy report against the same database, over a real wire connection, read-only.
  const serving = await serveOnRandomPort(db);
  const client = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${serving.port}/postgres` });
  await client.connect();
  try {
    const { piiPatternTypeSchema } = await import("@docslurp/shared");
    const run = async (ack0127: string | null) => {
      await client.query("begin read only");
      const sections = await collectReport(client, { journal, acceptedPiiPatterns: piiPatternTypeSchema.options, ack0127 });
      await client.query("rollback");
      return sections.find((s: { title: string }) => s.title.startsWith("Memberships beyond one per user"))!;
    };
    report = await run(null);
    acknowledgedReport = await run(fundedRemovalsHash([{ user_id: "sole-owner", org_id: "t3" }]));
  } finally {
    await client.end();
    await serving.server.stop();
  }
  before = (await db.query<Record<string, number>>(COUNTS)).rows[0]!;
  await applyRemainingMigrations(db, MIGRATION);
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("0127 one organization per user", () => {
  it("keeps exactly one membership per user, chosen by the documented rules", async () => {
    expect(await rows(`select user_id, org_id, role from org_memberships order by user_id collate "C"`)).toEqual([
      // A personal org with an unrevoked key is not empty, but a team seat ranks before a personal organization.
      { user_id: "data-personal", org_id: "t1", role: "member" },
      // An empty personal org is deleted; the team membership stays.
      { user_id: "empty-personal", org_id: "t1", role: "member" },
      { user_id: "owner-t1", org_id: "t1", role: "owner" },
      { user_id: "owner-t4", org_id: "t4", role: "owner" },
      // A personal org whose only key is revoked is empty: deleted, the team seat stays.
      { user_id: "revoked-personal", org_id: "t1", role: "member" },
      // The sole owners of t3 and t5 keep t4 (more recent activity) ...
      { user_id: "sole-owner", org_id: "t4", role: "member" },
      { user_id: "sole-owner-5", org_id: "t4", role: "member" },
      { user_id: "solo", org_id: "p-solo", role: "owner" },
      // ... so t3's admin (not its older member) and t5's longest-standing member become owners.
      { user_id: "t3-admin", org_id: "t3", role: "owner" },
      { user_id: "t3-member", org_id: "t3", role: "member" },
      { user_id: "t5-new", org_id: "t5", role: "member" },
      { user_id: "t5-old", org_id: "t5", role: "owner" },
      { user_id: "tomb", org_id: "p-tomb", role: "owner" },
      // Owner/admin of two teams: the one with the most recent run.
      { user_id: "two-teams", org_id: "t2", role: "owner" },
      // only-tomb's only membership was in a tombstoned organization: removed, nothing kept.
    ]);
  });

  it("leaves no live team organization with members but without an owner", async () => {
    expect(await rows(`select o.id from organizations o where o.deleted_at is null and not o.is_personal
      and exists (select 1 from org_memberships m where m.org_id = o.id)
      and not exists (select 1 from org_memberships m where m.org_id = o.id and m.role = 'owner')`)).toEqual([]);
    expect(await rows("select org_id, user_id, action, metadata ->> 'previousRole' as previous from audit_log where action = 'organization.member.promoted_to_owner' order by org_id")).toEqual([
      { org_id: "t3", user_id: "t3-admin", action: "organization.member.promoted_to_owner", previous: "admin" },
      { org_id: "t5", user_id: "t5-old", action: "organization.member.promoted_to_owner", previous: "member" },
    ]);
  });

  it("deletes only the empty personal organizations and keeps every organization that has data", async () => {
    expect(await rows("select id from organizations order by id")).toEqual(
      ["dead", "dead2", "p-data", "p-solo", "p-tomb", "t1", "t2", "t3", "t4", "t5"].map((id) => ({ id })),
    );
  });

  it("backs up every removed membership with its reason, exactly as the pre-deploy plan listed", async () => {
    const backup = await rows<Removal & { role: string }>("select org_id, user_id, role, reason from org_memberships_removed_backup order by user_id, org_id");
    expect(backup).toEqual([
      { org_id: "p-data", user_id: "data-personal", role: "owner", reason: "not_kept" },
      { org_id: "p-empty", user_id: "empty-personal", role: "owner", reason: "empty_personal_organization" },
      { org_id: "dead2", user_id: "only-tomb", role: "owner", reason: "deleted_organization" },
      { org_id: "p-rev", user_id: "revoked-personal", role: "owner", reason: "empty_personal_organization" },
      { org_id: "t3", user_id: "sole-owner", role: "owner", reason: "not_kept" },
      { org_id: "t5", user_id: "sole-owner-5", role: "owner", reason: "not_kept" },
      { org_id: "dead", user_id: "tomb", role: "owner", reason: "deleted_organization" },
      { org_id: "t1", user_id: "two-teams", role: "admin", reason: "not_kept" },
    ]);
    expect(backup.map(({ org_id, user_id, reason }) => ({ org_id, user_id, reason }))).toEqual(plannedRemovals);
    expect(plannedPromotions).toEqual([
      { org_id: "t3", user_id: "t3-admin", previous_role: "admin" },
      { org_id: "t5", user_id: "t5-old", previous_role: "member" },
    ]);
  });

  it("cuts a removed member off from that organization at once: keys revoked, shares gone, workspaces handed to an owner", async () => {
    expect(await rows("select id, revoked_at is not null as revoked from api_keys order by id")).toEqual([
      { id: "k-data", revoked: true },
      { id: "k-t1", revoked: true },
      { id: "k-t2", revoked: false },
      { id: "k-t3", revoked: true },
    ]);
    expect(await rows("select * from workspace_members where user_id = 'two-teams'")).toEqual([]);
    expect(await rows("select workspace_id, user_id from workspace_members order by workspace_id")).toEqual([{ workspace_id: "ws-t3", user_id: "t3-member" }]);
    expect(await rows("select id, user_id from workspaces order by id")).toEqual([
      { id: "ws-t1", user_id: "owner-t1" },
      { id: "ws-t2", user_id: "two-teams" },
      // The promoted owner inherits the removed sole owner's workspaces.
      { id: "ws-t3", user_id: "t3-admin" },
      { id: "ws-t4", user_id: "owner-t4" },
      { id: "ws-t5", user_id: "t5-old" },
    ]);
    expect(await rows("select docslurp_workspace_access('ws-t1', 'two-teams') as a, docslurp_workspace_access('ws-t3', 't3-admin') as b")).toEqual([{ a: false, b: true }]);
  });

  it("refuses a second membership for a user", async () => {
    await expect(db.query("insert into org_memberships (org_id, user_id, role) values ('t2', 'solo', 'member')"))
      .rejects.toThrow(/org_memberships_one_org_per_user/);
  });

  it("reports a personal organization with no data as empty, and one with data or of a team as not", async () => {
    await db.exec(`insert into workspaces (id, org_id, user_id, name) values ('ws-solo', 'p-solo', 'solo', 'S');
      insert into api_keys (id, user_id, org_id, key_hash, name, revoked_at) values ('k-solo-old', 'solo', 'p-solo', 'h9', 'n', now())`);
    // p-solo: only a revoked key. p-tomb: nothing. p-data: a run-less workspace and only a revoked key now, but not empty
    // after a live key is added. t1: a team.
    expect(await rows("select docslurp_personal_org_is_empty('p-solo') as a, docslurp_personal_org_is_empty('p-tomb') as b, docslurp_personal_org_is_empty('t1') as c, docslurp_personal_org_is_empty('missing') as d"))
      .toEqual([{ a: true, b: true, c: false, d: false }]);
    await db.exec("insert into api_keys (id, user_id, org_id, key_hash, name) values ('k-solo', 'solo', 'p-solo', 'h10', 'n')");
    expect(await rows("select docslurp_personal_org_is_empty('p-solo') as a")).toEqual([{ a: false }]);
  });
});

describe("pre-deploy report of 0127", () => {
  it("lists every affected user, the kept and removed organizations, promotions and memberless organizations", () => {
    const text = report.lines.join("\n");
    expect(report.title).toBe("Memberships beyond one per user (0127): 8 user(s), 8 membership(s) to remove");
    expect(text).toContain("2 in tombstoned organizations; 2 in empty personal organizations");
    expect(text).toContain("4 more removed by the keep rule");
    expect(text).toContain(`u@example.test (sole-owner): keeps "T4" (t4); removed from "T3" (t3, not_kept, owner, FUNDED, 1 key(s), 0 grant(s), 1 workspace(s) handed over)`);
    expect(text).toContain(`z@example.test (only-tomb): keeps NO organization`);
    expect(text).toContain("Owner promoted (the last owner is removed and members remain): t3 -> a3@example.test (was admin), t5 -> m5a@example.test (was member).");
    expect(text).toContain(`Left with NO member (data kept, nobody can reach it until an operator restores a membership from the backup): "P" (p-data).`);
  });

  it("blocks on a removal from a funded organization until that exact list is acknowledged", () => {
    const hash = fundedRemovalsHash([{ user_id: "sole-owner", org_id: "t3" }]);
    expect(report.level).toBe("blocker");
    expect(report.lines.join("\n")).toContain(`--ack-0127=${hash}`);
    expect(acknowledgedReport.level).toBe("warn");
    expect(acknowledgedReport.lines.join("\n")).toContain(`Acknowledged with --ack-0127=${hash}.`);
    expect(fundedRemovalsHash([{ user_id: "a", org_id: "b" }, { user_id: "c", org_id: "d" }])).toBe(fundedRemovalsHash([{ user_id: "c", org_id: "d" }, { user_id: "a", org_id: "b" }]));
    expect(fundedRemovalsHash([{ user_id: "a", org_id: "b" }])).not.toBe(hash);
  });

  it("counted the rows the migration then changed", () => {
    expect(before).toMatchObject({ memberships: 22, organizations: 12 });
  });
});
