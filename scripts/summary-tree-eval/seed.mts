/**
 * Load the chunk artifacts into a migrated, empty, throwaway local database and
 * a local LanceDB directory, the way worker/scripts/search-native-bench-seed.ts
 * does, so the product search runs in process over the eval corpus.
 *
 *   DATABASE_URL=postgres://…/docslurp_<throwaway> LANCEDB_URI=/path/lancedb \
 *     tsx scripts/summary-tree-eval/seed.mts MANIFEST
 *
 * Never run against a deployed database: the script refuses a non-local host.
 */
import postgres from "postgres";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./lib.mts";
import { treePath, type StoredTree } from "./tree.mts";
import { writeSummaryRows } from "../../worker/src/stages/lancedb-summaries.js";

import { defaultPipelineFeatures, resolveLanceDbConfig, summaryRowSchema, VectorNamespaceManager } from "../../packages/shared/dist/index.js";
import { buildVectorRecords } from "../../worker/src/stages/index-vectors.js";
import { runLanceDbMaintenance } from "../../worker/src/stages/lancedb-maintenance.js";
import { writeLanceDbRecords } from "../../worker/src/stages/lancedb-writer.js";
import { EMBEDDING_ROUTE, loadDocument, loadManifest, need, ORG, PROJECT, RUN, USER } from "./lib.mts";

const [manifestPath] = process.argv.slice(2);
const url = new URL(need("DATABASE_URL"));
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/docslurp_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Refusing: DATABASE_URL must be a local throwaway docslurp_* database");
if (/^[a-z0-9+]+:\/\//i.test(need("LANCEDB_URI"))) throw new Error("Refusing: LANCEDB_URI must be a local directory");
const sql = postgres(url.href, { max: 4, prepare: false, onnotice: () => {} });
const pipeline = { ...defaultPipelineFeatures, summaryTree: { enabled: true } };

await sql.unsafe("set session_replication_role = replica");
await sql`insert into "user" (id, name, email) values (${USER}, 'Summary tree eval', 'summary-tree-eval@example.test') on conflict do nothing`;
await sql`insert into organizations (id, name, slug, created_by_user_id) values (${ORG}, 'Summary tree eval', 'summary-tree-eval', ${USER}) on conflict do nothing`;
await sql`insert into org_memberships (org_id, user_id, role) values (${ORG}, ${USER}, 'owner') on conflict do nothing`;
await sql`insert into projects (id, org_id, user_id, name, pipeline) values (${PROJECT}, ${ORG}, ${USER}, 'Summary tree eval', ${sql.json(pipeline as never)}) on conflict do nothing`;
await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values (${RUN}, ${ORG}, ${USER}, ${PROJECT}, 'bulk-upload', 'completed', 'completed', ${sql.json(pipeline as never)}) on conflict do nothing`;

const { root } = resolveLanceDbConfig();
const location = VectorNamespaceManager.getEmbeddingLocation(root, ORG, PROJECT, EMBEDDING_ROUTE.model, EMBEDDING_ROUTE.dimensions);
let total = 0;
const frozenValidation: Array<Record<string, unknown>> = [];
for (const source of loadManifest(manifestPath!).sources.filter((entry) => entry.role === "corpus")) {
  const document = loadDocument(source.id);
  await sql`insert into documents ${sql({ id: document.id, org_id: ORG, user_id: USER, project_id: PROJECT, run_id: RUN, filename: document.filename, mime_type: "text/markdown",
    source_key: document.id, status: "completed", page_count: document.pages, chunk_count: document.chunks.length, stored_page_count: document.pages } as never)} on conflict do nothing`;
  await sql`insert into vector_indexes ${sql({ id: `vi-${document.id}`, document_id: document.id, backend: "lancedb", bucket: "local", path: location.table, embedding_model: EMBEDDING_ROUTE.model, dimension: EMBEDDING_ROUTE.dimensions } as never)} on conflict do nothing`;
  const rows = document.chunks.map((chunk) => ({ id: chunk.id, document_id: document.id, run_id: RUN, user_id: USER, chunk_index: chunk.index, text: chunk.text,
    heading_path: chunk.headingPath, page_number: chunk.pageNumber, token_estimate: chunk.tokenEstimate, metadata: chunk.metadata }));
  for (let at = 0; at < rows.length; at += 500) await sql`insert into document_chunks ${sql(rows.slice(at, at + 500) as never)} on conflict do nothing`;
  await writeLanceDbRecords(location.uri, location.table, buildVectorRecords({ chunks: document.chunks as never }, document.id, { sourceKey: document.id, filename: document.filename }, RUN));
  const frozenPath = treePath(document.id);
  if (existsSync(frozenPath)) {
    const tree = readJson<StoredTree>(frozenPath);
    const owner = "eval:frozen";
    await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension, build_owner)
      values (${document.id}, ${ORG}, ${PROJECT}, ${RUN}, 'building', ${EMBEDDING_ROUTE.model}, ${EMBEDDING_ROUTE.dimensions}, ${owner})
      on conflict (document_id) do update set status = 'building', build_owner = excluded.build_owner`;
    const rows = tree.nodes.map((node) => ({ id: `${document.id}:${node.id}`, documentId: document.id, runId: RUN,
      level: node.level, chunkStart: node.chunkStart, chunkEnd: node.chunkEnd, pageStart: node.pageStart ?? 0, pageEnd: node.pageEnd ?? 0,
      headingPath: node.headingPath.join(" > "), text: node.text, vector: node.vector }));
    const invalid = rows.flatMap(row => {
      const parsed = summaryRowSchema.safeParse(row);
      return parsed.success ? [] : [{ id: row.id, issues: parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path })) }];
    });
    frozenValidation.push({ documentId: document.id, nodes: rows.length, maxLevel: Math.max(...rows.map(row => row.level)), invalid });
    if (invalid.length) {
      // Historical trees that violate today's contract are not servable; never silently trim their nodes.
      await sql`update document_summary_trees set status = 'partial', build_owner = null, error = 'frozen-tree-contract'
        where document_id = ${document.id} and org_id = ${ORG} and project_id = ${PROJECT}`;
    } else {
      await writeSummaryRows({ sql, scope: { orgId: ORG, projectId: PROJECT }, space: { model: EMBEDDING_ROUTE.model, dimensions: EMBEDDING_ROUTE.dimensions },
        documentId: document.id, runId: RUN, owner, root, rows });
      const registry = tree.nodes.map((node, ordinal) => ({
        id: `${document.id}:${node.id}`, document_id: document.id, org_id: ORG, project_id: PROJECT, run_id: RUN,
        node_hash: node.id, level: node.level, ordinal, status: "ready",
        parent_id: (() => { const parent = tree.nodes.filter(other => other.level > node.level && other.chunkStart <= node.chunkStart && other.chunkEnd >= node.chunkEnd)
          .sort((a, b) => a.level - b.level || (a.chunkEnd - a.chunkStart) - (b.chunkEnd - b.chunkStart))[0]; return parent ? `${document.id}:${parent.id}` : null; })(),
        chunk_start: node.chunkStart, chunk_end: node.chunkEnd, page_start: node.pageStart, page_end: node.pageEnd,
      }));
      for (let at = 0; at < registry.length; at += 200) await sql`insert into document_summary_tree_nodes ${sql(registry.slice(at, at + 200) as never)} on conflict do nothing`;
      await sql`update document_summary_trees set status = 'ready', build_owner = null, built_at = now(),
        leaf_count = ${tree.leafChunkIndexes.length}, node_count = ${tree.nodes.length},
        level_count = ${Math.max(...tree.nodes.map(node => node.level))}, root_node_id = ${`${document.id}:${tree.rootId}`}
        where document_id = ${document.id} and org_id = ${ORG} and project_id = ${PROJECT}`;
    }
  }
  total += document.chunks.length;
  console.log("seeded", document.id, document.chunks.length);
}
await sql.unsafe("set session_replication_role = origin");
await sql.unsafe("vacuum analyze documents");
await sql.unsafe("vacuum analyze document_chunks");
process.env.LANCEDB_FTS_INDEX = "1";
const maintenance = await runLanceDbMaintenance(location.uri, location.table, { vectorIndexMinRows: 1000 });
console.log(JSON.stringify({ chunks: total, lance: { uri: location.uri, table: location.table }, maintenance: { ok: maintenance.ok, rows: maintenance.rows } }));
if (process.env.SUMMARY_TREE_EVAL_OUT) writeFileSync(join(process.env.SUMMARY_TREE_EVAL_OUT, "frozen-validation.json"), JSON.stringify(frozenValidation, null, 2));
await sql.end();
process.exit(0);
