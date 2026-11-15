import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMigratedPostgres } from "../test/migrated-postgres.js";
import { publishSummaryTreeRoot } from "../summary-tree/document-summary.js";

let sql: postgres.Sql<Record<string, unknown>>;
let stop: () => Promise<void>;
beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'root@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'root-test', 'u')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('p', 'o', 'u', 'Project')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values ('r', 'o', 'u', 'p', 'bulk-upload', 'completed', 'completed', '{}')`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
    values ('d', 'o', 'u', 'p', 'r', 'document.md', 'text/markdown', 'd', 'completed')`;
  await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, build_owner)
    values ('d', 'o', 'p', 'r', 'building', 'builder')`;
}, 60_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
const input = { scope: { orgId: 'o', projectId: 'p' }, documentId: 'd', runId: 'r', owner: 'builder', summary: { title: 'Whole document', text: 'Root covers every section.' } };
describe('complete tree root publication', () => {
  it('inserts once and replaces a previous summary without duplicating it', async () => {
    await publishSummaryTreeRoot(sql, input);
    await publishSummaryTreeRoot(sql, { ...input, summary: { title: 'Updated', text: 'Complete replacement.' } });
    const rows = await sql`select summary from document_summaries where document_id = 'd'`;
    expect(rows).toEqual([{ summary: 'Updated\n\nComplete replacement.' }]);
  });
  it('refuses another tenant, project, run or builder without changing the summary', async () => {
    for (const overrides of [
      { scope: { orgId: 'other', projectId: 'p' } }, { scope: { orgId: 'o', projectId: 'other' } },
      { runId: 'other' }, { owner: 'revoked-builder' },
    ]) await expect(publishSummaryTreeRoot(sql, { ...input, ...overrides })).rejects.toThrow();
    expect(await sql`select summary from document_summaries where document_id = 'd'`).toEqual([{ summary: 'Updated\n\nComplete replacement.' }]);
  });
  it('refuses partial and corrected trees, retaining the earlier document summary', async () => {
    await sql`update document_summary_trees set status = 'partial' where document_id = 'd'`;
    await expect(publishSummaryTreeRoot(sql, input)).rejects.toThrow();
    await sql`update document_summary_trees set status = 'building', skip_reason = 'corrected' where document_id = 'd'`;
    await expect(publishSummaryTreeRoot(sql, input)).rejects.toThrow();
  });
});
