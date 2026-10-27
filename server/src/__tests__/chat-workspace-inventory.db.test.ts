import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let loadChatWorkspaceInventory: typeof import("../services/chat-workspace-inventory.js").loadChatWorkspaceInventory;

beforeAll(async () => {
  const db = await startMigratedPostgres(); stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  ({ loadChatWorkspaceInventory } = await import("../services/chat-workspace-inventory.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W'), ('other', 'o', 'u', 'Other')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
    values ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}'::jsonb, 6, 6)`;
  const doc = (id: string, workspace: string, status: string) => sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
    values (${id}, 'o', 'u', ${workspace}, 'r', ${`${id}.pdf`}, 'application/pdf', ${`u/raw/${id}.pdf`}, ${status}, 1)`;
  for (const [id, workspace, status] of [["live-failed", "w", "failed"], ["replaced", "w", "failed"], ["archived", "w", "failed"],
    ["purged", "w", "failed"], ["queued", "w", "queued"], ["done", "w", "completed"], ["elsewhere", "other", "failed"]] as const) await doc(id, workspace, status);
  await sql`update documents set superseded_at = now() where id = 'replaced'`;
  await sql`update documents set archived_at = now() where id = 'archived'`;
  await sql`update documents set purged_at = now() where id = 'purged'`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

it("counts only current failed versions in the workspace, and only when asked", async () => {
  await expect(loadChatWorkspaceInventory("w", true)).resolves.toMatchObject({ processingDocuments: 1, failedDocuments: 1 });
  await expect(loadChatWorkspaceInventory("w", false)).resolves.toMatchObject({ failedDocuments: 0 });
});

it("reads the failed count from the partial index", async () => {
  await sql`set enable_seqscan = off`;
  const plan = await sql.unsafe(`explain select count(*) from documents where workspace_id = 'w' and status = 'failed'
    and superseded_at is null and archived_at is null and purged_at is null`);
  await sql`reset enable_seqscan`;
  expect(plan.map(row => Object.values(row)[0]).join("\n")).toContain("documents_workspace_failed_idx");
});
