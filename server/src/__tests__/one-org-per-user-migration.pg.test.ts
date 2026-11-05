import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0127 on real PostgreSQL, through the real migrator and pre-deploy processes. The database is a fresh copy of a
 * template migrated to the latest migration; the test rewinds 0127 (drops its index, forgets its journal row), seeds the
 * shapes the first version of 0127 got wrong, and re-applies it with `node server/db/migrate.mjs`:
 *   - a personal organization whose only "data" is a default workspace with a chat session is not empty;
 *   - a personal organization with another member is not empty, so that member is never cascaded out;
 *   - a truly empty personal organization goes with its default workspace (no foreign key would remove it), backed up;
 *   - a removal from an organization with auto top-up (funded) needs DOCSLURP_ACK_0127 equal to the hash the pre-deploy
 *     report prints: missing, stale or malformed, the migrator aborts and changes nothing.
 */
const url = process.env.ONE_ORG_MIGRATION_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const journal = JSON.parse(readFileSync(new URL("../../db/migrations/meta/_journal.json", import.meta.url), "utf8"));
const when0127 = journal.entries.find((entry: { tag: string }) => entry.tag.startsWith("0127_")).when as number;

let client: pg.Client;
const rows = async <T = Record<string, unknown>>(text: string) => (await client.query(text)).rows as T[];
const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: url!, ...env },
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
};
const MEMBERSHIPS = `select user_id, org_id, role from org_memberships where user_id like 'pg127-%' order by user_id collate "C", org_id collate "C"`;
let before: { user_id: string; org_id: string; role: string }[];
let report: { status: number | null; out: string };
let ackHash: string;

describe.skipIf(!url)("0127 one organization per user, on PostgreSQL through migrate.mjs", () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    // Rewind 0127 (the template has it applied) so the migrator applies it again over the seeded rows.
    await client.query("drop index if exists org_memberships_one_org_per_user");
    await client.query("delete from drizzle.__drizzle_migrations where created_at >= $1", [when0127]);
    await client.query(`
      insert into "user"(id, name, email) values
        ('pg127-chat', 'C', 'pg127-chat@example.test'), ('pg127-host', 'H', 'pg127-host@example.test'),
        ('pg127-guest', 'G', 'pg127-guest@example.test'), ('pg127-empty', 'E', 'pg127-empty@example.test'),
        ('pg127-team-owner', 'O', 'pg127-owner@example.test'), ('pg127-fund', 'F', 'pg127-fund@example.test'),
        ('pg127-fadmin', 'A', 'pg127-fadmin@example.test');
      insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
        ('pg127-p-chat', 'Chat Personal', 'pg127-p-chat', 'pg127-chat', true, 'pg127-chat'),
        ('pg127-p-host', 'Host Personal', 'pg127-p-host', 'pg127-host', true, 'pg127-host'),
        ('pg127-p-guest', 'Guest Personal', 'pg127-p-guest', 'pg127-guest', true, 'pg127-guest'),
        ('pg127-p-empty', 'Empty Personal', 'pg127-p-empty', 'pg127-empty', true, 'pg127-empty'),
        ('pg127-team', 'Team', 'pg127-team', 'pg127-team-owner', false, null),
        ('pg127-funded', 'Funded Team', 'pg127-funded', 'pg127-fund', false, null);
      -- Auto top-up counts as funded, in the migration and in the report alike.
      update organizations set auto_recharge_enabled = true where id = 'pg127-funded';
      insert into org_memberships (org_id, user_id, role, created_at) values
        ('pg127-team', 'pg127-team-owner', 'owner', now() - interval '30 days'),
        ('pg127-p-chat', 'pg127-chat', 'owner', now()), ('pg127-team', 'pg127-chat', 'member', now()),
        ('pg127-p-host', 'pg127-host', 'owner', now()), ('pg127-team', 'pg127-host', 'member', now()),
        ('pg127-p-guest', 'pg127-guest', 'owner', now()), ('pg127-p-host', 'pg127-guest', 'member', now()),
        ('pg127-p-empty', 'pg127-empty', 'owner', now()), ('pg127-team', 'pg127-empty', 'member', now()),
        ('pg127-funded', 'pg127-fund', 'owner', now() - interval '20 days'), ('pg127-funded', 'pg127-fadmin', 'admin', now() - interval '10 days'),
        ('pg127-team', 'pg127-fund', 'member', now());
      insert into workspaces (id, org_id, user_id, name, is_default) values
        ('pg127-ws-chat', 'pg127-p-chat', 'pg127-chat', 'Default', true),
        ('pg127-ws-host', 'pg127-p-host', 'pg127-host', 'Default', true),
        ('pg127-ws-guest', 'pg127-p-guest', 'pg127-guest', 'Default', true),
        ('pg127-ws-empty', 'pg127-p-empty', 'pg127-empty', 'Default', true),
        ('pg127-ws-team', 'pg127-team', 'pg127-team-owner', 'Default', true),
        ('pg127-ws-funded', 'pg127-funded', 'pg127-fund', 'Default', true);
      insert into chat_sessions (id, workspace_id, user_id) values ('pg127-chat-session', 'pg127-ws-chat', 'pg127-chat');
      insert into workspace_runs (id, workspace_id, user_id, org_id, kind, status, stage, pipeline, created_at) values
        ('pg127-run-team', 'pg127-ws-team', 'pg127-team-owner', 'pg127-team', 'upload', 'completed', 'completed', '{}'::jsonb, now());
      analyze;
    `);
    before = await rows(MEMBERSHIPS);
    report = run("server/db/predeploy-check.mjs", ["--strict", "--redact"]);
    ackHash = /--ack-0127=([0-9a-f]{16})/.exec(report.out)?.[1] ?? "";
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  it("reports the funded removal as a BLOCKER, by id only, with the hash the migration demands", () => {
    expect(report.status).toBe(1);
    expect(report.out).toMatch(/\[BLOCKER\] Memberships beyond one per user \(0127\)/);
    expect(ackHash).toMatch(/^[0-9a-f]{16}$/);
    expect(report.out).toContain("1 removal(s) from a FUNDED organization (paid balance or auto top-up): user pg127-fund from pg127-funded.");
    expect(report.out).toContain("user pg127-guest: keeps pg127-p-host; removed from pg127-p-guest (empty_personal_organization, owner, 0 key(s), 0 grant(s), 1 empty workspace(s) deleted)");
    // A workspace is "handed over" only when the organization keeps an owner to take it.
    expect(report.out).toContain("user pg127-fund: keeps pg127-team; removed from pg127-funded (not_kept, owner, FUNDED, 0 key(s), 0 grant(s), 1 workspace(s) handed over)");
    expect(report.out).toContain("user pg127-chat: keeps pg127-team; removed from pg127-p-chat (not_kept, owner, 0 key(s), 0 grant(s), 1 workspace(s) left with no owner to hand them to)");
    expect(report.out).not.toMatch(/@example\.test|Funded Team|Chat Personal/);
  });

  it("aborts 0127 with no acknowledgement, a stale one or a malformed one, and changes nothing", async () => {
    const missing = run("server/db/migrate.mjs", []);
    expect(missing.status).toBe(1);
    expect(missing.out).toMatch(/0127 refused: it would remove 1 membership\(s\) from funded organizations and promote 0 plain member\(s\) to owner without an acknowledgement/);
    const stale = run("server/db/migrate.mjs", [], { DOCSLURP_ACK_0127: "0123456789abcdef" });
    expect(stale.status).toBe(1);
    expect(stale.out).toMatch(/DOCSLURP_ACK_0127=0123456789abcdef does not match the current plan/);
    const malformed = run("server/db/migrate.mjs", [], { DOCSLURP_ACK_0127: "yes" });
    expect(malformed.status).toBe(1);
    expect(malformed.out).toMatch(/DOCSLURP_ACK_0127 must be the 16-hex-digit hash/);
    expect(await rows(MEMBERSHIPS)).toEqual(before);
    expect(await rows("select to_regclass('public.org_memberships_one_org_per_user') is null as absent")).toEqual([{ absent: true }]);
    expect(await rows("select count(*)::int as n from organizations where id like 'pg127-%'")).toEqual([{ n: 6 }]);
  });

  describe("with the acknowledgement", () => {
    let applied: { status: number | null; out: string };
    beforeAll(() => {
      applied = run("server/db/migrate.mjs", [], { DOCSLURP_ACK_0127: ackHash });
    }, 180_000);

    it("applies", () => {
      expect(applied.out).toContain("[migrate] complete");
      expect(applied.status).toBe(0);
    });

    it("keeps one membership per user and leaves nobody without one", async () => {
      expect(await rows(MEMBERSHIPS)).toEqual([
        { user_id: "pg127-chat", org_id: "pg127-team", role: "member" },
        { user_id: "pg127-empty", org_id: "pg127-team", role: "member" },
        { user_id: "pg127-fadmin", org_id: "pg127-funded", role: "owner" },
        { user_id: "pg127-fund", org_id: "pg127-team", role: "member" },
        // The guest of a personal organization keeps it: an organization with another member is not empty.
        { user_id: "pg127-guest", org_id: "pg127-p-host", role: "member" },
        { user_id: "pg127-host", org_id: "pg127-team", role: "member" },
        { user_id: "pg127-team-owner", org_id: "pg127-team", role: "owner" },
      ]);
      expect(await rows(`select u.id from "user" u where u.id like 'pg127-%'
        and not exists (select 1 from org_memberships om where om.user_id = u.id)`)).toEqual([]);
    });

    it("keeps the personal organization with a chat, and its workspace and chat", async () => {
      expect(await rows("select id from organizations where id like 'pg127-%' order by id")).toEqual(
        ["pg127-funded", "pg127-p-chat", "pg127-p-host", "pg127-team"].map((id) => ({ id })),
      );
      expect(await rows("select id, workspace_id from chat_sessions where id = 'pg127-chat-session'")).toEqual([{ id: "pg127-chat-session", workspace_id: "pg127-ws-chat" }]);
      // Handed over where an owner remains (the promoted admin), left in place where none does.
      expect(await rows("select id, user_id from workspaces where id in ('pg127-ws-funded', 'pg127-ws-chat') order by id")).toEqual([
        { id: "pg127-ws-chat", user_id: "pg127-chat" }, { id: "pg127-ws-funded", user_id: "pg127-fadmin" },
      ]);
    });

    it("deletes an empty personal organization with its default workspace, backed up, and orphans no workspace", async () => {
      expect(await rows("select id from workspaces where id like 'pg127-%' order by id")).toEqual(
        ["pg127-ws-chat", "pg127-ws-funded", "pg127-ws-host", "pg127-ws-team"].map((id) => ({ id })),
      );
      expect(await rows("select count(*)::int as n from workspaces w where w.org_id is not null and not exists (select 1 from organizations o where o.id = w.org_id)")).toEqual([{ n: 0 }]);
      expect(await rows(`select org_id, organization ->> 'name' as name, jsonb_path_query_array(workspaces, '$[*].id') as workspaces, reason
        from organizations_removed_backup where org_id like 'pg127-%' order by org_id`)).toEqual([
        { org_id: "pg127-p-empty", name: "Empty Personal", workspaces: ["pg127-ws-empty"], reason: "empty_personal_organization" },
        { org_id: "pg127-p-guest", name: "Guest Personal", workspaces: ["pg127-ws-guest"], reason: "empty_personal_organization" },
      ]);
    });

    it("then reports 0127 as applied", () => {
      const after = run("server/db/predeploy-check.mjs", ["--strict", "--redact"]);
      expect(after.out).toContain("[OK     ] Memberships beyond one per user (0127): already applied");
    });
  });
});
