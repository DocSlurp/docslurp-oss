/**
 * Search-mode cost bench corpus (local measurement tooling, not product code).
 * Markdown files -> Postgres documents/chunks + a native LanceDB table (hydration columns, HNSW_SQ vectors, ICU FTS,
 * id btree, as worker maintenance builds them) on the configured LANCEDB_URI. Vectors come from hash-embed.mjs, the
 * same model the embed stub serves for queries. Writes a source-derived query set split dev/held-out by hash.
 * Usage: tsx seed.ts <corpusRoot> <outDir> <projectId> [maxChunks]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import postgres from "postgres";
import { normalizePipelineFeatures, resolveEmbeddingRoute, resolveLanceDbConfig, VectorNamespaceManager } from "@docslurp/shared";
import { encodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";
import { hashEmbed, DIM } from "./hash-embed.mjs";

const [root, outDir, projectId, maxChunksArg] = process.argv.slice(2) as [string, string, string, string?];
const MAX_CHUNKS = Number(maxChunksArg ?? 8000);
const ORG = "benchorg";
const USER = "benchu";
export const MODEL_URI = `llm://vllm/hash${DIM}?baseUrl=http://127.0.0.1:18700/v1`;
mkdirSync(outDir, { recursive: true });

const files = execFileSync("find", ["-L", root, "-type", "f", "-name", "*.md", "-size", "+3k", "-size", "-400k", "-not", "-iname", "CHANGELOG*", "-not", "-iname", "LICENSE*", "-not", "-iname", "HISTORY*"], { maxBuffer: 1 << 28 }).toString().split("\n").filter(Boolean).sort();
const seen = new Set<string>();
type Doc = { id: string; filename: string; chunks: { text: string; heading: string[]; page: number }[] };
const docs: Doc[] = [];
let total = 0;
for (const file of files) {
  if (total >= MAX_CHUNKS) break;
  const text = readFileSync(file, "utf8");
  const hash = createHash("sha1").update(text).digest("hex");
  if (seen.has(hash) || /\u0000/.test(text)) continue;
  seen.add(hash);
  const chunks: Doc["chunks"] = [];
  let heading: string[] = [];
  let buf = "";
  const flush = () => { const t = buf.trim(); if (t.length > 120) chunks.push({ text: t, heading: [...heading], page: 1 + Math.floor(chunks.length / 3) }); buf = ""; };
  for (const para of text.split(/\n{2,}/)) {
    const h = /^(#{1,4})\s+(.+)$/m.exec(para);
    if (h && para.trim().startsWith("#")) { flush(); heading = [h[2]!.slice(0, 80)]; }
    if (buf.length + para.length > 1200) flush();
    buf += (buf ? "\n\n" : "") + para;
  }
  flush();
  if (chunks.length < 2) continue;
  docs.push({ id: `${projectId}-d${docs.length}`, filename: `${path.basename(path.dirname(file))}-${path.basename(file)}`, chunks });
  total += chunks.length;
}
console.log(`docs=${docs.length} chunks=${total}`);

const pipeline = { embedding: { modelUri: MODEL_URI, target: "local", dimensions: DIM } };
const route = resolveEmbeddingRoute(normalizePipelineFeatures(pipeline as never).embedding);
console.log("route", route.provider, route.model, route.dimensions);
const flat = docs.flatMap((d) => d.chunks.map((c, i) => ({ doc: d, c, i })));

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
await sql`insert into "user" (id, name, email) values (${USER}, 'Bench', 'bench@example.test') on conflict do nothing`;
await sql`insert into organizations (id, name, slug, created_by_user_id) values (${ORG}, 'Bench', 'bench', ${USER}) on conflict do nothing`;
await sql`insert into org_memberships (org_id, user_id, role) values (${ORG}, ${USER}, 'owner') on conflict do nothing`;
await sql`update organizations set credit_balance_cents = 1e9 where id = ${ORG}`;
await sql`insert into projects (id, org_id, user_id, name, pipeline) values (${projectId}, ${ORG}, ${USER}, ${projectId}, ${sql.json(pipeline as never)})
  on conflict (id) do update set pipeline = excluded.pipeline`;
const runId = `${projectId}-run`;
// A completed run that never reached creation_ready_at looks like an abandoned upload and is purged by the API's
// run-creation sweep (documents included), so mark it created and started.
await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, creation_ready_at, workflow_started_at)
  values (${runId}, ${ORG}, ${USER}, ${projectId}, 'bulk-upload', 'completed', 'completed', '{}', now(), now())
  on conflict (id) do update set creation_ready_at = now(), workflow_started_at = now()`;
await sql`delete from document_chunks where document_id like ${projectId + "-d%"}`;
for (const d of docs) {
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status) values (${d.id}, ${ORG}, ${USER}, ${projectId}, ${runId}, ${d.filename}, 'text/markdown', ${"k" + d.id}, 'completed') on conflict (id) do nothing`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values (${"vi" + d.id}, ${d.id}, 'lancedb', 'b', 'p', ${route.model}, ${DIM}) on conflict do nothing`;
}
const rows: Record<string, unknown>[] = [];
const pgRows: Record<string, unknown>[] = [];
for (const x of flat) {
  const id = `${x.doc.id}-${x.i}`;
  const meta = { pageNumbers: [x.c.page], blockIds: [`b-${id}`], blockTypes: ["paragraph"], evidenceType: "paragraph", locator: { kind: "page", pageNumber: x.c.page, charStart: null, charEnd: null, boxes: [] } };
  const tokens = Math.ceil(x.c.text.length / 4);
  rows.push({ id, documentId: x.doc.id, chunkIndex: x.i, text: x.c.text, vector: hashEmbed(x.c.text.slice(0, 1500)), metadata: { documentId: x.doc.id, sourceKey: "k", filename: x.doc.filename }, runId, pageNumber: x.c.page,
    hydration: encodeLanceChunkHydration({ runId, headingPath: x.c.heading, pageNumber: x.c.page, tokenEstimate: tokens, metadata: meta as never }) });
  pgRows.push({ id, document_id: x.doc.id, run_id: runId, user_id: USER, chunk_index: x.i, text: x.c.text, heading_path: x.c.heading, page_number: x.c.page, token_estimate: tokens, metadata: sql.json(meta as never) });
}
for (let i = 0; i < pgRows.length; i += 1000) await sql`insert into document_chunks ${sql(pgRows.slice(i, i + 1000) as never)}`;
await sql.end();

const cfg = resolveLanceDbConfig();
const location = VectorNamespaceManager.getEmbeddingLocation(cfg.root, ORG, projectId, route.model, DIM);
console.log("lance", location.uri, location.table);
const db = await lancedb.connect(location.uri, cfg.storageOptions ? { storageOptions: cfg.storageOptions } : undefined);
if ((await db.tableNames()).includes(location.table)) await db.dropTable(location.table);
const table = await db.createTable(location.table, rows.slice(0, 5000));
for (let i = 5000; i < rows.length; i += 5000) await table.add(rows.slice(i, i + 5000));
await table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "l2", numPartitions: 1 }) });
await table.createIndex("id", { config: lancedb.Index.btree() });
await table.createIndex("text", { name: "text_fts_icu_v1", config: lancedb.Index.fts({ withPosition: false, baseTokenizer: "icu", stem: false, removeStopWords: false, lowercase: true, asciiFolding: true }) });
await table.optimize();
console.log("rows", await table.countRows(), JSON.stringify((await table.listIndices()).map((i) => i.name)));

// Source-derived queries: a sentence, a keyword list, or a question-ish prefix of a chunk; label = that chunk.
const STOP = new Set("the a an and or of to in on for with is are be this that it as by from at your you can will use using not if any".split(" "));
const queries: Record<string, unknown>[] = [];
let rng = 12345; const rnd = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let n = 0; n < 1500; n++) {
  const x = flat[Math.floor(rnd() * flat.length)]!;
  const sentences = x.c.text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>[\]()|_]/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 50 && s.length < 220);
  if (!sentences.length) continue;
  const s = sentences[Math.floor(rnd() * sentences.length)]!;
  const kind = n % 3;
  const words = s.split(/\s+/);
  const q = kind === 0 ? s : kind === 1 ? words.filter((w) => !STOP.has(w.toLowerCase()) && w.length > 3).slice(0, 5).join(" ") : "how " + words.slice(0, 9).join(" ").toLowerCase();
  if (q.trim().length < 4) continue;
  queries.push({ id: `q${n}`, q, kind, chunkId: `${x.doc.id}-${x.i}`, documentId: x.doc.id });
}
const split = (q: Record<string, unknown>) => parseInt(createHash("sha256").update(String(q.id)).digest("hex").slice(0, 8), 16) % 100 < 70 ? "dev" : "heldout";
writeFileSync(path.join(outDir, "queries-dev.json"), JSON.stringify(queries.filter((q) => split(q) === "dev")));
writeFileSync(path.join(outDir, "queries-heldout.json"), JSON.stringify(queries.filter((q) => split(q) === "heldout")));
console.log("queries", queries.length);
process.exit(0);
