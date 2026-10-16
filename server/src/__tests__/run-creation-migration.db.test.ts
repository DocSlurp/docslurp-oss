import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";
import { expect, it } from "vitest";

it("backfills readiness for complete legacy manifests without publishing incomplete queued Runs", async () => {
  const db = await createMigratedDatabase({ stopBefore: "run_creation_readiness" });
  try {
    await db.exec(`
      insert into "user" (id, name, email) values ('u', 'U', 'u@example.test');
      insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u');
      insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W');
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents)
      values ('complete', 'o', 'u', 'w', 'bulk-upload', 'queued', 'queued', 1),
        ('partial', 'o', 'u', 'w', 'bulk-upload', 'queued', 'queued', 2),
        ('started', 'o', 'u', 'w', 'bulk-upload', 'processing', 'extract', 2);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values ('d1', 'o', 'u', 'w', 'complete', 'a.pdf', 'application/pdf', 'raw/a.pdf', 'queued'),
        ('d2', 'o', 'u', 'w', 'partial', 'b.pdf', 'application/pdf', 'raw/b.pdf', 'queued');
    `);
    await applyRemainingMigrations(db, "run_creation_readiness");
    expect((await db.query(`select id, creation_ready_at is not null as ready,
      creation_expires_at is not null as pending from workspace_runs order by id`)).rows)
      .toEqual([
        { id: "complete", ready: true, pending: false },
        { id: "partial", ready: false, pending: true },
        { id: "started", ready: true, pending: false },
      ]);
  } finally { await db.close(); }
}, 120_000);
