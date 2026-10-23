/**
 * Perf-search corpus seeder (local measurement tooling, not product code).
 * Builds a Postgres + LanceDB corpus from ordinary markdown files (npm package READMEs/docs),
 * embedded with a local transformers.js model, and writes a source-derived query set.
 * Usage: tsx seed.ts <corpusRoot> <outDir> [maxChunks]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import postgres from "postgres";
import { normalizePipelineFeatures, resolveEmbeddingRoute, resolveLanceDbConfig, VectorNamespaceManager } from "@docslurp/shared";
import { encodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";
import { chunkTextFtsIndex } from "../../../worker/src/stages/lancedb-maintenance.js";

const [root, outDir, maxChunksArg] = process.argv.slice(2);
const MAX_CHUNKS = Number(maxChunksArg ?? 20000);
const MODEL = "Xenova/all-MiniLM-L6-v2";
const ORG = "perforg";
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
  if (seen.has(hash) || /[\u0000]/.test(text)) continue;
  seen.add(hash);
  const chunks: Doc["chunks"] = [];
  let heading: string[] = [];
  let buf = "";
  const flush = () => { const t = buf.trim(); if (t.length > 120) chunks.push({ text: t, heading: [...heading], page: 1 + Math.floor(chunks.length / 3) }); buf = ""; };
  for (const para of text.split(/\n{2,}/)) {
    const h = /^(#{1,4})\s+(.+)$/m.exec(para);
    if (h && para.trim().startsWith("#")) { flush(); heading = [h[2]!.slice(0, 80)]; }
    if (buf.length + para.length > 900) flush();
    buf += (buf ? "\n\n" : "") + para;
  }
  flush();
  if (chunks.length < 2) continue;
  const id = `d${docs.length}`;
  docs.push({ id, filename: path.basename(path.dirname(file)) + "-" + path.basename(file), chunks });
  total += chunks.length;
}
console.log(`docs=${docs.length} chunks=${total}`);

const { pipeline } = await import("@huggingface/transformers");
const { homedir } = await import("node:os");
const tf = await import("@huggingface/transformers");
tf.env.cacheDir = path.join(homedir(), ".cache", "docslurp", "transformers");
const extractor: any = await pipeline("feature-extraction", MODEL, { dtype: "q8" } as any);
const flat = docs.flatMap((d) => d.chunks.map((c, i) => ({ doc: d, c, i })));
const vectors: number[][] = [];
const t0 = Date.now();
for (let i = 0; i < flat.length; i += 64) {
  const batch = flat.slice(i, i + 64).map((x) => x.c.text.slice(0, 1500));
  const out = await extractor(batch, { pooling: "mean", normalize: true });
  const dims = out.dims[1];
  for (let j = 0; j < batch.length; j++) vectors.push(Array.from(out.data.slice(j * dims, (j + 1) * dims) as Float32Array));
  if ((i / 64) % 20 === 0) console.log(`embedded ${i}/${flat.length} ${(Date.now() - t0) / 1000}s`);
}

const route = resolveEmbeddingRoute(normalizePipelineFeatures({ embedding: { modelUri: `llm://transformers.js/${MODEL}`, target: "local" } } as never).embedding);
console.log("route", route.provider, route.model, route.dimensions);
const DIM = route.dimensions;

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
await sql`delete from document_chunks where document_id like 'd%'`;
await sql`insert into "user" (id, name, email) values ('perfu', 'Perf', 'perf@example.test') on conflict do nothing`;
await sql`insert into organizations (id, name, slug, created_by_user_id) values (${ORG}, 'Perf', 'perf', 'perfu') on conflict do nothing`;
await sql`insert into org_memberships (org_id, user_id, role) values (${ORG}, 'perfu', 'owner') on conflict do nothing`;
const pipelineJson = { embedding: { modelUri: `llm://transformers.js/${MODEL}`, target: "local" } };
await sql`insert into workspaces (id, org_id, user_id, name, pipeline) values ('perfw', ${ORG}, 'perfu', 'Perf', ${sql.json(pipelineJson as never)}) on conflict (id) do update set pipeline = excluded.pipeline`;
await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('perfrun', ${ORG}, 'perfu', 'perfw', 'bulk-upload', 'completed', 'completed', '{}') on conflict do nothing`;
for (const d of docs) {
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status) values (${d.id}, ${ORG}, 'perfu', 'perfw', 'perfrun', ${d.filename}, 'text/markdown', ${"k" + d.id}, 'completed') on conflict (id) do nothing`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values (${"vi" + d.id}, ${d.id}, 'lancedb', 'b', 'p', ${route.model}, ${DIM}) on conflict do nothing`;
}
const rows: any[] = [];
const pgRows: any[] = [];
flat.forEach((x, n) => {
  const id = `${x.doc.id}-${x.i}`;
  const meta = { pageNumbers: [x.c.page], blockIds: [`b-${id}`], blockTypes: ["paragraph"], evidenceType: "paragraph", locator: { kind: "page", pageNumber: x.c.page, charStart: null, charEnd: null, boxes: [] } };
  rows.push({ id, documentId: x.doc.id, chunkIndex: x.i, text: x.c.text, vector: vectors[n], metadata: { documentId: x.doc.id, sourceKey: "k", filename: x.doc.filename }, runId: "perfrun", pageNumber: x.c.page,
    hydration: encodeLanceChunkHydration({ runId: "perfrun", headingPath: x.c.heading, pageNumber: x.c.page, tokenEstimate: Math.ceil(x.c.text.length / 4), metadata: meta as never }) });
  pgRows.push({ id, document_id: x.doc.id, run_id: "perfrun", user_id: "perfu", chunk_index: x.i, text: x.c.text, heading_path: x.c.heading, page_number: x.c.page, token_estimate: Math.ceil(x.c.text.length / 4), metadata: sql.json(meta as never) });
});
for (let i = 0; i < pgRows.length; i += 1000) await sql`insert into document_chunks ${sql(pgRows.slice(i, i + 1000))}`;
await sql.end();

const cfg = resolveLanceDbConfig();
const location = VectorNamespaceManager.getEmbeddingLocation(cfg.root, ORG, route.model, DIM);
console.log("lance", location.uri);
const db = await lancedb.connect(location.uri, cfg.storageOptions ? { storageOptions: cfg.storageOptions } : undefined);
if ((await db.tableNames()).includes(location.table)) await db.dropTable(location.table);
const table = await db.createTable(location.table, rows.slice(0, 5000));
for (let i = 5000; i < rows.length; i += 5000) await table.add(rows.slice(i, i + 5000));
await table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "l2", numPartitions: 1 }) });
await table.createIndex("id", { config: lancedb.Index.btree() });
await table.createIndex("text", { config: chunkTextFtsIndex() });
await table.optimize();
console.log("rows", await table.countRows(), JSON.stringify(await table.listIndices()));

// Source-derived queries: a held-out sentence/keyphrase from a chunk; label = that chunk (and document). Frozen split by hash.
const STOP = new Set("the a an and or of to in on for with is are be this that it as by from at your you can will use using not if or any".split(" "));
const queries: any[] = [];
let rng = 12345; const rnd = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let n = 0; n < 1200; n++) {
  const x = flat[Math.floor(rnd() * flat.length)]!;
  const sentences = x.c.text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>\[\]()|_]/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 50 && s.length < 220);
  if (!sentences.length) continue;
  const s = sentences[Math.floor(rnd() * sentences.length)]!;
  const kind = n % 3; // 0 sentence, 1 keywords, 2 question-ish paraphrase-lite (first 8 words)
  const words = s.split(/\s+/);
  const q = kind === 0 ? s : kind === 1 ? words.filter((w) => !STOP.has(w.toLowerCase()) && w.length > 3).slice(0, 7).join(" ") : "how " + words.slice(0, 9).join(" ").toLowerCase();
  queries.push({ id: `q${n}`, q, kind, chunkId: `${x.doc.id}-${x.i}`, documentId: x.doc.id });
}
const bySplit = (qq: any) => parseInt(createHash("sha256").update(qq.id).digest("hex").slice(0, 8), 16) % 100 < 70 ? "dev" : "heldout";
const dev = queries.filter((q) => bySplit(q) === "dev"), held = queries.filter((q) => bySplit(q) === "heldout");
writeFileSync(path.join(outDir, "queries-dev.json"), JSON.stringify(dev, null, 1));
writeFileSync(path.join(outDir, "queries-heldout.json"), JSON.stringify(held, null, 1));
const sha = (f: string) => createHash("sha256").update(readFileSync(path.join(outDir, f))).digest("hex");
writeFileSync(path.join(outDir, "query-split.sha256"), `${sha("queries-dev.json")}  queries-dev.json (${dev.length})\n${sha("queries-heldout.json")}  queries-heldout.json (${held.length})\n`);
console.log("queries dev", dev.length, "heldout", held.length);
// Pre-embed queries for harness (query vectors come from the same local model).
const allq = [...dev, ...held];
const qv: Record<string, number[]> = {};
for (let i = 0; i < allq.length; i += 64) {
  const b = allq.slice(i, i + 64);
  const out = await extractor(b.map((x) => x.q), { pooling: "mean", normalize: true });
  const dims = out.dims[1];
  b.forEach((x, j) => { qv[x.id] = Array.from(out.data.slice(j * dims, (j + 1) * dims) as Float32Array); });
}
writeFileSync(path.join(outDir, "query-vectors.json"), JSON.stringify(qv));
console.log("done");
