import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as lance from "@lancedb/lancedb";
import { VectorNamespaceManager } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Real postgres.js queries; PGlite's local wire server accepts one connection at a time.
vi.mock("../db.js", async () => {
  const { default: postgres } = await import("postgres");
  return { sql: postgres(process.env.DATABASE_URL!, { max: 1, prepare: false }) };
});

let pg: Awaited<ReturnType<typeof startMigratedPostgres>>;
let sql: typeof import("../db.js").sql;
let search: typeof import("../services/search.js").hybridSearch;
let reset: typeof import("../search/lancedb.js").resetLanceDbConnectionForTests;
let db: lance.Connection;
let table: lance.Table;
let directory: string;
const vector = Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0);
const options = { queryVector: vector, useRerank: false, useMmr: false, parentRetrieval: false,
  suppressSessionLog: true, minScore: 0, limit: 10, filters: { workspaceId: "refine-ws" } };

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network/model APIs forbidden in local integration test"); }));
  pg = await startMigratedPostgres();
  vi.stubEnv("DATABASE_URL", pg.url);
  vi.stubEnv("LANCEDB_REFINE_FACTOR", "4");
  for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_KEY", "ANTHROPIC_API_KEY"]) vi.stubEnv(key, "");
  directory = await mkdtemp(path.join(tmpdir(), "docslurp-refine-service-"));
  vi.stubEnv("LANCEDB_URI", directory);
  ({ sql } = await import("../db.js"));
  ({ hybridSearch: search } = await import("../services/search.js"));
  ({ resetLanceDbConnectionForTests: reset } = await import("../search/lancedb.js"));
  await sql`insert into "user" (id,name,email) values ('refine-user','Local tester','refine@example.invalid'), ('refine-outsider','Outsider','outsider@example.invalid')`;
  await sql`insert into organizations(id,name,created_by_user_id) values('refine-org','Local test','refine-user')`;
  await sql`insert into org_memberships(org_id,user_id,role) values('refine-org','refine-user','owner')`;
  await sql`insert into workspaces(id,user_id,name,org_id,pipeline) values('refine-ws','refine-user','Local test','refine-org',${sql.json({ privacyMode: "standard", embedding: { profile: "cheapest-hosted", target: "hosted", modelUri: "llm://openai/text-embedding-3-small" } })})`;
  await sql`insert into workspace_runs(id,user_id,workspace_id,kind,status,stage) values('refine-run','refine-user','refine-ws','ingest','completed','completed')`;
  await sql`insert into documents(id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,org_id,page_count) values('refine-doc','refine-user','refine-ws','refine-run','local.txt','text/plain','local','completed','refine-org',2)`;
  await sql`insert into vector_indexes(id,document_id,backend,bucket,path,embedding_model,dimension) values('refine-index','refine-doc','lancedb','local','local','text-embedding-3-small',1536)`;
  await sql`insert into document_chunks(id,document_id,run_id,user_id,chunk_index,text,page_number) values('refine-chunk','refine-doc','refine-run','refine-user',0,'Authoritative hydrated content',1)`;
  const location = VectorNamespaceManager.getEmbeddingLocation(directory, "refine-org", "text-embedding-3-small", 1536);
  db = await lance.connect(location.uri);
  table = await db.createTable(location.table, [
    { id: "refine-chunk", documentId: "refine-doc", chunkIndex: 0, vector },
    { id: "stale-row", documentId: "refine-doc", chunkIndex: 99, vector },
    { id: "outside-row", documentId: "foreign-document", chunkIndex: 0, vector },
  ]);
  await table.createIndex("vector", { config: lance.Index.hnswSq({ distanceType: "l2", numPartitions: 1 }) });
}, 60_000);

afterAll(async () => {
  reset?.(); table?.close(); db?.close();
  await sql?.end({ timeout: 2 }); await pg?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it("hydrates authoritative SQL content/citations and rejects stale or out-of-scope vectors", async () => {
  const { loadWorkspacePipeline } = await import("../search/session-setup.js");
  const { resolveEmbeddingRoute } = await import("@docslurp/shared");
  expect(resolveEmbeddingRoute((await loadWorkspacePipeline("refine-ws")).embedding).model).toBe("text-embedding-3-small");
  const adapter = await import("../search/lancedb.js");
  expect(await adapter.lanceDbVectorSearch({ orgId: "refine-org", embeddingModel: "text-embedding-3-small", queryVector: vector, documentIds: ["refine-doc"], limit: 10 })).not.toHaveLength(0);
  const response = await search("zzmissinglexicalterm", "refine-user", options);
  expect(response.results).toHaveLength(1);
  expect(response.results[0]?.text).toBe("Authoritative hydrated content");
  expect(response.results[0]?.citation).toMatchObject({ documentId: "refine-doc", pageNumber: 1, filename: "local.txt" });
});

it("enforces workspace access and invalid document filters with the real adapter", async () => {
  await expect(search("zzmissinglexicalterm", "refine-outsider", options)).rejects.toThrow("Workspace not found");
  await expect(search("zzmissinglexicalterm", "refine-user", { ...options, filters: { workspaceId: "missing-workspace" } })).rejects.toThrow("Workspace not found");
  const missing = await search("zzmissinglexicalterm", "refine-user", { ...options, filters: { workspaceId: "refine-ws", documentIds: ["foreign-document"] } });
  expect(missing.results).toHaveLength(0);
});

it("hydrates a fresh unindexed tail after the reader is reopened", async () => {
  await sql`insert into document_chunks(id,document_id,run_id,user_id,chunk_index,text,page_number) values('refine-fresh','refine-doc','refine-run','refine-user',1,'Fresh authoritative content',2)`;
  await table.add([{ id: "refine-fresh", documentId: "refine-doc", chunkIndex: 1, vector }]);
  reset(); // This test measures tail inclusion, not the cached 10-second consistency window.
  const response = await search("zzmissinglexicalterm", "refine-user", options);
  expect(response.results.map(r => r.text)).toContain("Fresh authoritative content");
  expect(response.results.find(r => r.text === "Fresh authoritative content")?.citation.pageNumber).toBe(2);
});
