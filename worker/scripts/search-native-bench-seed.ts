/**
 * Synthetic corpus for the SEARCH_LANCEDB_NATIVE benchmark (server/src/__tests__/search-native.bench.test.ts).
 *
 *   DATABASE_URL=postgres://… LANCEDB_URI=/path/lancedb pnpm --filter @docslurp/worker exec tsx \
 *     scripts/search-native-bench-seed.ts --docs 2000 --chunks 140 --other-chunks 100000 --queries 200 --out qrels.json
 *
 * Writes into a migrated, empty database (never production):
 * - one large workspace (default 2,000 documents x 140 chunks = 280K chunks, about the
 *   size of the 58K-page eval workspace) with document_chunks, vector_indexes and a LanceDB
 *   table written through the worker's own record builder (hydration columns included), then
 *   runLanceDbMaintenance with LANCEDB_FTS_INDEX=1 (vector index, id btree, FTS index);
 * - other tenants' chunks (Postgres only) that share the GIN index, as in production;
 * - known-item queries: each plants rare and mid-frequency terms in one target chunk.
 *   "keyword" queries contain only planted terms (Postgres websearch AND matches);
 *   "conversational" queries add stop words and one term the target lacks, so the
 *   Postgres branch falls back to its OR backoff, which matches most of the corpus.
 * Text is Zipf-distributed pseudo-words; vectors are clustered per document; each query's
 * vector is either near its target ("informative") or random. Deterministic (seeded).
 */
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { normalizePipelineFeatures, resolveEmbeddingRoute, VectorNamespaceManager, resolveLanceDbConfig } from "@docslurp/shared";
import postgres from "postgres";

import { buildVectorRecords } from "../src/stages/index-vectors.js";
import { runLanceDbMaintenance } from "../src/stages/lancedb-maintenance.js";
import { writeLanceDbRecords } from "../src/stages/lancedb-writer.js";
import type { EmbeddingArtifact } from "../src/stages/embedding-runtime.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}
const DOCS = Number(arg("docs", "2000"));
const CHUNKS = Number(arg("chunks", "140"));
const OTHER_CHUNKS = Number(arg("other-chunks", "100000"));
const QUERIES = Number(arg("queries", "200"));
const WORDS_PER_CHUNK = Number(arg("words", "180"));
const OUT = arg("out", "qrels.json");
export const PIPELINE = { embedding: { modelUri: "llm://transformers.js/Xenova/all-MiniLM-L6-v2", target: "local" } };
const route = resolveEmbeddingRoute(normalizePipelineFeatures(PIPELINE as never).embedding);
const DIM = route.dimensions;

let state = 0x2545f491;
function rand(): number {
  state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
  return state / 4294967296;
}
const VOCAB = 20_000;
const letters = "abcdefghijklmnopqrstuvwxyz";
const vocab = Array.from({ length: VOCAB }, (_, i) => {
  let n = i + 7_919; let word = "";
  while (word.length < 4 || n > 0) { word += letters[n % 26]; n = Math.floor(n / 26); if (word.length > 9) break; }
  return `${word}${letters[(i * 7) % 26]}x`;
});
// Zipf(1.05) sampler by inverse CDF over ranks.
const weights = vocab.map((_, i) => 1 / Math.pow(i + 1, 1.05));
const total = weights.reduce((a, b) => a + b, 0);
const cdf: number[] = []; let acc = 0;
for (const w of weights) { acc += w / total; cdf.push(acc); }
function zipfWord(): string {
  const r = rand(); let lo = 0, hi = cdf.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid]! < r) lo = mid + 1; else hi = mid; }
  return vocab[lo]!;
}
const fillers = ["the", "of", "and", "to", "in", "is", "for", "with", "on", "that", "by", "this", "be", "are"];
function chunkText(): string {
  return Array.from({ length: WORDS_PER_CHUNK }, () => (rand() < 0.3 ? fillers[Math.floor(rand() * fillers.length)] : zipfWord())).join(" ");
}
function unit(v: number[]): number[] { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); }
function noise(scale: number): number[] { return Array.from({ length: DIM }, () => (rand() - 0.5) * scale); }

const sql = postgres(process.env.DATABASE_URL!, { max: 4, prepare: false, onnotice: () => {} });
const started = performance.now();
const log = (message: string) => console.log(`[seed +${Math.round((performance.now() - started) / 1000)}s] ${message}`);

await sql.unsafe("set session_replication_role = replica");
await sql`insert into "user" (id, name, email) values ('bench-user', 'Bench', 'bench@example.test') on conflict do nothing`;
await sql`insert into organizations (id, name, slug, created_by_user_id) values ('benchorg', 'Bench', 'bench', 'bench-user') on conflict do nothing`;
await sql`insert into org_memberships (org_id, user_id, role) values ('benchorg', 'bench-user', 'owner') on conflict do nothing`;
await sql`insert into workspaces (id, org_id, user_id, name, pipeline) values ('bench-ws', 'benchorg', 'bench-user', 'Bench', ${sql.json(PIPELINE)}) on conflict do nothing`;
await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('bench-run', 'benchorg', 'bench-user', 'bench-ws', 'bulk-upload', 'completed', 'completed', '{}') on conflict do nothing`;

type Target = { id: string; documentId: string; chunkIndex: number };
const targets = new Map<string, { kind: "keyword" | "conversational"; planted: string[] }>();
const queries: Array<{ q: string; kind: string; informative: boolean; target: Target; vector: number[] }> = [];
const plannedTargets: Target[] = [];
for (let i = 0; i < QUERIES; i += 1) {
  const d = 1 + Math.floor(rand() * DOCS);
  plannedTargets.push({ id: `bdoc${d}-${Math.floor(rand() * CHUNKS)}`, documentId: `bdoc${d}`, chunkIndex: 0 });
}
plannedTargets.forEach((target, i) => {
  target.chunkIndex = Number(target.id.split("-").pop());
  const kind = i % 2 === 0 ? "keyword" : "conversational";
  // Mid-frequency terms (ranks 150-1500) match many chunks; rare ones (3000-15000) few.
  const mid = vocab[150 + Math.floor(rand() * 1350)]!;
  const rare = vocab[3000 + Math.floor(rand() * 12000)]!;
  const mid2 = vocab[150 + Math.floor(rand() * 1350)]!;
  targets.set(target.id, { kind, planted: kind === "keyword" ? [mid, mid2] : [rare, mid, mid2] });
});

const vectorsByChunk = new Map<string, number[]>();
log(`workspace bench-ws: ${DOCS} documents x ${CHUNKS} chunks, ${DIM}-d (${route.model})`);
const { root } = resolveLanceDbConfig();
const location = VectorNamespaceManager.getEmbeddingLocation(root, "benchorg", route.model, DIM);
const BATCH_DOCS = 20;
let pendingLance: ReturnType<typeof buildVectorRecords> = [];
for (let start = 1; start <= DOCS; start += BATCH_DOCS) {
  const docRows: Record<string, unknown>[] = [];
  const chunkRows: Record<string, unknown>[] = [];
  const indexRows: Record<string, unknown>[] = [];
  const lanceRecords = [];
  for (let d = start; d < Math.min(DOCS + 1, start + BATCH_DOCS); d += 1) {
    const documentId = `bdoc${d}`;
    docRows.push({ id: documentId, org_id: "benchorg", user_id: "bench-user", workspace_id: "bench-ws", run_id: "bench-run",
      filename: `manual-${d}.pdf`, mime_type: "application/pdf", source_key: `k${d}`, status: "completed", page_count: Math.ceil(CHUNKS / 5),
      chunk_count: CHUNKS, stored_page_count: Math.ceil(CHUNKS / 5) });
    indexRows.push({ id: `bvi${d}`, document_id: documentId, backend: "lancedb", bucket: "b", path: "p", embedding_model: route.model, dimension: DIM });
    const centroid = noise(2);
    const artifactChunks: EmbeddingArtifact["chunks"] = [];
    for (let c = 0; c < CHUNKS; c += 1) {
      const id = `${documentId}-${c}`;
      let text = chunkText();
      const planted = targets.get(id);
      if (planted) text = `${text} ${planted.planted.join(" ")} ${planted.planted.join(" ")} ${planted.planted.join(" ")}`;
      const jitter = noise(1.2);
      const vector = unit(centroid.map((x, k) => x + jitter[k]!));
      if (planted) vectorsByChunk.set(id, vector);
      const page = 1 + Math.floor(c / 5);
      const metadata = { pageNumbers: [page], blockIds: [`blk-${id}`], blockTypes: ["paragraph"], evidenceType: "paragraph",
        sourceTrace: { canonicalDocumentUri: null, parserArtifactUri: null, sourceArtifactUri: null, blockIds: [`blk-${id}`], pageNumbers: [page], extractor: "bench" },
        locator: { kind: "page", pageNumber: page, charStart: null, charEnd: null, boxes: [] } };
      chunkRows.push({ id, document_id: documentId, run_id: "bench-run", user_id: "bench-user", chunk_index: c, text,
        heading_path: [`Manual ${d}`, `Section ${Math.floor(c / 10)}`], page_number: page, token_estimate: Math.round(text.length / 4), metadata });
      artifactChunks.push({ id, index: c, text, tokenEstimate: Math.round(text.length / 4), vector, headingPath: [`Manual ${d}`, `Section ${Math.floor(c / 10)}`], pageNumber: page, metadata });
    }
    lanceRecords.push(...buildVectorRecords({ chunks: artifactChunks }, documentId, { sourceKey: `k${d}`, filename: `manual-${d}.pdf` }, "bench-run"));
  }
  await sql`insert into documents ${sql(docRows as never)} on conflict do nothing`;
  await sql`insert into vector_indexes ${sql(indexRows as never)} on conflict do nothing`;
  for (let i = 0; i < chunkRows.length; i += 1000) await sql`insert into document_chunks ${sql(chunkRows.slice(i, i + 1000) as never)} on conflict do nothing`;
  pendingLance.push(...lanceRecords);
  if (pendingLance.length >= 25_000 || start + BATCH_DOCS > DOCS) {
    await writeLanceDbRecords(location.uri, location.table, pendingLance);
    pendingLance = [];
  }
  if ((start - 1) % 200 === 0) log(`documents ${Math.min(DOCS, start + BATCH_DOCS - 1)}/${DOCS}`);
}

log(`other tenants: ${OTHER_CHUNKS} chunks (Postgres only)`);
for (let t = 0; t < 10; t += 1) {
  await sql`insert into workspaces (id, org_id, user_id, name) values (${`other-ws-${t}`}, 'benchorg', 'bench-user', 'Other') on conflict do nothing`;
}
const perDoc = 100;
for (let i = 0; i < OTHER_CHUNKS; i += 2000) {
  const docs: Record<string, unknown>[] = [];
  const rows: Record<string, unknown>[] = [];
  for (let j = i; j < Math.min(OTHER_CHUNKS, i + 2000); j += 1) {
    const documentId = `odoc${Math.floor(j / perDoc)}`;
    if (j % perDoc === 0) docs.push({ id: documentId, org_id: "benchorg", user_id: "bench-user", workspace_id: `other-ws-${Math.floor(j / perDoc) % 10}`,
      run_id: "bench-run", filename: `${documentId}.pdf`, mime_type: "application/pdf", source_key: documentId, status: "completed", chunk_count: perDoc });
    rows.push({ id: `${documentId}-${j % perDoc}`, document_id: documentId, run_id: "bench-run", user_id: "bench-user", chunk_index: j % perDoc,
      text: chunkText(), heading_path: [], page_number: 1, token_estimate: 300, metadata: {} });
  }
  if (docs.length) await sql`insert into documents ${sql(docs as never)} on conflict do nothing`;
  for (let k = 0; k < rows.length; k += 1000) await sql`insert into document_chunks ${sql(rows.slice(k, k + 1000) as never)} on conflict do nothing`;
}
await sql.unsafe("set session_replication_role = origin");
await sql.unsafe("vacuum analyze documents");
await sql.unsafe("vacuum analyze document_chunks");

log("LanceDB maintenance (vector index, id btree, FTS index)");
process.env.LANCEDB_FTS_INDEX = "1";
const maintenance = await runLanceDbMaintenance(location.uri, location.table, { vectorIndexMinRows: 1000 });
log(`maintenance ok=${maintenance.ok} rows=${maintenance.rows}`);

const interrogatives = ["what does the manual say about", "explain", "how do I handle", "where is the section on"];
for (const target of plannedTargets) {
  const plan = targets.get(target.id)!;
  const informative = queries.length % 4 < 2;
  const base = vectorsByChunk.get(target.id)!;
  const vector = informative ? unit(base.map((x) => x + (rand() - 0.5) * 0.04)) : unit(noise(1));
  const q = plan.kind === "keyword"
    ? plan.planted.join(" ")
    : `${interrogatives[queries.length % interrogatives.length]} ${plan.planted.join(" ")} ${vocab[16000 + Math.floor(rand() * 3999)]}`;
  queries.push({ q, kind: plan.kind, informative, target, vector });
}
const sizes = await sql<{ name: string; mb: number }[]>`
  select relname as name, round(pg_total_relation_size(oid) / 1048576.0)::int as mb from pg_class
  where relname in ('document_chunks', 'documents', 'document_chunks_ts_content_idx', 'document_chunks_ts_content_idx1') order by 2 desc`;
writeFileSync(OUT, JSON.stringify({ workspaceId: "bench-ws", userId: "bench-user", pipeline: PIPELINE, dimension: DIM, sizes, queries }));
log(`wrote ${queries.length} queries to ${OUT}; sizes ${JSON.stringify(sizes)}`);
await sql.end();
