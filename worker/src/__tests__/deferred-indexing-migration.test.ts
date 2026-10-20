import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedDatabase,
  migrationJournalProblems,
  readMigrationJournal,
} from "../test/migrated-db.js";

describe("migration 0064 deferred indexing modes", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
      insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
      insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
      insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
        values ('d1', 'o1', 'u1', 'w', 'run-1', 'a.pdf', 'application/pdf', 'k1', 'processing', 3);
    `);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("keeps the journal consistent", () => {
    expect(migrationJournalProblems(readMigrationJournal())).toEqual([]);
  });

  it("defaults indexing_mode to full and key policy to {}", async () => {
    const doc = await db.query<{ indexing_mode: string }>(`select indexing_mode from documents where id = 'd1'`);
    expect(doc.rows[0]!.indexing_mode).toBe("full");
    await db.exec(`insert into api_keys (id, user_id, key_hash, name) values ('k1', 'u1', 'h1', 'n')`);
    const key = await db.query<{ materialization_policy: unknown }>(
      `select materialization_policy from api_keys where id = 'k1'`,
    );
    expect(key.rows[0]!.materialization_policy).toEqual({});
    await expect(db.exec(`update documents set indexing_mode = 'bogus' where id = 'd1'`)).rejects.toThrow();
  });

  it("has the fee-billing ledger columns and the deferred-documents partial index (C3, M6)", async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'document_page_states' and column_name in ('fee_billed_run','fee_billed_at')`);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["fee_billed_at", "fee_billed_run"]);
    const idx = await db.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'documents_workspace_deferred_idx'`);
    expect(idx.rows[0]?.indexdef).toMatch(/\(workspace_id\).*indexing_mode/);
  });

  it("stores page states, maps and vectors, rejects bad state, and cascades on delete", async () => {
    await db.exec(`
      insert into document_page_states (document_id, page_number) values ('d1', 1);
      insert into document_maps (document_id, run_id, nodes, search_text)
        values ('d1', 'run-1', '[]'::jsonb, to_tsvector('english', 'chapter one'));
      insert into document_page_vectors (document_id, page_number, model, dims, bits, int8, scale, workspace_id, org_id)
        values ('d1', 1, 'm', 8, '\\x01'::bytea, '\\x0102'::bytea, 0.5, 'w', 'o1');
    `);
    const state = await db.query<{ state: string; cost_credits: string; attempts: number }>(
      `select state, cost_credits::text, attempts from document_page_states where document_id = 'd1'`,
    );
    expect(state.rows[0]).toEqual({ state: "unseen", cost_credits: "0.0000", attempts: 0 });
    await expect(
      db.exec(`insert into document_page_states (document_id, page_number, state) values ('d1', 2, 'nope')`),
    ).rejects.toThrow();
    await expect(
      db.exec(`insert into document_page_states (document_id, page_number) values ('d1', 0)`),
    ).rejects.toThrow();

    await db.exec(`delete from documents where id = 'd1'`);
    for (const table of ["document_page_states", "document_maps", "document_page_vectors"]) {
      const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(rows[0]!.n, table).toBe(0);
    }
  });
});
