import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, serveOnRandomPort, startMigratedPostgres } from "@docslurp/worker/testing";

import { INDEX_NAME, buildSettings, directDatabaseUrl, ensureFoldedIndex, indexState } from "../../db/folded-search-index.mjs";
import { collectReport, pendingMigrations, render } from "../../db/predeploy-check.mjs";

/**
 * The ops scripts of the 0121-0127 release (docs/rollout-0121-0127.md): the concurrent folded-index build is idempotent
 * and repairs an interrupted one, and the pre-deploy report, run against a database the release has not migrated yet
 * (before 0125), finds what it is meant to find without writing anything.
 */
let stop: () => Promise<void>;
let client: pg.Client;
const log = () => undefined;

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
}, 120_000);

afterAll(async () => {
  await client?.end();
  await stop?.();
});

describe("folded-search-index", () => {
  it("does nothing on a dry run, builds the index concurrently, and is a no-op the second time", async () => {
    expect(await indexState(client)).toEqual({ state: "missing", bytes: 0 });
    expect(await ensureFoldedIndex(client, { log, dryRun: true })).toMatchObject({ action: "dry-run", state: "missing" });
    expect(await indexState(client)).toEqual({ state: "missing", bytes: 0 });

    expect(await ensureFoldedIndex(client, { log })).toMatchObject({ action: "built" });
    expect((await indexState(client)).state).toBe("valid");
    expect(await ensureFoldedIndex(client, { log })).toMatchObject({ action: "present" });
  });

  it("drops and rebuilds an invalid index left by an interrupted build", async () => {
    await client.query("update pg_index set indisvalid = false where indexrelid = to_regclass($1)", [`public.${INDEX_NAME}`]);
    expect((await indexState(client)).state).toBe("invalid");
    expect(await ensureFoldedIndex(client, { log })).toMatchObject({ action: "built" });
    expect((await indexState(client)).state).toBe("valid");
  });

  it("serves the query expression the search code uses", async () => {
    await client.query("set enable_seqscan = off");
    const { rows } = await client.query(
      "explain select id from document_chunks c where to_tsvector('simple'::regconfig, docslurp_fold_text(c.text)) @@ websearch_to_tsquery('simple', docslurp_fold_text('Müller'))",
    );
    await client.query("reset enable_seqscan");
    expect(JSON.stringify(rows)).toContain(INDEX_NAME);
  });

  it("reads its settings from the environment and connects to the direct host", () => {
    expect(buildSettings({ FOLDED_INDEX_ATTEMPTS: "0" }).attempts).toBe(1);
    expect(buildSettings({}).lockTimeoutMs).toBe(5_000);
    expect(directDatabaseUrl("postgres://u:p@ep-x-pooler.example.com/db", {})).toBe("postgres://u:p@ep-x.example.com/db");
    expect(directDatabaseUrl("postgres://pooled/db", { MIGRATION_DATABASE_URL: "postgres://direct/db" })).toBe("postgres://direct/db");
  });
});

describe("predeploy-check", () => {
  const journal = JSON.parse(readFileSync(new URL("../../db/migrations/meta/_journal.json", import.meta.url), "utf8"));

  it("lists the migrations newer than the newest applied one", () => {
    const last = journal.entries.at(-1);
    expect(pendingMigrations(journal, last.when)).toEqual([]);
    expect(pendingMigrations(journal, journal.entries.at(-6).when)).toHaveLength(5);
  });

  it("reports blockers and warnings from seeded rows of an unmigrated database and changes nothing", async () => {
    // The report runs before the deploy: a database migrated up to (not including) 0125.
    const old = await createMigratedDatabase({ stopBefore: "tenant_scoped_keys_and_webhooks" });
    const serving = await serveOnRandomPort(old);
    const oldClient = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${serving.port}/postgres` });
    await oldClient.connect();
    try {
      await oldClient.query("set session_replication_role = replica");
      // u1: personal (empty) + two teams it owns; u2: in no organization; u3: only a member of t1.
      await oldClient.query(`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.test'), ('u2', 'B', 'b@example.test'), ('u3', 'C', 'c@example.test')`);
      await oldClient.query(`insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
        ('p1', 'P', 'p1', 'u1', true, 'u1'), ('t1', 'T', 't1', 'u1', false, null), ('t2', 'T', 't2', 'u1', false, null)`);
      await oldClient.query(`insert into org_memberships (org_id, user_id, role) values ('p1', 'u1', 'owner'), ('t1', 'u1', 'owner'), ('t2', 'u1', 'owner'), ('t1', 'u3', 'member')`);
      await oldClient.query(`insert into webhooks (id, user_id, url, secret) values ('w1', 'u1', 'https://x.test', 's'), ('w2', 'u2', 'https://x.test', 's'), ('w3', 'u3', 'https://x.test', 's')`);
      await oldClient.query(`insert into workspaces (id, user_id, org_id, name, pipeline) values ('ws1', 'u1', 't1', 'W', '{"piiPolicy":{"patterns":["ssn","email-address"]}}')`);
      await oldClient.query(`insert into workspace_runs (id, workspace_id, user_id, org_id, kind, status, stage, pipeline, artifacts) values
        ('r1', 'ws1', 'u1', 't1', 'bulk-upload', 'processing', 'x', '{}', '{"run:vision-routing-version":"v2"}'),
        ('r2', 'ws1', 'u1', 't2', 'bulk-upload', 'queued', 'x', '{}', '{}')`);
      await oldClient.query(`insert into api_keys (id, user_id, org_id, key_hash, name, revoked_at) values ('k1', 'u1', null, 'h', 'n', now()), ('k3', 'u3', null, 'h3', 'n', null)`);
      await oldClient.query(`insert into document_run_stage_states (run_id, document_id, stage_name, status) values ('r1', 'd1', 'extract-markdown', 'completed')`);
      await oldClient.query("set session_replication_role = origin");
      await oldClient.query("analyze");

      const counts = "select (select count(*) from webhooks) w, (select count(*) from api_keys) k, (select count(*) from workspace_runs) r, (select count(*) from org_memberships) m";
      const before = await oldClient.query(counts);
      const { piiPatternTypeSchema } = await import("@docslurp/shared");
      await oldClient.query("begin read only");
      const sections = await collectReport(oldClient, { journal, acceptedPiiPatterns: piiPatternTypeSchema.options });
      await oldClient.query("rollback");
      expect((await oldClient.query(counts)).rows).toEqual(before.rows);

      const byTitle = (prefix: string) => sections.find((section: { title: string }) => section.title.startsWith(prefix))!;
      expect(byTitle("Stored pipelines").level).toBe("blocker");
      expect(byTitle("Stored pipelines").lines.join("\n")).toContain('"email-address"');
      // w1: u1 is in three orgs; w2: u2 in none; w3: u3 only a member. All three are deleted.
      expect(byTitle("webhooks").title).toContain("by 0125: 3");
      expect(byTitle("webhooks").level).toBe("warn");
      expect(byTitle("webhooks").lines.join("\n")).toContain("0 will be homed");
      expect(byTitle("webhooks").lines.join("\n")).toContain("3 will be DELETED");
      // k3: u3 has one org, so it is homed (revoked); k1: u1 has three, so it is deleted.
      expect(byTitle("api_keys").title).toContain("2 (1 not yet revoked)");
      expect(byTitle("api_keys").lines.join("\n")).toContain("1 will be homed (revoked); 1 will be DELETED");
      // u1: its empty personal org goes, then one of t1/t2 is kept.
      const memberships = byTitle("Memberships beyond one per user");
      expect(memberships.level).toBe("warn");
      expect(memberships.title).toContain("1 user(s), 2 membership(s) to remove");
      expect(memberships.lines.join("\n")).toContain("1 in empty personal organizations");
      expect(byTitle("Completed stage states").level).toBe("warn");
      expect(byTitle("Runs in flight").title).toContain("v2=1");
      expect(byTitle("Runs in flight").title).toContain("(none)=1");
      // The harness applies the SQL files without drizzle's bookkeeping table, so every journal entry reads as pending.
      expect(byTitle("Migrations").title).toContain(`${journal.entries.length} pending`);
      expect(render(sections)).toContain("[BLOCKER] Stored pipelines");
    } finally {
      await oldClient.end();
      await serving.server.stop();
      await old.close();
    }
  }, 120_000);

  it("reports 0125 and 0127 as done on a migrated database", async () => {
    const { piiPatternTypeSchema } = await import("@docslurp/shared");
    await client.query("begin read only");
    const sections = await collectReport(client, { journal, acceptedPiiPatterns: piiPatternTypeSchema.options });
    await client.query("rollback");
    const byTitle = (prefix: string) => sections.find((section: { title: string }) => section.title.startsWith(prefix))!;
    expect(byTitle("api_keys").level).toBe("ok");
    expect(byTitle("webhooks").level).toBe("ok");
    expect(byTitle("Memberships beyond one per user").title).toContain("already applied");
  });
});
