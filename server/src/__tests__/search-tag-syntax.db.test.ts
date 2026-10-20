import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let stop: () => Promise<void>;
let sql: postgres.Sql;
let hybridSearch: typeof import("../services/search.js").hybridSearch;

beforeAll(async () => {
  for (const key of ["OPENROUTER_API_KEY", "OPENROUTER_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(key, "");
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('syntax-user', 'Syntax', 'syntax@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('syntax-org', 'Syntax', 'syntax', 'syntax-user')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('syntax-org', 'syntax-user', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('syntax-workspace', 'syntax-org', 'syntax-user', 'Syntax')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values ('syntax-run', 'syntax-org', 'syntax-user', 'syntax-workspace', 'bulk-upload', 'completed', 'index', '{}'::jsonb)`;
  for (const [id, tag] of [["finance", "finance"], ["other", "other"], ["quoted", "Finance Team"]]) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values (${id}, 'syntax-org', 'syntax-user', 'syntax-workspace', 'syntax-run', ${`${id}.pdf`}, 'application/pdf', ${id}, 'completed', 1)`;
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, token_estimate, metadata)
      values (${`${id}-chunk`}, ${id}, 'syntax-run', 'syntax-user', 0, 'The budget includes travel expenses.', '{}', 8, '{}'::jsonb)`;
    await sql`insert into document_tags (document_id, user_id, tag) values (${id}, 'syntax-user', ${tag})`;
  }
  ({ hybridSearch } = await import("../services/search.js"));
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  vi.unstubAllEnvs();
});

it("retrieves ordinary budget text using a tag label as scope rather than relevance text", async () => {
  const result = await hybridSearch("budget tag:finance", "syntax-user", {
    filters: { workspaceId: "syntax-workspace" }, selfQuery: true,
    queryVector: [], useRerank: true, useMmr: false, parentRetrieval: false,
  });
  expect(result.results.map((hit) => hit.citation.documentId)).toEqual(["finance"]);
  expect(result.results[0]?.relevance).toBe(1);
});

it("preserves case and spaces in quoted tag labels", async () => {
  const result = await hybridSearch('budget tag:"Finance Team"', "syntax-user", {
    filters: { workspaceId: "syntax-workspace" }, selfQuery: true,
    queryVector: [], useRerank: true, parentRetrieval: false,
  });
  expect(result.results.map((hit) => hit.citation.documentId)).toEqual(["quoted"]);
  expect(result.results[0]?.relevance).toBe(1);
});

it("keeps explicit caller tag filters authoritative over query labels", async () => {
  const result = await hybridSearch("budget tag:finance", "syntax-user", {
    filters: { workspaceId: "syntax-workspace", tags: ["other"] }, selfQuery: true,
    queryVector: [], useRerank: true, parentRetrieval: false,
  });
  expect(result.results.map((hit) => hit.citation.documentId)).toEqual(["other"]);
  expect(result.results[0]?.relevance).toBe(1);
});

it("rejects malformed and tag-only searches instead of widening their scope", async () => {
  for (const query of ["budget tag:", 'budget tag:"Finance Team', 'budget tag:"finance"suffix', "budget tag:finance,other", "tag:finance"]) {
    await expect(hybridSearch(query, "syntax-user", {
      filters: { workspaceId: "syntax-workspace" }, selfQuery: true, queryVector: [],
    })).rejects.toMatchObject({ name: "InvalidRetrievalQueryError" });
  }
});
