import { describe, expect, it } from "vitest";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applyRemainingMigrations, createMigratedDatabase, migrationJournalProblems, readMigrationJournal } from "../test/migrated-db.js";

describe("server/db/migrations journal", () => {
  it("has contiguous idx values, strictly increasing when stamps and a file per entry", () => {
    const journal = readMigrationJournal();
    expect(migrationJournalProblems(journal)).toEqual([]);
    for (const entry of journal) {
      expect(existsSync(fileURLToPath(new URL(`../../../server/db/migrations/${entry.tag}.sql`, import.meta.url))), entry.tag).toBe(true);
    }
  });

  it("flags entries drizzle-kit would skip or misnumber", () => {
    expect(migrationJournalProblems([
      { idx: 0, when: 100, tag: "0000_a" },
      { idx: 1, when: 300, tag: "0001_b" },
      { idx: 2, when: 200, tag: "0002_older_stamp" },
      { idx: 4, when: 400, tag: "0004_gap" },
      { idx: 4, when: 400, tag: "0005_same_stamp" },
    ])).toEqual([
      "0002_older_stamp: when 200 is not after 0001_b (300)",
      "0004_gap: idx 4, expected 3",
      "0005_same_stamp: when 400 is not after 0004_gap (400)",
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
    for (const table of ["workspaces", "workspace_slugs", "documents", "workspace_corpus_stats", "document_cleanup_queue", "webhook_outbox", "chat_message_feedback", "budget_alerts"]) {
      expect(names, table).toContain(table);
    }
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'workspaces' and column_name in ('is_default', 'slug')",
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(["is_default", "slug"]);
    await db.close();
  }, 120_000);
});


describe("starter credit allowance", () => {
  it("reduces future grants, preserves existing balances, and prevents repeat grants", async () => {
    const db = await createMigratedDatabase({ stopBefore: "starter_credit_250" });
    try {
      await db.exec(`
        insert into "user" (id, name, email) values ('old', 'Old', 'old@example.test'), ('new', 'New', 'new@example.test');
        insert into organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
          values ('old-org', 'Old', true, 'old', 'old');
      `);
      await applyRemainingMigrations(db, "starter_credit_250");
      await db.exec(`insert into organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
        values ('new-org', 'New', true, 'new', 'new');`);
      expect((await db.query(`select id, credit_balance_cents::float8 as credits from organizations order by id`)).rows)
        .toEqual([{ id: "new-org", credits: 250 }, { id: "old-org", credits: 2500 }]);
      expect((await db.query(`select credits::float8 as credits from credit_grants where org_id = 'new-org'`)).rows)
        .toEqual([{ credits: 250 }]);
      expect((await db.query(`select delta::float8 as dollars, (metadata->>'amountCents')::int as credits
        from credit_ledger where org_id = 'new-org'`)).rows).toEqual([{ dollars: 2.5, credits: 250 }]);
      await db.exec(`delete from organizations where id = 'new-org';
        insert into organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
          values ('recreated', 'New', true, 'new', 'new');`);
      expect((await db.query(`select credit_balance_cents::float8 as credits from organizations where id = 'recreated'`)).rows)
        .toEqual([{ credits: 0 }]);
    } finally { await db.close(); }
  }, 120_000);
});
