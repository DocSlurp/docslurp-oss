import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let loadChatProjectInventory: typeof import("../services/chat-project-inventory.js").loadChatProjectInventory;

beforeAll(async () => {
  const db = await startMigratedPostgres(); stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  ({ loadChatProjectInventory } = await import("../services/chat-project-inventory.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('w', 'o', 'u', 'W'), ('other', 'o', 'u', 'Other')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
    values ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}'::jsonb, 6, 6)`;
  const doc = (id: string, project: string, status: string) => sql`
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
    values (${id}, 'o', 'u', ${project}, 'r', ${`${id}.pdf`}, 'application/pdf', ${`u/raw/${id}.pdf`}, ${status}, 1)`;
  for (const [id, project, status] of [["live-failed", "w", "failed"], ["replaced", "w", "failed"], ["archived", "w", "failed"],
    ["purged", "w", "failed"], ["queued", "w", "queued"], ["done", "w", "completed"], ["elsewhere", "other", "failed"]] as const) await doc(id, project, status);
  await sql`update documents set superseded_at = now() where id = 'replaced'`;
  await sql`update documents set archived_at = now() where id = 'archived'`;
  await sql`update documents set purged_at = now() where id = 'purged'`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

it("counts only current failed versions in the project, and only when asked", async () => {
  await expect(loadChatProjectInventory("w", true)).resolves.toMatchObject({ processingDocuments: 1, failedDocuments: 1 });
  await expect(loadChatProjectInventory("w", false)).resolves.toMatchObject({ failedDocuments: 0 });
});

it("reads the failed count from the partial index", async () => {
  await sql`set enable_seqscan = off`;
  const plan = await sql.unsafe(`explain select count(*) from documents where project_id = 'w' and status = 'failed'
    and superseded_at is null and archived_at is null and purged_at is null`);
  await sql`reset enable_seqscan`;
  expect(plan.map(row => Object.values(row)[0]).join("\n")).toContain("documents_project_failed_idx");
});
