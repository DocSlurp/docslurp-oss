import postgres from "postgres";
import { defaultEmbeddingConfig, resolveEmbeddingRoute } from "@docslurp/shared";
import type { SearchFilters } from "../search/filters.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

const { lanceDbVectorSearch } = vi.hoisted(() => ({
  lanceDbVectorSearch: vi.fn<typeof import("../search/lancedb.js").lanceDbVectorSearch>().mockResolvedValue([]),
}));
vi.mock("../search/lancedb.js", () => ({ lanceDbVectorSearch, warmLanceDbSearch: vi.fn(async () => {}) }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let search: typeof import("../services/search.js");
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
      values (${id + '-chunk'}, ${id}, 'r', 'u', 0, ${id === "selected" ? "Selected evidence about the annual budget." : "Outside graph evidence."}, 10)`;
  }
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('r-other', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}')`;
  await sql`update documents set mime_type = 'application/pdf', run_id = 'r-other' where id = 'outside'`;
  await sql`update document_chunks set run_id = 'r-other', page_number = 2, created_at = '2000-01-01' where document_id = 'outside'`;
  await sql`update document_chunks set page_number = 1 where document_id = 'selected'`;
  await sql`update documents set superseded_at = now() where id = 'old'`;
  await sql`insert into document_tags (document_id, user_id, tag) values ('selected', 'u', 'finance'), ('outside', 'u', 'finance'), ('old', 'u', 'finance'), ('foreign', 'u', 'foreign-only')`;
  await sql`insert into kg_nodes (id, workspace_id, run_id, user_id, canonical_name, normalized_name, entity_type) values ('n', 'w', 'r', 'u', 'Budget', 'budget', 'Topic')`;
  for (const id of ["selected", "outside"]) {
    await sql`insert into chunk_entities (chunk_id, workspace_id, run_id, user_id, node_id, entity_name, entity_type) values (${id + '-chunk'}, 'w', 'r', 'u', 'n', 'Budget', 'Topic')`;
  }
  await sql`insert into kg_communities (id, workspace_id, run_id, user_id, label, summary) values ('community', 'w', 'r', 'u', 'Budget', 'Budget summary includes the broader workspace.')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('pages', 'o', 'u', 'Pages')`;
  for (const id of ["page-selected", "page-outside"]) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values (${id}, 'o', 'u', 'pages', 'r', ${id + '.txt'}, ${id === "page-selected" ? "text/plain" : "application/pdf"}, ${id}, 'completed')`;
    await sql`insert into document_tags (document_id, user_id, tag) values (${id}, 'u', 'finance')`;
    await sql`insert into document_pages (id, document_id, run_id, user_id, page_number, text)
      values (${id + '-p'}, ${id}, 'r', 'u', ${id === "page-selected" ? 1 : 2}, 'Budget page evidence.')`;
  }
  await sql`update document_chunks set metadata = '{"language":"en"}', heading_path = array['Allowed'] where id = 'selected-chunk'`;
  for (const [index, page, language, heading, text] of [
    [1, 1, "fr", "Allowed", "EXCLUDED_LANGUAGE"],
    [2, 1, "en", "Other", "EXCLUDED_HEADING"],
    [3, 2, "en", "Allowed", "EXCLUDED_PAGE"],
  ] as const) {
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, page_number, token_estimate, metadata, heading_path)
      values (${`neighbor-${index}`}, 'selected', 'r', 'u', ${index}, ${text}, ${page}, 5,
        ${sql.json({ language })}, ${sql.array([heading])})`;
  }
  await sql`insert into workspace_search_settings (workspace_id, user_id, pinned_results)
    values ('w', 'u', '[{"queryPattern":"budget", "documentId":"outside", "rank":1}]')`;
  search = await import("../services/search.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

it.each([false, true])("intersects tags and document selection for evidence and preserves qualified summaries (GraphRAG %s)", async (graph) => {
  const result = await search.hybridSearch("budget", "u", {
    filters: { workspaceId: "w", tags: ["finance"], documentId: "selected" }, queryVector: [1, 0, 0],
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


it.each([
  ["MIME", { mimeTypes: ["text/plain"] }],
  ["run", { runId: "r" }],
  ["date", { dateRange: { from: "2025-01-01" } }],
  ["page", { pageRange: { from: 1, to: 1 } }],
] satisfies Array<[string, SearchFilters]>)("intersects tags and %s constraints for graph evidence", async (_name, filters) => {
  const result = await search.hybridSearch("budget", "u", {
    filters: { workspaceId: "w", tags: ["finance"], ...filters }, queryVector: [1, 0, 0],
    limit: 20, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false,
    parentRetrieval: false, useContextualCompression: false, useHyDE: false,
    stepback: false, iterativeMultiHop: false, enableGraphExpansion: true,
    enableCommunityExpansion: false,
  });
  expect(result.results.map((hit) => hit.citation.documentId)).toEqual(["selected"]);
});

it("intersects singular and plural document selections even when both match the tag", async () => {
  const result = await search.hybridSearch("evidence", "u", {
    filters: { workspaceId: "w", tags: ["finance"], documentId: "selected", documentIds: ["outside"] },
    queryVector: [1, 0, 0], limit: 20, minScore: 0,
    useRerank: false, queryRewrite: false, selfQuery: false,
    parentRetrieval: false, useContextualCompression: false, useHyDE: false,
    stepback: false, iterativeMultiHop: false, enableGraphExpansion: false,
    enableCommunityExpansion: false,
  });
  expect(result.results).toEqual([]);
});

it.each([
  ["MIME", { mimeTypes: ["image/png"] }],
  ["run", { runId: "missing" }],
  ["date", { dateRange: { to: "1999-01-01" } }],
  ["page", { pageRange: { from: 99 } }],
] satisfies Array<[string, SearchFilters]>)("keeps tags and %s constraints when whole-corpus fallback has no matching evidence", async (_name, filters) => {
  const result = await search.hybridSearch("unfindablequasar", "u", {
    filters: { workspaceId: "w", tags: ["finance"], ...filters }, queryVector: [1, 0, 0],
    limit: 20, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false,
    parentRetrieval: false, useContextualCompression: false, useHyDE: false,
    stepback: false, iterativeMultiHop: false, enableGraphExpansion: false,
    enableCommunityExpansion: false,
  });
  expect(result.results).toEqual([]);
});

it.each([
  ["document selection", { documentId: "page-selected" }],
  ["MIME", { mimeTypes: ["text/plain"] }],
  ["page", { pageRange: { from: 1, to: 1 } }],
] satisfies Array<[string, SearchFilters]>)("intersects tags and %s in completed page-only fallback", async (_name, filters) => {
  const result = await search.hybridSearch("budget", "u", {
    filters: { workspaceId: "pages", tags: ["finance"], ...filters }, queryVector: [1, 0, 0],
    limit: 20, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false,
    parentRetrieval: false, useContextualCompression: false, useHyDE: false,
    stepback: false, iterativeMultiHop: false, enableGraphExpansion: false,
    enableCommunityExpansion: false,
  });
  expect(result.results.map((hit) => hit.citation.documentId)).toEqual(["page-selected"]);
});

it.each([
  ["page range", { pageRange: { from: 1, to: 1 } }, "EXCLUDED_PAGE"],
  ["language", { language: "en" }, "EXCLUDED_LANGUAGE"],
  ["heading", { headingPath: ["Allowed"] }, "EXCLUDED_HEADING"],
] satisfies Array<[string, SearchFilters, string]>)("keeps parent context inside the requested %s", async (_name, filters, excluded) => {
  const result = await search.hybridSearch("budget", "u", {
    filters: { workspaceId: "w", documentId: "selected", tags: ["finance"], ...filters },
    queryVector: [1, 0, 0], limit: 20, minScore: 0,
    useRerank: false, queryRewrite: false, selfQuery: false,
    parentRetrieval: true, useContextualCompression: false, useHyDE: false,
    stepback: false, iterativeMultiHop: false, enableGraphExpansion: false,
    enableCommunityExpansion: false,
  });
  const selected = result.results.find((hit) => hit.text.includes("Selected evidence"));
  expect(selected).toBeDefined();
  expect(selected?.parentText).toContain("Selected evidence");
  expect(selected?.parentText).not.toContain(excluded);
});

it("does not fabricate an absent pinned document outside the requested document selection", async () => {
  const result = await search.hybridSearch("budget", "u", {
    filters: { workspaceId: "w", documentId: "selected" },
    queryVector: [1, 0, 0], limit: 20, minScore: 0,
    useRerank: false, queryRewrite: false, selfQuery: false,
    parentRetrieval: false, useContextualCompression: false, useHyDE: false,
    stepback: false, iterativeMultiHop: false, enableGraphExpansion: false,
    enableCommunityExpansion: false,
  });
  expect(result.results.length).toBeGreaterThan(0);
  expect(result.results.map((hit) => hit.citation.documentId)).toEqual(["selected"]);
  expect(result.results[0].text).toContain("Selected evidence");
});

it.each([
  ["metadata", { mimeTypes: ["text/plain"] }],
  ["run and page", { runId: "r", pageRange: { from: 1, to: 1 } }],
] satisfies Array<[string, SearchFilters]>)("selects eligible tagged documents before ANN search using %s filters", async (_name, filters) => {
  const embedding = resolveEmbeddingRoute(defaultEmbeddingConfig);
  for (const id of ["selected", "outside"]) {
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values (${id + '-vector'}, ${id}, 'lancedb', 'test', ${id}, ${embedding.model}, 3)
      on conflict do nothing`;
  }
  // The fixture adds vectors without the run_events hint a worker sends; drop cached eligibility (native search).
  (await import("../search/eligible-documents.js")).resetEligibleDocumentCachesForTests();
  lanceDbVectorSearch.mockClear();
  const result = await search.hybridSearch("budget", "u", {
    filters: { workspaceId: "w", tags: ["finance"], ...filters },
    queryVector: [1, 0, 0], limit: 20, minScore: 0,
    useRerank: false, queryRewrite: false, selfQuery: false,
    parentRetrieval: false, useContextualCompression: false, useHyDE: false,
    stepback: false, iterativeMultiHop: false, enableGraphExpansion: false,
    enableCommunityExpansion: false,
  });
  expect(result.results.some((hit) => hit.text.includes("Selected evidence"))).toBe(true);
  expect(lanceDbVectorSearch).toHaveBeenCalledOnce();
  expect(lanceDbVectorSearch).toHaveBeenCalledWith(expect.objectContaining({
    documentIds: ["selected"], legacyDocumentIds: ["selected"], queryVector: [1, 0, 0],
  }));
});
