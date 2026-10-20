import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

// LanceDB is an external storage adapter; keep SQL scope and hydration real.
vi.mock("../search/lancedb.js", () => ({
  lanceDbVectorSearch: vi.fn(async (args: { documentIds?: string[] }) => args.documentIds
    ? []
    : [{ id: "other-chunk", documentId: "other", chunkIndex: 0, score: 1 }]),
}));

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
  for (const [id, tag] of [["finance", "finance"], ["other", "other"]]) {
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

it("keeps an explicit document selection when summary seeds point to a different document", async () => {
  for (const selection of [{ documentIds: ["finance"] }, { documentId: "finance" }]) {
    const result = await hybridSearch("budget", "syntax-user", {
      filters: { workspaceId: "syntax-workspace", ...selection },
      summarySeed: true, queryVector: [], parentRetrieval: false, useRerank: false,
    });
    expect(result.results.map((hit) => hit.citation.documentId)).toEqual(["finance"]);
  }
});
