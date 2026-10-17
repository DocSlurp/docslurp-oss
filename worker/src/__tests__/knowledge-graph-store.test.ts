import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGraphConfig, graphConfigFingerprint } from "@docslurp/shared";

import { generateOpenRouterText } from "../lib/ai.js";
vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: vi.fn() }));

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import { refreshKnowledgeGraphNodes } from "../db/superseded-purge.js";
import { refreshWorkspaceCommunities } from "../graph/communities.js";
import { graphNodeKey, type DocumentGraph } from "../graph/extract.js";
import { countGraphJobDocuments, runGraphJobs } from "../graph/rebuild-job.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import type { ArtifactStore } from "../tools/storage.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  // The PGlite socket serves one connection, so assertions share the store's.
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000);
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`
    insert into workspaces(id, org_id, user_id, name, pipeline)
    values ('w', 'o1', 'u1', 'Supply chain', ${sql.json({ entityIndex: true })})
  `;
}, 60_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  vi.mocked(generateOpenRouterText).mockReset();
  await sql`update workspaces set pipeline = ${sql.json({ entityIndex: true })} where id = 'w'`;
  await sql`delete from graph_jobs`;
  await sql`delete from kg_communities`;
  await sql`delete from kg_nodes`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
});

async function seedDocument(id: string, text: string) {
  const run = `run-${id}`;
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pipeline)
    values (${run}, 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed', 1, '{}'::jsonb)
  `;
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    values (${id}, 'o1', 'u1', 'w', ${run}, ${`${id}.md`}, 'text/markdown', ${`raw/${id}`}, 'completed')
  `;
  await sql`
    insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
    values (${`${id}-c0`}, ${id}, ${run}, 'u1', 0, ${text})
  `;
}

const node = (name: string, type: string, aliases: string[] = []) => ({
  key: graphNodeKey(name.toLowerCase(), type),
  canonicalName: name,
  normalizedName: name.toLowerCase(),
  entityType: type,
  aliases,
  confidence: 0.8,
  mentionCount: 1,
});

/** A document graph where `supplier` supplies each customer. */
function documentGraph(documentId: string, supplier: string, customers: string[], aliases: string[] = []): DocumentGraph {
  const supplierNode = node(supplier, "supplier", aliases);
  const customerNodes = customers.map((customer) => node(customer, "customer"));
  return {
    nodes: [supplierNode, ...customerNodes],
    edges: customerNodes.map((customer) => ({
      sourceKey: supplierNode.key,
      targetKey: customer.key,
      predicate: "supplies",
      normalizedPredicate: "supplies",
      confidence: 0.7,
      weight: 1,
    })),
    chunkEntities: [supplierNode, ...customerNodes].map((entry) => ({
      chunkId: `${documentId}-c0`,
      nodeKey: entry.key,
      mentionCount: 1,
      confidence: 0.8,
      pageNumbers: [1],
    })),
    source: "llm",
    windows: 1,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 5,
  };
}

const write = (documentId: string, graph: DocumentGraph, configHash = "g1-test") =>
  store.replaceDocumentGraph({ workspaceId: "w", userId: "u1", runId: `run-${documentId}`, documentId, configHash, graph });

const nodes = () =>
  sql<{ name: string; mentions: number; documents: number }[]>`
    select normalized_name as name, mention_count as mentions, source_document_count as documents
    from kg_nodes order by normalized_name
  `;

describe("workspace knowledge graph persistence", () => {
  it("merges documents from separate runs into one workspace graph", async () => {
    await seedDocument("d1", "Acme supplies Globex");
    await seedDocument("d2", "Acme supplies Globex");
    await write("d1", documentGraph("d1", "Acme", ["Globex"], ["Acme Corp"]));
    await write("d2", documentGraph("d2", "Acme", ["Globex"], ["ACME"]));

    expect(await nodes()).toEqual([
      { name: "acme", mentions: 2, documents: 2 },
      { name: "globex", mentions: 2, documents: 2 },
    ]);
    const [acme] = await sql<{ aliases: string[] }[]>`select aliases from kg_nodes where normalized_name = 'acme'`;
    expect([...acme!.aliases].sort()).toEqual(["ACME", "Acme Corp"]);
    expect(await sql`select weight from kg_edges`).toEqual([{ weight: 2 }]);
    expect(await sql`select document_id, config_hash, source from kg_document_state order by document_id`).toEqual([
      { document_id: "d1", config_hash: "g1-test", source: "llm" },
      { document_id: "d2", config_hash: "g1-test", source: "llm" },
    ]);
    const [{ types }] = await sql<{ types: string[] }[]>`
      select array_agg(distinct jsonb_typeof(value)) as types from (
        select aliases as value from kg_nodes
        union all select metadata from kg_edges
        union all select metadata from chunk_entities
      ) stored
    `;
    expect(types.sort()).toEqual(["array", "object"]);
  });

  it("re-extracting a document replaces only its contribution, and replays are no-ops", async () => {
    await seedDocument("d1", "Acme supplies Globex");
    await seedDocument("d2", "Acme supplies Globex and Initech");
    await write("d1", documentGraph("d1", "Acme", ["Globex"]));
    await write("d2", documentGraph("d2", "Acme", ["Globex"]));

    // New settings: d2 now yields Initech instead of Globex.
    await write("d2", documentGraph("d2", "Acme", ["Initech"]), "g1-new");
    await write("d2", documentGraph("d2", "Acme", ["Initech"]), "g1-new");

    expect(await nodes()).toEqual([
      { name: "acme", mentions: 2, documents: 2 },
      { name: "globex", mentions: 1, documents: 1 },
      { name: "initech", mentions: 1, documents: 1 },
    ]);
    expect(await sql`
      select t.normalized_name as target, e.weight from kg_edges e join kg_nodes t on t.id in (e.source_node_id, e.target_node_id)
      where t.normalized_name <> 'acme' order by target
    `).toEqual([{ target: "globex", weight: 1 }, { target: "initech", weight: 1 }]);
  });

  it("drops entities and relationships once no current document supports them", async () => {
    await seedDocument("d1", "Acme supplies Globex");
    await seedDocument("d2", "Acme supplies Initech");
    await write("d1", documentGraph("d1", "Acme", ["Globex"]));
    await write("d2", documentGraph("d2", "Acme", ["Initech"]));

    // As the superseded-version purge does: derived rows go, then a refresh.
    const affected = (await sql<{ id: string }[]>`select id from kg_nodes`).map((row) => row.id);
    await sql`delete from document_chunks where document_id = 'd1'`;
    await sql`delete from kg_edge_evidence where document_id = 'd1'`;
    await refreshKnowledgeGraphNodes(sql, affected);

    expect(await nodes()).toEqual([
      { name: "acme", mentions: 1, documents: 1 },
      { name: "initech", mentions: 1, documents: 1 },
    ]);
    expect(await sql`select count(*)::int as edges from kg_edges`).toEqual([{ edges: 1 }]);
  });

  const retention = () =>
    store as unknown as {
      purgeExpiredArtifacts(storage: ArtifactStore, batchSize: number): Promise<void>;
      deleteExpiredRuns(batchSize: number): Promise<void>;
    };

  it("expires and deletes an older run while preserving facts a newer run still supports", async () => {
    await seedDocument("d1", "Acme supplies Globex");
    await seedDocument("d2", "Acme supplies Globex");
    await write("d1", documentGraph("d1", "Acme", ["Globex"]));
    await write("d2", documentGraph("d2", "Acme", ["Globex"]));
    await sql`update workspaces set artifact_retention_days = 1, run_retention_days = 2 where id = 'w'`;
    await sql`update workspace_runs set created_at = now() - interval '3 days' where id = 'run-d1'`;

    await retention().purgeExpiredArtifacts({ bucket: "bucket", deleteKeys: async () => {} } as unknown as ArtifactStore, 10);
    expect(await nodes()).toEqual([
      { name: "acme", mentions: 1, documents: 1 },
      { name: "globex", mentions: 1, documents: 1 },
    ]);
    expect(await sql`select weight from kg_edges`).toEqual([{ weight: 1 }]);

    await retention().deleteExpiredRuns(10);
    expect(await sql`select id from workspace_runs order by id`).toEqual([{ id: "run-d2" }]);
    expect(await nodes()).toEqual([
      { name: "acme", mentions: 1, documents: 1 },
      { name: "globex", mentions: 1, documents: 1 },
    ]);
    expect(await sql`select count(*)::int as count from chunk_entities`).toEqual([{ count: 2 }]);
    expect(await sql`select weight from kg_edges`).toEqual([{ weight: 1 }]);
  });

  it("preserves shared facts when run retention acts without artifact retention", async () => {
    await seedDocument("d1", "Acme supplies Globex");
    await seedDocument("d2", "Acme supplies Globex and Initech");
    await write("d1", documentGraph("d1", "Acme", ["Globex", "Initech"]));
    await write("d2", documentGraph("d2", "Acme", ["Globex"]));
    await sql`update workspaces set artifact_retention_days = null, run_retention_days = 2 where id = 'w'`;
    await sql`update workspace_runs set created_at = now() - interval '3 days' where id = 'run-d1'`;

    await retention().deleteExpiredRuns(10);
    // Initech was only supported by the expired run, so it and its edge go.
    expect(await nodes()).toEqual([
      { name: "acme", mentions: 1, documents: 1 },
      { name: "globex", mentions: 1, documents: 1 },
    ]);
    expect(await sql`select weight from kg_edges`).toEqual([{ weight: 1 }]);
    expect(await sql`select document_id from kg_document_state`).toEqual([{ document_id: "d2" }]);
  });

  it("clusters the whole workspace and reuses unchanged community summaries", async () => {
    await seedDocument("d1", "Acme supplies Globex and Hooli");
    await seedDocument("d2", "Umbrella supplies Initech and Wonka");
    await write("d1", documentGraph("d1", "Acme", ["Globex", "Hooli"]));
    await write("d2", documentGraph("d2", "Umbrella", ["Initech", "Wonka"]));
    const context = { scope: "Supply chain", model: "test-model", privacyMode: "standard" as const };

    const first = await refreshWorkspaceCommunities({ sql, workspaceId: "w", userId: "u1", runId: null, context });
    expect(first).toMatchObject({ communities: 2, summarized: 2, reused: 0 });
    const level0 = await sql<{ members: number }[]>`
      select member_count as members from kg_communities where level = 0 order by label
    `;
    expect(level0).toEqual([{ members: 3 }, { members: 3 }]);

    const second = await refreshWorkspaceCommunities({ sql, workspaceId: "w", userId: "u1", runId: null, context });
    expect(second).toMatchObject({ communities: 2, summarized: 0, reused: 2 });
  });
});

describe("workspace graph rebuild jobs", () => {
  const config = { costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
  const configHash = graphConfigFingerprint(defaultGraphConfig, "test-model");

  async function queueJob(id: string, mode: "stale" | "full") {
    await sql`
      insert into graph_jobs (id, org_id, workspace_id, user_id, mode, config, config_hash, model)
      values (${id}, 'o1', 'w', 'u1', ${mode}, ${sql.json(defaultGraphConfig)}, ${configHash}, 'test-model')
    `;
  }

  it("re-extracts stale documents from stored chunks and reports progress", async () => {
    await seedDocument("d1", "Acme Corporation signed with Globex Industries in March 2024.");
    await seedDocument("d2", "Initech Company audited Umbrella Agency in 2023.");
    await write("d1", documentGraph("d1", "Acme", ["Globex"]), configHash);
    expect(await countGraphJobDocuments(sql, { workspaceId: "w", mode: "stale", configHash })).toBe(1);

    await queueJob("job-1", "stale");
    // PGlite serves one connection, so tests extract one document at a time.
    expect(await runGraphJobs(sql, { workerId: "test", config, concurrency: 1 })).toBe(1);
    const [job] = await sql`
      select status, phase, documents_processed, documents_failed, cursor, lease_owner from graph_jobs where id = 'job-1'
    `;
    expect(job).toEqual({ status: "completed", phase: "done", documents_processed: 1, documents_failed: 0, cursor: "d2", lease_owner: null });
    expect(await countGraphJobDocuments(sql, { workspaceId: "w", mode: "stale", configHash })).toBe(0);
    expect(await sql`select source from kg_document_state where document_id = 'd2'`).toEqual([{ source: "heuristic" }]);

    // A full rebuild revisits everything; nothing is left to claim afterwards.
    await queueJob("job-2", "full");
    await runGraphJobs(sql, { workerId: "test", config, concurrency: 1 });
    expect(await sql`select documents_processed from graph_jobs where id = 'job-2'`).toEqual([{ documents_processed: 2 }]);
    expect(await runGraphJobs(sql, { workerId: "test", config, concurrency: 1 })).toBe(0);
  });

  it("persists billed graph tokens when a generated response cannot be parsed", async () => {
    await seedDocument("d1", "Example System handles documents.");
    await sql`update workspaces set pipeline = ${sql.json({ graphRag: true })} where id = 'w'`;
    vi.mocked(generateOpenRouterText).mockResolvedValue({
      text: '{"entities":[{"name":"Example"}', finishReason: "length",
      usage: { inputTokens: 100, outputTokens: 1600, costCents: 0.25 },
    });
    await queueJob("job-usage", "full");
    await runGraphJobs(sql, { workerId: "test", config: { ...config, openRouterApiKey: "mock-only" }, concurrency: 1 });
    const events = await sql`
      select input_tokens, output_tokens, cost_cents, metadata->>'finishReason' as finish_reason
      from usage_attribution where metric = 'graphrag-extract' and metadata->>'graphJobId' = 'job-usage'
    `;
    expect(events).toHaveLength(1);
    expect(Number(events[0]!.input_tokens)).toBe(100);
    expect(Number(events[0]!.output_tokens)).toBe(1600);
    expect(Number(events[0]!.cost_cents)).toBe(0.25);
    expect(events[0]!.finish_reason).toBe("length");
    expect(await sql`select source from kg_document_state where document_id = 'd1'`).toEqual([{ source: "heuristic" }]);
  });

  it("stops between batches when cancellation is requested", async () => {
    await seedDocument("d1", "Acme Corporation");
    await seedDocument("d2", "Globex Industries");
    await queueJob("job-3", "full");
    await sql`update graph_jobs set cancel_requested_at = now() where id = 'job-3'`;
    await runGraphJobs(sql, { workerId: "test", config, concurrency: 1 });
    expect(await sql`select status, documents_processed from graph_jobs where id = 'job-3'`).toEqual([
      { status: "cancelled", documents_processed: 1 },
    ]);
  });

  it("allows one active rebuild per workspace", async () => {
    await queueJob("job-4", "stale");
    await expect(queueJob("job-5", "full")).rejects.toThrow(/graph_jobs_one_active_per_workspace/);
  });
});
