/**
 * LanceDB maintenance-cadence benchmark: how often should optimize() run while pages stream in?
 *
 *   nice -n 10 pnpm --filter @docslurp/worker exec tsx scripts/lancedb-cadence-bench.ts \
 *     --dir ../.scratch/lancedb-cadence --sizes 10000,100000 --dims 1536 \
 *     --commits 200 --pages-per-commit 5 --chunks-per-page 2 \
 *     --policies 10,40,200,1000,never --out ../.scratch/lancedb-cadence/results.json
 *
 * For each base table size it builds one table the way production does (merge-insert batches,
 * then runLanceDbMaintenance: optimize + HNSW_SQ on "vector" + btree on "id"), copies it per
 * policy, and replays the same stream of small commits (default 5 pages x 2 chunks = 10 rows,
 * 1536-d) through the production writer. A policy is "run maintenance once rows written since
 * the last run reach N" (`never` = only the tail, as today's queued default does between its
 * 20k-row / 300 s triggers). Maintenance runs inline here so its cost is measured in isolation.
 *
 * Reports per policy: commit latency p50/p95, maintenance runs / wall p50/p95 / total / CPU,
 * fragments and unindexed rows at checkpoints, query latency p50/p95 (default query: index +
 * flat scan of the unindexed tail) and recall@10 against an exhaustive scan, bytes on disk
 * (retention 10 min, as in production, so nothing is pruned during the stream) and bytes after
 * a final cleanup, plus time-to-visible for a just-committed row. Synthetic clustered vectors;
 * no provider calls. Local disk only (pass a file path as --dir).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { connect, type Table } from "@lancedb/lancedb";

import type { VectorBackendRecord } from "../src/stages/embedding-runtime.js";
import { runLanceDbMaintenance } from "../src/stages/lancedb-maintenance.js";
import { writeLanceDbRecords } from "../src/stages/lancedb-writer.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const root = path.resolve(arg("dir", "../.scratch/lancedb-cadence"));
const sizes = arg("sizes", "10000,100000").split(",").map(Number);
const dims = Number(arg("dims", "1536"));
const commits = Number(arg("commits", "200"));
const pagesPerCommit = Number(arg("pages-per-commit", "5"));
const chunksPerPage = Number(arg("chunks-per-page", "2"));
const policies = arg("policies", "10,40,200,1000,never").split(",");
const queries = Number(arg("queries", "30"));
const checkpoints = Number(arg("checkpoints", "4"));
const textChars = Number(arg("text-chars", "1500"));
const clusters = Number(arg("clusters", "512"));
const outPath = arg("out", path.join(root, "results.json"));
const keepBase = process.argv.includes("--keep-base");
const RETENTION_MS = 10 * 60_000;
const TABLE = "chunks";

// ---------------------------------------------------------------- synthetic clustered vectors
let seed = 0x9e3779b9;
function rand(): number {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x1_0000_0000;
}
function gauss(): number {
  return (rand() + rand() + rand() + rand() - 2) * 1.732;
}
function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i += 1) v[i]! /= n;
  return v;
}
const centroids = Array.from({ length: clusters }, () => normalize(Float32Array.from({ length: dims }, gauss)));
function sampleVector(): number[] {
  const c = centroids[Math.floor(rand() * clusters)]!;
  const v = new Float32Array(dims);
  // Noise comparable to the centroid norm: realistic overlap between topics.
  for (let i = 0; i < dims; i += 1) v[i] = c[i]! + gauss() * 0.035;
  return Array.from(normalize(v));
}
const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(Math.ceil(textChars / 50)).slice(0, textChars);
function makeRows(prefix: string, start: number, count: number): VectorBackendRecord[] {
  return Array.from({ length: count }, (_, k) => {
    const i = start + k;
    const documentId = `${prefix}-doc-${Math.floor(i / 40)}`;
    return {
      id: `${prefix}-${i}`,
      documentId,
      chunkIndex: i % 40,
      text: filler,
      vector: sampleVector(),
      metadata: { documentId, sourceKey: `src/${documentId}.pdf`, filename: `${documentId}.pdf` },
    };
  });
}

// ---------------------------------------------------------------- measurement helpers
const pct = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! * 10) / 10;
};
const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0));
const du = (dir: string) => Number(execFileSync("du", ["-sb", dir]).toString().split(/\s+/)[0]);
const versionFiles = (dir: string) => {
  const versions = path.join(dir, `${TABLE}.lance`, "_versions");
  return existsSync(versions) ? readdirSync(versions).length : 0;
};
const cpuMs = () => {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
};

async function openFresh(uri: string): Promise<{ table: Table; close: () => void }> {
  const db = await connect(uri, { readConsistencyInterval: 0 });
  const table = await db.openTable(TABLE);
  return { table, close: () => { table.close(); db.close(); } };
}

type Checkpoint = {
  commit: number;
  rows: number;
  fragments: number;
  unindexedRows: number | null;
  indexSegments: number | null;
  bytes: number;
  versions: number;
  queryP50Ms: number | null;
  queryP95Ms: number | null;
  recallAt10: number;
};

async function checkpoint(uri: string, dir: string, commit: number, probes: number[][], truth: string[][] | null): Promise<{ point: Checkpoint; truth: string[][] }> {
  const { table, close } = await openFresh(uri);
  try {
    const stats = await table.stats();
    const indices = await table.listIndices();
    const vectorIndex = indices.find((index) => index.columns.includes("vector"));
    const indexStats = vectorIndex ? await table.indexStats(vectorIndex.name) : undefined;
    // Exhaustive scan (ground truth) on this exact version.
    const exact = truth ?? await Promise.all(probes.map(async (q) =>
      ((await table.vectorSearch(q).column("vector").bypassVectorIndex().select(["id", "_distance"]).limit(10).toArray()) as { id: string }[]).map((r) => r.id)));
    // Warm once, then time the app's query shape (index + flat tail, no fastSearch).
    await table.vectorSearch(probes[0]!).column("vector").select(["id", "documentId", "chunkIndex", "_distance"]).limit(10).toArray();
    const latencies: number[] = [];
    let hits = 0;
    for (const [i, q] of probes.entries()) {
      const started = performance.now();
      const rows = (await table.vectorSearch(q).column("vector").select(["id", "documentId", "chunkIndex", "_distance"]).limit(10).toArray()) as { id: string }[];
      latencies.push(performance.now() - started);
      const want = new Set(exact[i]);
      hits += rows.filter((r) => want.has(r.id)).length;
    }
    return {
      truth: exact,
      point: {
        commit,
        rows: stats.numRows,
        fragments: stats.fragmentStats.numFragments,
        unindexedRows: indexStats?.numUnindexedRows ?? null,
        indexSegments: vectorIndex?.numSegments ?? null,
        bytes: du(dir),
        versions: versionFiles(dir),
        queryP50Ms: pct(latencies, 50),
        queryP95Ms: pct(latencies, 95),
        recallAt10: Math.round((hits / (probes.length * 10)) * 1000) / 1000,
      },
    };
  } finally {
    close();
  }
}

// ---------------------------------------------------------------- base table
async function buildBase(size: number): Promise<{ dir: string; buildMs: number; bytes: number }> {
  const dir = path.join(root, `base-${size}`);
  if (existsSync(path.join(dir, `${TABLE}.lance`))) return { dir, buildMs: 0, bytes: du(dir) };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const started = performance.now();
  const batch = 10_000;
  for (let start = 0; start < size; start += batch) {
    await writeLanceDbRecords(dir, TABLE, makeRows("base", start, Math.min(batch, size - start)));
    if (start > 0 && start % 100_000 === 0) {
      // Production compacts as it grows; keep fragment counts realistic.
      await runLanceDbMaintenance(dir, TABLE, { vectorIndexMinRows: Number.MAX_SAFE_INTEGER, versionRetentionMs: 0 });
    }
  }
  const result = await runLanceDbMaintenance(dir, TABLE, { vectorIndexMinRows: 5_000, versionRetentionMs: 0 });
  if (!result.ok) throw new Error(`base maintenance failed: ${result.error}`);
  // Second pass prunes the pre-index versions so every policy starts from the same compact base.
  await runLanceDbMaintenance(dir, TABLE, { vectorIndexMinRows: 5_000, versionRetentionMs: 0 });
  const buildMs = Math.round(performance.now() - started);
  console.log(`[bench] base size=${size} build_ms=${buildMs} bytes=${du(dir)}`);
  return { dir, buildMs, bytes: du(dir) };
}

// ---------------------------------------------------------------- one policy run
async function runPolicy(size: number, baseDir: string, policy: string, stream: VectorBackendRecord[][], probes: number[][]) {
  const dir = path.join(root, `run-${size}-${policy}`);
  rmSync(dir, { recursive: true, force: true });
  execFileSync("cp", ["-a", baseDir, dir]);
  // "<rows>" or "<rows>s<maxSegments>" (consolidate past that many index segments); "never".
  const [rowsPart, segmentsPart] = policy.split("s");
  const threshold = policy === "never" ? Infinity : Number(rowsPart);
  const maxIndexSegments = segmentsPart ? Number(segmentsPart) : undefined;
  let consolidations = 0;
  const writeMs: number[] = [];
  const maintMs: number[] = [];
  const maintCpuMs: number[] = [];
  const visibleMs: number[] = [];
  const points: Checkpoint[] = [];
  let since = 0;
  let peakBytes = 0;
  let fragmentsRewritten = 0;
  const every = Math.max(1, Math.floor(stream.length / checkpoints));
  for (const [c, rows] of stream.entries()) {
    const started = performance.now();
    await writeLanceDbRecords(dir, TABLE, rows);
    writeMs.push(performance.now() - started);
    since += rows.length;
    if (c % every === every - 1) {
      // Time-to-visible: a fresh reader sees the newest row as its own nearest neighbour.
      const { table, close } = await openFresh(dir);
      const last = rows[rows.length - 1]!;
      const found = (await table.vectorSearch(last.vector).column("vector").select(["id", "_distance"]).limit(1).toArray()) as { id: string }[];
      visibleMs.push(performance.now() - started);
      close();
      if (found[0]?.id !== last.id) console.warn(`[bench] newest row not top-1 at commit ${c} (${found[0]?.id})`);
    }
    if (since >= threshold) {
      const cpu = cpuMs();
      const t = performance.now();
      const result = await runLanceDbMaintenance(dir, TABLE, { vectorIndexMinRows: 5_000, versionRetentionMs: RETENTION_MS, maxIndexSegments });
      if (result.consolidated) consolidations += 1;
      maintMs.push(performance.now() - t);
      maintCpuMs.push(cpuMs() - cpu);
      fragmentsRewritten += result.fragmentsRemoved ?? 0;
      if (!result.ok) console.warn(`[bench] maintenance failed: ${result.error}`);
      since = 0;
    }
    if (c % every === every - 1 || c === stream.length - 1) {
      const point = (await checkpoint(dir, dir, c + 1, probes, null)).point;
      peakBytes = Math.max(peakBytes, point.bytes);
      points.push(point);
      console.log(`[bench] size=${size} policy=${policy} ${JSON.stringify(point)}`);
    }
  }
  // Steady state once the retention window has passed: prune everything but the latest version.
  const { table, close } = await openFresh(dir);
  await table.optimize({ cleanupOlderThan: new Date() });
  close();
  const bytesAfterCleanup = du(dir);
  rmSync(dir, { recursive: true, force: true });
  const final = points[points.length - 1]!;
  const queryP50s = points.map((p) => p.queryP50Ms ?? 0);
  return {
    size,
    policy,
    rowsWritten: stream.reduce((n, rows) => n + rows.length, 0),
    commitP50Ms: pct(writeMs, 50),
    commitP95Ms: pct(writeMs, 95),
    commitTotalMs: sum(writeMs),
    maintenanceRuns: maintMs.length,
    maintenanceP50Ms: pct(maintMs, 50),
    maintenanceP95Ms: pct(maintMs, 95),
    maintenanceMaxMs: maintMs.length ? Math.round(Math.max(...maintMs)) : null,
    maintenanceTotalMs: sum(maintMs),
    maintenanceCpuMs: sum(maintCpuMs),
    fragmentsRewritten,
    consolidations,
    visibleP50Ms: pct(visibleMs, 50),
    queryP50MsWorstCheckpoint: Math.max(...queryP50s),
    queryP95MsFinal: final.queryP95Ms,
    recallAt10Min: Math.min(...points.map((p) => p.recallAt10)),
    finalUnindexedRows: final.unindexedRows,
    finalFragments: final.fragments,
    finalIndexSegments: final.indexSegments,
    peakBytes,
    bytesAfterCleanup,
    checkpoints: points,
  };
}

async function main(): Promise<void> {
  mkdirSync(root, { recursive: true });
  const results: unknown[] = [];
  for (const size of sizes) {
    const base = await buildBase(size);
    const baseline = await checkpoint(base.dir, base.dir, 0, Array.from({ length: queries }, sampleVector), null);
    console.log(`[bench] base size=${size} ${JSON.stringify(baseline.point)}`);
    // One stream and one probe set per size so every policy sees identical inputs.
    const stream = Array.from({ length: commits }, (_, c) => makeRows(`s${size}`, c * pagesPerCommit * chunksPerPage, pagesPerCommit * chunksPerPage));
    const probes = Array.from({ length: queries }, sampleVector);
    for (const policy of policies) {
      const result = await runPolicy(size, base.dir, policy, stream, probes);
      const { checkpoints: _points, ...summary } = result;
      console.log(`[bench] summary ${JSON.stringify(summary)}`);
      results.push({ ...result, baseBuildMs: base.buildMs, baseBytes: base.bytes, baseline: baseline.point });
      writeFileSync(outPath, JSON.stringify({ dims, commits, pagesPerCommit, chunksPerPage, queries, results }, null, 2));
    }
    if (!keepBase) rmSync(base.dir, { recursive: true, force: true });
  }
  console.log(`[bench] wrote ${outPath}`);
}

await main();
