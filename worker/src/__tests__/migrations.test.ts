import { describe, expect, it } from "vitest";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createMigratedDatabase, migrationJournalProblems, readMigrationJournal } from "../test/migrated-db.js";

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
