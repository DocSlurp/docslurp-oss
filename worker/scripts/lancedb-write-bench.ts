/**
 * LanceDB index-write benchmark: many slots of one org writing one table.
 *
 *   DATABASE_URL=postgres://... LANCEDB_URI=s3://bench/lancedb?endpoint=http://127.0.0.1:9000 \
 *   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
 *   pnpm --filter @docslurp/worker exec tsx scripts/lancedb-write-bench.ts \
 *     --mode queued --docs 400 --concurrency 128 --pages 10 --chunks-per-page 2 --dims 1536
 *
 * --mode direct   every document commits its own merge-insert + maintenance (the pre-queue path)
 * --mode queued   documents enqueue to the Postgres outbox; one drainer per table commits batches
 *
 * Reports failures, wall time, documents/s and pages/min (a throughput proxy for the index
 * stage), per-document latency, and bucket bytes per page before and after cleanup with the
 * retention window elapsed. Uses synthetic vectors; no provider calls.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { ListObjectsV2Command, S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { resolveLanceDbConfig, resolveObjectStorageConfig } from "@docslurp/shared";
import postgres from "postgres";

import type { VectorBackendRecord } from "../src/stages/embedding-runtime.js";
import { connectLanceDb } from "../src/stages/lancedb-connection.js";
import { runLanceDbMaintenance } from "../src/stages/lancedb-maintenance.js";
import * as writer from "../src/stages/lancedb-writer.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const mode = arg("mode", "queued");
const docs = Number(arg("docs", "200"));
const concurrency = Number(arg("concurrency", "64"));
const pages = Number(arg("pages", "10"));
const chunksPerPage = Number(arg("chunks-per-page", "2"));
const dims = Number(arg("dims", "1536"));
const textChars = Number(arg("text-chars", "1500"));
const label = arg("label", mode);
const lance = resolveLanceDbConfig();
const prefix = `bench-${label}-${randomUUID().slice(0, 8)}`;
const uri = `${lance.root}/${prefix}`;
const table = "chunks";

function records(documentId: string): VectorBackendRecord[] {
  const out: VectorBackendRecord[] = [];
  const count = pages * chunksPerPage;
  for (let index = 0; index < count; index += 1) {
    const vector = Array.from({ length: dims }, () => Math.random() * 2 - 1);
    out.push({
      id: `${documentId}-${index.toString().padStart(3, "0")}`,
      documentId,
      chunkIndex: index,
      text: `${documentId} page ${Math.floor(index / chunksPerPage) + 1} `.padEnd(textChars, "lorem ipsum dolor sit amet "),
      vector,
      metadata: { documentId, sourceKey: `src/${documentId}.pdf`, filename: `${documentId}.pdf`, pageNumber: Math.floor(index / chunksPerPage) + 1 },
    });
  }
  return out;
}

async function bucketUsage(): Promise<{ bytes: number; objects: number }> {
  if (!/^s3:\/\//.test(uri)) {
    const out = execFileSync("du", ["-sb", uri]).toString();
    const objects = Number(execFileSync("sh", ["-c", `find "${uri}" -type f | wc -l`]).toString().trim());
    return { bytes: Number(out.split(/\s+/)[0]), objects };
  }
  const storage = resolveObjectStorageConfig();
  const url = new URL(uri.replace(/^s3:/, "http:"));
  const client = new S3Client({
    region: lance.storageOptions?.region ?? storage.region,
    endpoint: lance.storageOptions?.endpoint ?? storage.endpoint ?? undefined,
    forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
  });
  let bytes = 0;
  let objects = 0;
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: url.hostname, Prefix: url.pathname.replace(/^\//, ""), ContinuationToken: token,
    }));
    for (const item of page.Contents ?? []) { bytes += item.Size ?? 0; objects += 1; }
    token = page.NextContinuationToken;
  } while (token);
  return { bytes, objects };
}

async function ensureBucket(): Promise<void> {
  if (!/^s3:\/\//.test(uri)) return;
  const storage = resolveObjectStorageConfig();
  const client = new S3Client({
    region: lance.storageOptions?.region ?? storage.region,
    endpoint: lance.storageOptions?.endpoint ?? storage.endpoint ?? undefined,
    forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
  });
  await client.send(new CreateBucketCommand({ Bucket: new URL(uri.replace(/^s3:/, "http:")).hostname })).catch(() => undefined);
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
}

async function main(): Promise<void> {
  await ensureBucket();
  const payloads = new Map<string, VectorBackendRecord[]>();
  const ids = Array.from({ length: docs }, (_, i) => `doc-${i.toString().padStart(5, "0")}`);
  for (const id of ids) payloads.set(id, records(id));

  let indexDocument: (documentId: string) => Promise<void>;
  let sql: postgres.Sql<Record<string, unknown>> | null = null;
  let commits = 0;
  if (mode === "queued") {
    const { LanceDbWriteQueue } = await import("../src/stages/lancedb-write-queue.js");
    sql = postgres(process.env.DATABASE_URL!, { max: Number(arg("pg-pool", "20")), prepare: false, onnotice: () => undefined });
    const maintenance = {
      enabled: true, vectorIndexMinRows: 1_000_000, versionRetentionMs: 600_000,
      optimizeEveryRows: Number(arg("optimize-every-rows", "20000")), optimizeIntervalMs: 300_000,
    };
    // One queue per slot: nothing is shared in memory, as with slots on separate machines.
    indexDocument = async (documentId) => {
      const q = new LanceDbWriteQueue({
        sql: sql!,
        loadRecords: async (row) => payloads.get(row.documentId)!,
        write: async (u, t, r) => { commits += 1; await writer.writeLanceDbRecords(u, t, r); },
        maintenance,
      });
      await q.indexDocument({
        uri, table, orgId: "bench", documentId, runId: "bench", artifactKey: `mem/${documentId}`,
        recordCount: payloads.get(documentId)!.length,
      });
    };
  } else {
    indexDocument = async (documentId) => {
      const rows = payloads.get(documentId)!;
      const windows = writer.planPageWindows(rows, (r) => Number(r.metadata.pageNumber), 20);
      await writer.writeLanceDbDocumentInWindows({
        uri, table, windows,
        maintenance: { enabled: true, vectorIndexMinRows: 1_000_000 },
        deps: { write: async (u, t, r, s) => { commits += 1; await writer.writeLanceDbRecords(u, t, r, s); } },
      });
    };
  }

  const latencies: number[] = [];
  const failures: string[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      const t0 = performance.now();
      try {
        await indexDocument(id);
        latencies.push(performance.now() - t0);
      } catch (error) {
        failures.push(`${id}: ${String(error).split("\n")[0]}`);
      }
    }
  }));
  const wallS = (performance.now() - started) / 1_000;

  const db = await connectLanceDb(uri);
  const t = await db.openTable(table);
  const rows = await t.countRows();
  const versions = (await t.listVersions()).length;
  t.close(); db.close();
  const before = await bucketUsage();
  // Steady state after the retention window: compact and drop every older version.
  // Lance deletes a compacted-away fragment one cleanup pass after the compaction that
  // replaced it, so steady state is the second pass.
  await runLanceDbMaintenance(uri, table, { vectorIndexMinRows: 1_000_000, versionRetentionMs: 0 });
  const cleanup = await runLanceDbMaintenance(uri, table, { vectorIndexMinRows: 1_000_000, versionRetentionMs: 0 });
  const after = await bucketUsage();
  const okDocs = docs - failures.length;
  const totalPages = okDocs * pages;
  const report = {
    label, mode, uri, docs, concurrency, pages, chunksPerPage, dims,
    failures: failures.length, failureSamples: failures.slice(0, 3),
    expectedRows: okDocs * pages * chunksPerPage, rows, versions, lanceCommits: commits,
    wallS: Number(wallS.toFixed(1)),
    docsPerS: Number((okDocs / wallS).toFixed(2)),
    pagesPerMin: Math.round((totalPages / wallS) * 60),
    latencyP50S: Number((quantile(latencies, 0.5) / 1000).toFixed(2)),
    latencyP95S: Number((quantile(latencies, 0.95) / 1000).toFixed(2)),
    bucketBefore: { ...before, mbPerPage: Number((before.bytes / 1e6 / Math.max(1, totalPages)).toFixed(3)) },
    cleanup: { ok: cleanup.ok, versionsRemoved: cleanup.versionsRemoved, bytesRemoved: cleanup.bytesRemoved, fragmentsRemoved: cleanup.fragmentsRemoved },
    bucketAfterCleanup: { ...after, mbPerPage: Number((after.bytes / 1e6 / Math.max(1, totalPages)).toFixed(3)) },
    rawPayloadMbPerPage: Number(((chunksPerPage * (dims * 4 + textChars)) / 1e6).toFixed(3)),
  };
  console.log(JSON.stringify(report, null, 2));
  await sql?.end({ timeout: 5 });
}

await main();
