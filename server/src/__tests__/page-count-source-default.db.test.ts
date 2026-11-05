import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";
import { expect, it } from "vitest";

const seed = `
  insert into "user" (id, name, email) values ('u', 'U', 'u@example.test');
  insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u');
  insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W');
  insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents)
  values ('r', 'o', 'u', 'w', 'bulk-upload', 'queued', 'queued', 2);
`;

// Migration 0130: a document inserted without provenance is `assumed` (an estimate the worker replaces), never `counted`. Rows
// written before it keep the value they were given.
it("defaults page_count_source to assumed when an insert omits it, and leaves existing rows alone", async () => {
  const db = await createMigratedDatabase({ stopBefore: "0130_page_count_source_default_assumed" });
  try {
    await db.exec(`${seed}
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values ('before', 'o', 'u', 'w', 'r', 'a.pdf', 'application/pdf', 'raw/a.pdf', 'queued');
    `);
    await applyRemainingMigrations(db, "0130_page_count_source_default_assumed");
    await db.exec(`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values ('after', 'o', 'u', 'w', 'r', 'b.pdf', 'application/pdf', 'raw/b.pdf', 'queued');
    `);
    expect((await db.query(`select id, page_count_source from documents order by id`)).rows).toEqual([
      { id: "after", page_count_source: "assumed" },
      { id: "before", page_count_source: "counted" },
    ]);
  } finally { await db.close(); }
}, 120_000);
