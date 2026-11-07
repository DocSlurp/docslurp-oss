import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { graphConfigFingerprint, defaultGraphConfig } from "@docslurp/shared";

import { graphNodeKey, normalizeName, type DocumentGraph } from "../graph/extract.js";
import { replaceDocumentGraph } from "../graph/graph-store.js";
import { currentKeyOf, healLegacyGraphKeys, healLegacyGraphKeysOnce, legacyNormalizeName, resetLegacyGraphKeyHeal } from "../graph/legacy-keys.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1 });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into projects(id, org_id, user_id, name, pipeline) values ('w', 'o1', 'u1', 'Docs', ${sql.json({ entityIndex: true })})`;
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  resetLegacyGraphKeyHeal();
  await sql`delete from kg_communities`;
  await sql`delete from kg_nodes`;
  await sql`delete from documents`;
  await sql`delete from project_runs`;
});

async function seedDocument(id: string) {
  const run = `run-${id}`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, total_documents, pipeline) values (${run}, 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed', 1, '{}'::jsonb)`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status) values (${id}, 'o1', 'u1', 'w', ${run}, ${`${id}.md`}, 'text/markdown', ${`raw/${id}`}, 'completed')`;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text) values (${`${id}-c0`}, ${id}, ${run}, 'u1', 0, 'text')`;
}

/** A node as the g3 extractor stored it: ASCII-only key, the full name kept as the canonical name. */
async function legacyNode(id: string, name: string, type: string, documentId: string, aliases: string[] = []) {
  await sql`
    insert into kg_nodes (id, project_id, run_id, user_id, canonical_name, normalized_name, entity_type, aliases, mention_count, source_document_count)
    values (${id}, 'w', ${`run-${documentId}`}, 'u1', ${name}, ${legacyNormalizeName(name)}, ${type}, ${sql.json(aliases)}, 1, 1)
  `;
  await sql`
    insert into chunk_entities (chunk_id, project_id, run_id, user_id, node_id, entity_name, entity_type, mention_count, confidence, metadata)
    values (${`${documentId}-c0`}, 'w', ${`run-${documentId}`}, 'u1', ${id}, ${name}, ${type}, 1, 0.8, '{}'::jsonb)
  `;
}

async function legacyEdge(id: string, source: string, target: string, documentId: string) {
  await sql`
    insert into kg_edges (id, project_id, run_id, user_id, source_node_id, target_node_id, predicate, normalized_predicate, weight)
    values (${id}, 'w', ${`run-${documentId}`}, 'u1', ${source}, ${target}, 'employs', 'employs', 1)
  `;
  await sql`insert into kg_edge_evidence (edge_id, document_id, project_id, weight, confidence) values (${id}, ${documentId}, 'w', 1, 0.7)`;
}

async function state(documentId: string, configHash: string) {
  await sql`insert into kg_document_state (document_id, project_id, config_hash, source, windows) values (${documentId}, 'w', ${configHash}, 'llm', 1)`;
}

const keys = async () => (await sql<{ key: string; type: string }[]>`select normalized_name as key, entity_type as type from kg_nodes order by normalized_name`).map((row) => `${row.key}|${row.type}`);

describe("legacy graph keys", () => {
  it("recognises the old ASCII-only key and what it becomes", () => {
    expect(legacyNormalizeName("Müller")).toBe("mller");
    expect(legacyNormalizeName("東京")).toBe("");
    expect(currentKeyOf({ canonical_name: "Müller", normalized_name: "mller", aliases: [] })).toBe("müller");
    expect(currentKeyOf({ canonical_name: "Acme C++ Ltd", normalized_name: "acme c ltd", aliases: [] })).toBe("acme c++ ltd");
    expect(currentKeyOf({ canonical_name: "東京", normalized_name: "", aliases: [] })).toBe("");
    // Already current, or not derivable from the node's own names: left alone.
    expect(currentKeyOf({ canonical_name: "Zulu", normalized_name: "zulu", aliases: [] })).toBeNull();
    expect(currentKeyOf({ canonical_name: "Müller", normalized_name: "müller", aliases: [] })).toBeNull();
    expect(currentKeyOf({ canonical_name: "International Business Machines", normalized_name: "ibm", aliases: ["IBM"] })).toBeNull();
    expect(normalizeName("Müller")).toBe("müller");
  });

  it("re-keys a node in place, keeping its mentions and edges", async () => {
    await seedDocument("d1");
    await legacyNode("n-mueller", "Müller", "person", "d1");
    await legacyNode("n-acme", "Acme", "org", "d1");
    await legacyEdge("e1", "n-acme", "n-mueller", "d1");
    await state("d1", "g3-deadbeef");

    expect(await healLegacyGraphKeys(sql, "w")).toEqual({ renamed: 1, merged: 0, removed: 0 });
    expect(await keys()).toEqual(["acme|org", "müller|person"]);
    expect(await sql`select source_node_id, target_node_id from kg_edges`).toEqual([{ source_node_id: "n-acme", target_node_id: "n-mueller" }]);
    expect(await sql`select count(*)::int as n from chunk_entities`).toEqual([{ n: 2 }]);
    // Idempotent.
    expect(await healLegacyGraphKeys(sql, "w")).toEqual({ renamed: 0, merged: 0, removed: 0 });
  });

  it("removes the empty-key super-nodes that merged every non-ASCII name, and the edges on them", async () => {
    await seedDocument("d1");
    await legacyNode("n-empty", "東京", "location", "d1", ["大阪"]);
    await legacyNode("n-acme", "Acme", "org", "d1");
    await legacyEdge("e1", "n-acme", "n-empty", "d1");
    await state("d1", "g3-deadbeef");

    expect(await healLegacyGraphKeys(sql, "w")).toMatchObject({ removed: 1 });
    expect(await keys()).toEqual(["acme|org"]);
    expect(await sql`select count(*)::int as n from kg_edges`).toEqual([{ n: 0 }]);
    expect(await sql`select count(*)::int as n from chunk_entities where node_id = 'n-empty'`).toEqual([{ n: 0 }]);
  });

  it("merges an old node into the node a newer document already created under the new key", async () => {
    await seedDocument("d1");
    await seedDocument("d2");
    await legacyNode("n-old", "Müller", "person", "d1");
    await legacyNode("n-acme", "Acme", "org", "d1");
    await legacyEdge("e-old", "n-acme", "n-old", "d1");
    await state("d1", "g3-deadbeef");
    // d2 was extracted after the key change.
    await sql`insert into kg_nodes (id, project_id, run_id, user_id, canonical_name, normalized_name, entity_type, mention_count, source_document_count) values ('n-new', 'w', 'run-d2', 'u1', 'Müller', 'müller', 'person', 1, 1)`;
    await sql`insert into chunk_entities (chunk_id, project_id, run_id, user_id, node_id, entity_name, entity_type, mention_count, confidence, metadata) values ('d2-c0', 'w', 'run-d2', 'u1', 'n-new', 'Müller', 'person', 1, 0.8, '{}'::jsonb)`;
    await sql`insert into kg_edges (id, project_id, run_id, user_id, source_node_id, target_node_id, predicate, normalized_predicate, weight) values ('e-new', 'w', 'run-d2', 'u1', 'n-acme', 'n-new', 'employs', 'employs', 1)`;
    await sql`insert into kg_edge_evidence (edge_id, document_id, project_id, weight, confidence) values ('e-new', 'd2', 'w', 1, 0.7)`;
    await state("d2", "g4-cafe0001");

    expect(await healLegacyGraphKeys(sql, "w")).toMatchObject({ merged: 1 });
    expect(await keys()).toEqual(["acme|org", "müller|person"]);
    // One node, one edge carrying both documents' evidence, both documents' mentions.
    expect(await sql`select id from kg_nodes where normalized_name = 'müller'`).toEqual([{ id: "n-new" }]);
    expect(await sql`select id from kg_edges`).toEqual([{ id: "e-new" }]);
    expect(await sql`select document_id from kg_edge_evidence where edge_id = 'e-new' order by document_id`).toEqual([{ document_id: "d1" }, { document_id: "d2" }]);
    expect(await sql`select chunk_id from chunk_entities where node_id = 'n-new' order by chunk_id`).toEqual([{ chunk_id: "d1-c0" }, { chunk_id: "d2-c0" }]);
    expect(await sql`select mention_count, source_document_count, weight from kg_nodes n, kg_edges e where n.id = 'n-new'`).toEqual([{ mention_count: 2, source_document_count: 2, weight: 2 }]);
  });

  it("leaves a current (g4) project untouched and runs once per project, before the first graph write", async () => {
    await seedDocument("d1");
    await legacyNode("n-ibm", "International Business Machines", "org", "d1", ["IBM"]);
    await sql`update kg_nodes set normalized_name = 'ibm' where id = 'n-ibm'`;
    await state("d1", graphConfigFingerprint(defaultGraphConfig, "model"));
    expect(await healLegacyGraphKeysOnce(sql, "w")).toBeNull();
    expect(await keys()).toEqual(["ibm|org"]);

    // A pre-g4 document (a worker restarted since): the first write into the project heals it.
    resetLegacyGraphKeyHeal();
    await sql`update kg_document_state set config_hash = 'g3-deadbeef'`;
    await sql`insert into kg_nodes (id, project_id, run_id, user_id, canonical_name, normalized_name, entity_type, mention_count, source_document_count) values ('n-m', 'w', 'run-d1', 'u1', 'Müller', 'mller', 'person', 1, 1)`;
    await seedDocument("d2");
    const key = normalizeName("Müller");
    const graph: DocumentGraph = {
      nodes: [{ key: graphNodeKey(key, "person"), canonicalName: "Müller", normalizedName: key, entityType: "person", aliases: [], confidence: 0.8, mentionCount: 1 }],
      edges: [],
      chunkEntities: [{ chunkId: "d2-c0", nodeKey: graphNodeKey(key, "person"), mentionCount: 1, confidence: 0.8, pageNumbers: [1] }],
      source: "llm", llmFailed: false, windows: 1, charsRead: 10, charsAttempted: 10, charsTotal: 10, truncated: false, inputTokens: 1, outputTokens: 1, durationMs: 1,
    };
    await replaceDocumentGraph(sql, { projectId: "w", userId: "u1", runId: "run-d2", documentId: "d2", configHash: graphConfigFingerprint(defaultGraphConfig, "model"), graph });
    // One Müller, not "mller" and "müller".
    expect((await keys()).filter((entry) => entry.endsWith("|person"))).toEqual(["müller|person"]);
  });
});
