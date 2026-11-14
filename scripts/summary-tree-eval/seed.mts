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

import { defaultPipelineFeatures, resolveLanceDbConfig, VectorNamespaceManager } from "../../packages/shared/dist/index.js";
import { buildVectorRecords } from "../../worker/src/stages/index-vectors.js";
import { runLanceDbMaintenance } from "../../worker/src/stages/lancedb-maintenance.js";
import { writeLanceDbRecords } from "../../worker/src/stages/lancedb-writer.js";
import { EMBEDDING_ROUTE, loadDocument, loadManifest, need, ORG, PROJECT, RUN, USER } from "./lib.mts";

const [manifestPath] = process.argv.slice(2);
const url = new URL(need("DATABASE_URL"));
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/docslurp_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Refusing: DATABASE_URL must be a local throwaway docslurp_* database");
if (/^[a-z0-9+]+:\/\//i.test(need("LANCEDB_URI"))) throw new Error("Refusing: LANCEDB_URI must be a local directory");
const sql = postgres(url.href, { max: 4, prepare: false, onnotice: () => {} });
const pipeline = { ...defaultPipelineFeatures };

await sql.unsafe("set session_replication_role = replica");
await sql`insert into "user" (id, name, email) values (${USER}, 'Summary tree eval', 'summary-tree-eval@example.test') on conflict do nothing`;
await sql`insert into organizations (id, name, slug, created_by_user_id) values (${ORG}, 'Summary tree eval', 'summary-tree-eval', ${USER}) on conflict do nothing`;
await sql`insert into org_memberships (org_id, user_id, role) values (${ORG}, ${USER}, 'owner') on conflict do nothing`;
await sql`insert into projects (id, org_id, user_id, name, pipeline) values (${PROJECT}, ${ORG}, ${USER}, 'Summary tree eval', ${sql.json(pipeline as never)}) on conflict do nothing`;
await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values (${RUN}, ${ORG}, ${USER}, ${PROJECT}, 'bulk-upload', 'completed', 'completed', ${sql.json(pipeline as never)}) on conflict do nothing`;

const { root } = resolveLanceDbConfig();
const location = VectorNamespaceManager.getEmbeddingLocation(root, ORG, PROJECT, EMBEDDING_ROUTE.model, EMBEDDING_ROUTE.dimensions);
let total = 0;
for (const source of loadManifest(manifestPath!).sources.filter((entry) => entry.role === "corpus")) {
  const document = loadDocument(source.id);
  await sql`insert into documents ${sql({ id: document.id, org_id: ORG, user_id: USER, project_id: PROJECT, run_id: RUN, filename: document.filename, mime_type: "text/markdown",
    source_key: document.id, status: "completed", page_count: document.pages, chunk_count: document.chunks.length, stored_page_count: document.pages } as never)} on conflict do nothing`;
  await sql`insert into vector_indexes ${sql({ id: `vi-${document.id}`, document_id: document.id, backend: "lancedb", bucket: "local", path: location.table, embedding_model: EMBEDDING_ROUTE.model, dimension: EMBEDDING_ROUTE.dimensions } as never)} on conflict do nothing`;
  const rows = document.chunks.map((chunk) => ({ id: chunk.id, document_id: document.id, run_id: RUN, user_id: USER, chunk_index: chunk.index, text: chunk.text,
    heading_path: chunk.headingPath, page_number: chunk.pageNumber, token_estimate: chunk.tokenEstimate, metadata: chunk.metadata }));
  for (let at = 0; at < rows.length; at += 500) await sql`insert into document_chunks ${sql(rows.slice(at, at + 500) as never)} on conflict do nothing`;
  await writeLanceDbRecords(location.uri, location.table, buildVectorRecords({ chunks: document.chunks as never }, document.id, { sourceKey: document.id, filename: document.filename }, RUN));
  total += document.chunks.length;
  console.log("seeded", document.id, document.chunks.length);
}
await sql.unsafe("set session_replication_role = origin");
await sql.unsafe("vacuum analyze documents");
await sql.unsafe("vacuum analyze document_chunks");
process.env.LANCEDB_FTS_INDEX = "1";
const maintenance = await runLanceDbMaintenance(location.uri, location.table, { vectorIndexMinRows: 1000 });
console.log(JSON.stringify({ chunks: total, lance: { uri: location.uri, table: location.table }, maintenance: { ok: maintenance.ok, rows: maintenance.rows } }));
await sql.end();
process.exit(0);
