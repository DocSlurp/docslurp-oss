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
  const db = await createMigratedDatabase({ stopBefore: "0130_page_count_provenance" });
  try {
    await db.exec(`${seed}
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values ('before', 'o', 'u', 'w', 'r', 'a.pdf', 'application/pdf', 'raw/a.pdf', 'queued');
    `);
    await applyRemainingMigrations(db, "0130_page_count_provenance");
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

// Migration 0130: intake_page_count records what admission priced, at insert, and nothing can rewrite it afterwards (the
// worker's measurement updates page_count only). Rows from before 0130 keep NULL.
it("captures intake_page_count at insert and keeps it immutable through measurements and direct writes", async () => {
  const db = await createMigratedDatabase({ stopBefore: "0130_page_count_provenance" });
  try {
    await db.exec(`${seed}
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('legacy', 'o', 'u', 'w', 'r', 'a.pdf', 'application/pdf', 'raw/a.pdf', 'queued', 4);
    `);
    await applyRemainingMigrations(db, "0130_page_count_provenance");
    await db.exec(`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source)
      values ('new', 'o', 'u', 'w', 'r', 'b.pdf', 'application/pdf', 'raw/b.pdf', 'queued', 3, 'assumed');
      update documents set page_count = 5000, page_count_source = 'counted' where id = 'new';
      update documents set intake_page_count = 5000 where id = 'new';
    `);
    expect((await db.query(`select id, page_count, intake_page_count from documents order by id`)).rows).toEqual([
      { id: "legacy", page_count: 4, intake_page_count: null },
      { id: "new", page_count: 5000, intake_page_count: 3 },
    ]);
  } finally { await db.close(); }
}, 120_000);
