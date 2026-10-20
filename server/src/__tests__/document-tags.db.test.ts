import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let search: typeof import("../services/search.js");
let tags: typeof import("../services/workspace-tags.js");
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  resolveOpenRouterApiKey: () => undefined,
  embedConfiguredText: () => { throw new Error("Unexpected inference"); },
  generateOpenRouterText: () => { throw new Error("Unexpected inference"); },
}));
beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'tags@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'tags', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Tags'), ('other', 'o', 'u', 'Other')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}')`;
  for (const id of ["selected", "outside", "old", "foreign"]) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values (${id}, 'o', 'u', ${id === "foreign" ? "other" : "w"}, 'r', ${id + '.txt'}, 'text/plain', ${id}, 'completed')`;
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate)
      values (${id + '-chunk'}, ${id}, 'r', 'u', 0, ${id === "selected" ? "Selected evidence about the annual budget." : "Outside evidence about the annual budget."}, 10)`;
  }
  await sql`update documents set superseded_at = now() where id = 'old'`;
  await sql`insert into document_tags (document_id, user_id, tag) values ('selected', 'u', 'finance'), ('old', 'u', 'finance'), ('foreign', 'u', 'foreign-only')`;
  await sql`insert into kg_nodes (id, workspace_id, run_id, user_id, canonical_name, normalized_name, entity_type) values ('n', 'w', 'r', 'u', 'Budget', 'budget', 'Topic')`;
  for (const id of ["selected", "outside"]) {
    await sql`insert into chunk_entities (chunk_id, workspace_id, run_id, user_id, node_id, entity_name, entity_type) values (${id + '-chunk'}, 'w', 'r', 'u', 'n', 'Budget', 'Topic')`;
  }
  await sql`insert into kg_communities (id, workspace_id, run_id, user_id, label, summary) values ('community', 'w', 'r', 'u', 'Budget', 'Budget summary includes the broader workspace.')`;
  search = await import("../services/search.js");
  tags = await import("../services/workspace-tags.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

it("counts current documents only and isolates workspace tag listings", async () => {
  expect(await tags.listWorkspaceTags("w")).toEqual([{ tag: "finance", documentCount: 1 }]);
  expect(await tags.listWorkspaceTags("other")).toEqual([{ tag: "foreign-only", documentCount: 1 }]);
  expect(await tags.listWorkspaceTags("empty")).toEqual([]);
});

it.each([false, true])("filters document evidence and preserves qualified summaries (GraphRAG %s)", async (graph) => {
  const result = await search.hybridSearch("budget", "u", {
    filters: { workspaceId: "w", tags: ["finance"] }, queryVector: [1, 0, 0],
    limit: 20, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false,
    parentRetrieval: false, useContextualCompression: false, useHyDE: false,
    stepback: false, iterativeMultiHop: false, enableGraphExpansion: graph,
    enableCommunityExpansion: graph,
  });
  const docs = result.results.filter((hit) => hit.citation.source === "document");
  expect(docs.length).toBeGreaterThan(0);
  expect([...new Set(docs.map((hit) => hit.citation.documentId))]).toEqual(["selected"]);
  const summaries = result.results.filter((hit) => hit.citation.source === "community_summary");
  expect(summaries.length).toBe(graph ? 1 : 0);
  if (graph) {
    expect(summaries[0].text).toContain("Broader workspace context");
    expect(summaries[0].text).toContain("Budget summary includes the broader workspace.");
  }
});

it("returns no unrelated document evidence for an unknown tag", async () => {
  const context = await search.loadWorkspaceWholeCorpusContext({ workspaceId: "w", userId: "u", tags: ["missing"] });
  expect(context.results).toEqual([]);
});


it("lets workspace editors replace or remove another uploader's tags", async () => {
  const documents = await import("../services/documents.js");
  await sql`insert into "user" (id, name, email) values ('editor', 'Editor', 'editor@example.test')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'editor', 'admin')`;
  expect(await documents.setDocumentTags("selected", "editor", ["updated"])).toEqual(["updated"]);
  expect(await tags.listWorkspaceTags("w")).toEqual([{ tag: "updated", documentCount: 1 }]);
  expect(await documents.removeDocumentTags(["selected"], "u", ["updated"])).toBe(1);
  expect(await tags.listWorkspaceTags("w")).toEqual([]);
});
