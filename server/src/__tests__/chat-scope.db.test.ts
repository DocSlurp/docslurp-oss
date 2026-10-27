import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let scope: typeof import("../services/chat-scope.js");

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  scope = await import("../services/chat-scope.js");
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'scope@example.test'), ('other', 'Other', 'other-scope@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'scope', 'u'), ('foreign', 'Foreign', 'foreign-scope', 'other')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Public'), ('foreign-w', 'foreign', 'other', 'Foreign')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}'),
      ('foreign-r', 'foreign', 'other', 'foreign-w', 'bulk-upload', 'completed', 'completed', '{}')`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

it.each(["archived", "purged", "superseded", "failed", "cancelled", "pii_blocked", "foreign"])("never exposes %s document titles or headings in a public decline", async (excluded) => {
  await sql`delete from document_chunks`;
  await sql`delete from documents`;
  const foreign = excluded === "foreign";
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, metadata, archived_at, purged_at, superseded_at)
    values ('secret', ${foreign ? "foreign" : "o"}, ${foreign ? "other" : "u"}, ${foreign ? "foreign-w" : "w"}, ${foreign ? "foreign-r" : "r"},
      'Confidential acquisition.pdf', 'application/pdf', 'secret',
      ${["failed", "cancelled", "pii_blocked"].includes(excluded) ? excluded : "completed"},
      '{"title":"Confidential acquisition"}', ${excluded === "archived" ? new Date() : null},
      ${excluded === "purged" ? new Date() : null}, ${excluded === "superseded" ? new Date() : null})`;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate, heading_path)
    values ('secret-c', 'secret', ${foreign ? "foreign-r" : "r"}, ${foreign ? "other" : "u"}, 0, 'Classified body', 2, ${["Secret merger price"]})`;
  const suggestions = await scope.loadScopeSuggestions("w");
  expect(suggestions).toEqual(["What topics do the documents in this workspace cover?"]);
  const decline = scope.buildScopeDeclineAnswer({ workspaceName: "Public" }, suggestions).answer;
  expect(decline).not.toMatch(/Confidential|Secret merger|Classified/);

  // Test the filename fallback too, not only extracted titles.
  await sql`update documents set metadata = '{}' where id = 'secret'`;
  expect(await scope.loadScopeSuggestions("w")).toEqual(suggestions);

  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    values ('live', 'o', 'u', 'w', 'r', 'Public handbook.pdf', 'application/pdf', 'live', 'completed')`;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate, heading_path)
    values ('live-c', 'live', 'r', 'u', 0, 'Public body', 2, ${["Public benefits"]})`;
  expect(await scope.loadScopeSuggestions("w")).toEqual([
    'What does “Public handbook” cover?', 'What do the documents say about “Public benefits”?',
  ]);
});
