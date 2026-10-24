import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let documents: typeof import("../services/documents.js");

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'owners@example.test'), ('stranger', 'Stranger', 'stranger@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'owners', 'u'), ('o2', 'Other', 'owners-2', 'stranger')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner'), ('o2', 'stranger', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Docs'), ('w2', 'o2', 'stranger', 'Private')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values
    ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}'), ('r2', 'o2', 'stranger', 'w2', 'bulk-upload', 'completed', 'completed', '{}')`;
  for (const [id, workspace, run, user] of [["mine", "w", "r", "u"], ["theirs", "w2", "r2", "stranger"]]) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values (${id}, ${workspace === "w" ? "o" : "o2"}, ${user}, ${workspace}, ${run}, ${id + ".md"}, 'text/markdown', ${id}, 'completed')`;
  }
  documents = await import("../services/documents.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

it("returns the workspace and organization of documents the user can read, and nothing for the rest", async () => {
  expect(await documents.listDocumentOwners(["mine", "theirs", "missing"], "u")).toEqual([{ id: "mine", workspaceId: "w", orgId: "o" }]);
  expect(await documents.listDocumentOwners([], "u")).toEqual([]);
});
