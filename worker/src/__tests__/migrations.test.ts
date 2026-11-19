import { describe, expect, it } from "vitest";

import { applyRemainingMigrations, createMigratedDatabase, migrationNameProblems, readMigrationTags } from "../test/migrated-db.js";

describe("server/db/migrations file names", () => {
  it("are numbered (frozen) or UTC-timestamped, and apply in name order", () => {
    const tags = readMigrationTags();
    expect(migrationNameProblems(tags)).toEqual([]);
    expect(tags[0]).toBe("0000_current_schema");
    expect([...tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(tags);
  });

  it("flags names the runner would refuse", () => {
    expect(migrationNameProblems(["0001_ok", "20261118T1443_ok", "2026-11-18_dashes", "20261118T1443_Upper", "notes"])).toEqual([
      "2026-11-18_dashes: expected NNNN_name (frozen) or YYYYMMDDTHHMM_name",
      "20261118T1443_Upper: expected NNNN_name (frozen) or YYYYMMDDTHHMM_name",
      "notes: expected NNNN_name (frozen) or YYYYMMDDTHHMM_name",
    ]);
  });
});

/** server/db/migrations is the only schema source: it must build a working database from nothing. */
describe("server/db/migrations", () => {
  it("applies in order from an empty database", async () => {
    const db = await createMigratedDatabase();
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const table of ["projects", "project_slugs", "documents", "project_corpus_stats", "document_cleanup_queue", "webhook_outbox", "chat_message_feedback", "budget_alerts"]) {
      expect(names, table).toContain(table);
    }
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'projects' and column_name in ('is_default', 'slug')",
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(["is_default", "slug"]);
    await db.close();
  }, 120_000);
});


describe("starter credit allowance", () => {
  it("reduces future grants, preserves existing balances, and prevents repeat grants", async () => {
    const db = await createMigratedDatabase({ stopBefore: "starter_credit_100" });
    try {
      await db.exec(`
        insert into "user" (id, name, email) values ('old', 'Old', 'old@example.test'), ('new', 'New', 'new@example.test');
        insert into organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
          values ('old-org', 'Old', true, 'old', 'old');
      `);
      await applyRemainingMigrations(db, "starter_credit_100");
      await db.exec(`insert into organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
        values ('new-org', 'New', true, 'new', 'new');`);
      expect((await db.query(`select id, credit_balance_cents::float8 as credits from organizations order by id`)).rows)
        .toEqual([{ id: "new-org", credits: 100 }, { id: "old-org", credits: 250 }]);
      expect((await db.query(`select credits::float8 as credits from credit_grants where org_id = 'new-org'`)).rows)
        .toEqual([{ credits: 100 }]);
      expect((await db.query(`select delta::float8 as dollars, (metadata->>'amountCents')::int as credits
        from credit_ledger where org_id = 'new-org'`)).rows).toEqual([{ dollars: 1, credits: 100 }]);
      await db.exec(`delete from organizations where id = 'new-org';
        insert into organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
          values ('recreated', 'New', true, 'new', 'new');`);
      expect((await db.query(`select credit_balance_cents::float8 as credits from organizations where id = 'recreated'`)).rows)
        .toEqual([{ credits: 0 }]);
    } finally { await db.close(); }
  }, 120_000);
});
