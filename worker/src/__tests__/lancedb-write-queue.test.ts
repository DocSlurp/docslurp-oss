import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { connect } from "@lancedb/lancedb";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { VectorBackendRecord } from "../stages/embedding-runtime.js";
import {
  LanceDbWriteQueue,
  VectorIndexWriteFailed,
  lanceTableKey,
  markLanceDbHistoryPruneDue,
  type LanceDbWriteQueueDeps,
  type VectorOutboxRow,
} from "../stages/lancedb-write-queue.js";
import { writeLanceDbRecords } from "../stages/lancedb-writer.js";
import { KeyedTaskPool } from "../stages/lancedb-maintenance-pool.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The LanceDB group-commit queue against a database built from server/db/migrations and a
 * local-filesystem Lance table: many writers, one table, no failures, exact rows.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;
let dir: string;

const DIMS = 8;
const TABLE = "chunks";

function vectorFor(documentId: string, index: number): number[] {
  let seed = 0;
  for (const char of `${documentId}:${index}`) seed = (seed * 31 + char.charCodeAt(0)) % 9973;
  return Array.from({ length: DIMS }, (_, i) => ((seed * (i + 7)) % 101) / 101);
}

/** Stand-in for the embedding artifact in object storage. */
const artifacts = new Map<string, VectorBackendRecord[]>();

function makeDocument(documentId: string, chunks: number, text = "v1"): string {
  const key = `artifacts/${documentId}.json`;
  artifacts.set(key, Array.from({ length: chunks }, (_, index) => ({
    id: `${documentId}-${index.toString().padStart(3, "0")}`,
    documentId,
    chunkIndex: index,
    text: `${text} ${documentId} chunk ${index}`,
    vector: vectorFor(documentId, index),
    metadata: { documentId, filename: `${documentId}.pdf` },
  })));
  return key;
}

function queue(overrides: Partial<LanceDbWriteQueueDeps> = {}): LanceDbWriteQueue {
  return new LanceDbWriteQueue({
    sql,
    loadRecords: async (row: VectorOutboxRow) => {
      const records = artifacts.get(row.artifactKey);
      if (!records) throw new Error(`missing artifact ${row.artifactKey}`);
      return records;
    },
    maintenance: { enabled: false, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 1_000_000, optimizeIntervalMs: 3_600_000 },
    settings: { pollMinMs: 5, pollMaxMs: 40, leaseTtlMs: 5_000 },
    ...overrides,
  });
}

function job(documentId: string, artifactKey: string, recordCount: number) {
  return { uri: dir, table: TABLE, orgId: "org-1", documentId, runId: "run-1", artifactKey, recordCount };
}

async function tableRows(): Promise<Array<Record<string, unknown>>> {
  const lance = await connect(dir);
  try {
    const table = await lance.openTable(TABLE);
    try {
      return await table.query().select(["id", "documentId", "text"]).toArray();
    } finally { table.close(); }
  } finally { lance.close(); }
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  sql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, prepare: false, onnotice: () => undefined });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
  await server.stop();
  await db.close();
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "docslurp-lance-queue-"));
  artifacts.clear();
  await sql`delete from vector_index_outbox`;
  await sql`delete from vector_index_tables`;
  return async () => { await rm(dir, { recursive: true, force: true }); };
});

describe("LanceDbWriteQueue", () => {
  it("commits 96 concurrent writers to one table with zero failures, exact rows and few commits", async () => {
    const write = vi.fn((uri: string, table: string, records: VectorBackendRecord[]) => writeLanceDbRecords(uri, table, records));
    const documents = Array.from({ length: 96 }, (_, i) => `doc-${i.toString().padStart(3, "0")}`);
    // One queue per writer simulates one process per slot: nothing is coordinated in memory.
    const results = await Promise.allSettled(documents.map((documentId, i) =>
      queue({ write }).indexDocument(job(documentId, makeDocument(documentId, 1 + (i % 7)), 1 + (i % 7)))));

    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const expectedRows = documents.reduce((sum, _, i) => sum + 1 + (i % 7), 0);
    const rows = await tableRows();
    expect(rows).toHaveLength(expectedRows);
    expect(new Set(rows.map((row) => row.id)).size).toBe(expectedRows);
    // Group commit: far fewer Lance commits than documents.
    expect(write.mock.calls.length).toBeLessThan(documents.length / 2);
    const drained = results.map((result) => (result.status === "fulfilled" ? result.value.batchedDocuments : 0));
    expect(drained.reduce((a, b) => a + b, 0)).toBe(documents.length);
    const [{ pending }] = await sql<{ pending: number }[]>`select count(*)::int as pending from vector_index_outbox where status <> 'written'`;
    expect(pending).toBe(0);
  }, 120_000);

  it("replays idempotently: re-indexing the same documents upserts by chunk id", async () => {
    const documents = Array.from({ length: 12 }, (_, i) => `doc-${i}`);
    await Promise.all(documents.map((id) => queue().indexDocument(job(id, makeDocument(id, 4, "v1"), 4))));
    // Replay (Temporal retry, duplicate delivery) with new text, plus a straight duplicate.
    await Promise.all([
      ...documents.map((id) => queue().indexDocument(job(id, makeDocument(id, 4, "v2"), 4))),
      queue().indexDocument(job("doc-0", `artifacts/doc-0.json`, 4)),
    ]);
    const rows = await tableRows();
    expect(rows).toHaveLength(48);
    expect(rows.every((row) => String(row.text).startsWith("v2 "))).toBe(true);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from vector_index_outbox`;
    expect(count).toBe(12);
  }, 60_000);

  it("makes a document searchable as soon as indexDocument resolves", async () => {
    await queue().indexDocument(job("seed", makeDocument("seed", 3), 3));
    const key = makeDocument("fresh", 2);
    await queue().indexDocument(job("fresh", key, 2));
    const lance = await connect(dir);
    try {
      const table = await lance.openTable(TABLE);
      try {
        const [hit] = await table.vectorSearch(vectorFor("fresh", 1)).limit(1).toArray();
        expect(hit?.id).toBe("fresh-001");
      } finally { table.close(); }
    } finally { lance.close(); }
  }, 60_000);

  it("isolates a poison document: its writer fails, the rest of the batch commits", async () => {
    const write = vi.fn(async (uri: string, table: string, records: VectorBackendRecord[]) => {
      if (records.some((record) => record.documentId === "bad")) throw new Error("schema mismatch");
      await writeLanceDbRecords(uri, table, records);
    });
    const q = () => queue({ write, settings: { pollMinMs: 5, pollMaxMs: 40, leaseTtlMs: 5_000, maxAttempts: 2 } });
    const results = await Promise.allSettled([
      q().indexDocument(job("good-1", makeDocument("good-1", 2), 2)),
      q().indexDocument(job("bad", makeDocument("bad", 2), 2)),
      q().indexDocument(job("good-2", makeDocument("good-2", 2), 2)),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(VectorIndexWriteFailed);
    expect((await tableRows()).map((row) => row.documentId).sort()).toEqual(["good-1", "good-1", "good-2", "good-2"]);
  }, 60_000);

  it("takes over a table whose drainer died (expired lease)", async () => {
    const key = lanceTableKey(dir, TABLE);
    await sql`insert into vector_index_tables (table_key, write_holder, write_expires_at)
      values (${key}, 'dead-worker', now() + interval '300 milliseconds')`;
    const outcome = await queue().indexDocument(job("after-crash", makeDocument("after-crash", 2), 2));
    expect(outcome.drains).toBe(1);
    expect(await tableRows()).toHaveLength(2);
  }, 30_000);

  it("elects one maintenance run per table and resets its counters", async () => {
    const maintain = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, rows: 10, optimizedMs: 1, indexCreated: false };
    });
    const maintenance = { enabled: true, mode: "inline" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 5, optimizeIntervalMs: 3_600_000 };
    const inline = await queue({ maintain, maintenance }).indexDocument(job("m-1", makeDocument("m-1", 10), 10));
    expect(maintain).toHaveBeenCalledTimes(1);
    expect(inline).toMatchObject({ maintenanceScheduled: false, maintenance: { ok: true } });
    const key = lanceTableKey(dir, TABLE);
    await sql`update vector_index_tables set rows_since_optimize = 50 where table_key = ${key}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => queue({ maintain, maintenance }).maybeMaintain(key, dir, TABLE)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(maintain).toHaveBeenCalledTimes(2);
    const [row] = await sql<{ rows_since_optimize: string }[]>`select rows_since_optimize from vector_index_tables where table_key = ${key}`;
    expect(Number(row!.rows_since_optimize)).toBe(0);
  }, 30_000);

  it("inline mode keeps the old trigger: a new table waits for min(optimizeEveryRows, 1,000) rows", async () => {
    const maintain = vi.fn(async () => ({ ok: true, rows: 10, optimizedMs: 1, indexCreated: false }));
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    const inline = { enabled: true, mode: "inline" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 20_000, optimizeIntervalMs: 300_000 };
    const first = await queue({ maintain, maintenance: inline, pool }).indexDocument(job("lg-1", makeDocument("lg-1", 10), 10));
    expect(first).toMatchObject({ maintenance: null, maintenanceScheduled: false });
    expect(maintain).not.toHaveBeenCalled();
    expect(pool.stats()).toMatchObject({ running: 0, queued: 0 });
    // The same table is due at once under the background cadence (never optimized).
    expect(await queue({ maintain, maintenance: { ...inline, mode: "background" as const }, pool }).sweepDueMaintenance()).toBe(1);
    await pool.idle();
    expect(maintain).toHaveBeenCalledTimes(1);
    expect(maintain).toHaveBeenCalledWith(dir, TABLE, expect.objectContaining({ maxIndexSegments: undefined }));
  }, 30_000);

  it("sweeps a registered table after its outbox rows are gone, from the table's own location", async () => {
    const maintain = vi.fn(async () => ({ ok: true, rows: 10, optimizedMs: 1, indexCreated: false }));
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    const background = { enabled: true, mode: "background" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 20_000, optimizeIntervalMs: 300_000 };
    await queue({ maintain, maintenance: { ...background, enabled: false }, pool }).indexDocument(job("sw-1", makeDocument("sw-1", 10), 10));
    const key = `${dir}#${TABLE}`;
    expect(await sql`select lance_uri, lance_table from vector_index_tables where table_key = ${key}`).toEqual([{ lance_uri: dir, lance_table: TABLE }]);
    await sql`delete from vector_index_outbox where table_key = ${key}`;
    expect(await queue({ maintain, maintenance: background, pool }).sweepDueMaintenance()).toBe(1);
    await pool.idle();
    expect(maintain).toHaveBeenCalledWith(dir, TABLE, expect.anything());
  }, 30_000);

  it("sweeps a table with no new rows once a delete's history prune is due, and re-arms once after a compacting pass", async () => {
    const results = [
      { ok: true, rows: 10, optimizedMs: 1, indexCreated: false, fragmentsRemoved: 1 },
      { ok: true, rows: 10, optimizedMs: 1, indexCreated: false, fragmentsRemoved: 0 },
    ];
    const maintain = vi.fn(async () => results.shift()!);
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    const background = {
      enabled: true, mode: "background" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 20_000,
      optimizeIntervalMs: 300_000, versionRetentionMs: 600_000,
    };
    await queue({ maintain, maintenance: { ...background, enabled: false }, pool }).indexDocument(job("hp-1", makeDocument("hp-1", 10), 10));
    const key = lanceTableKey(dir, TABLE);
    const q = queue({ maintain, maintenance: background, pool });
    const dueIn = async () => (await sql<{ seconds: number | null }[]>`
      select extract(epoch from history_prune_due_at - now())::int as seconds from vector_index_tables where table_key = ${key}`)[0]!.seconds;

    // A quiet, freshly optimized table: nothing is due.
    await sql`update vector_index_tables set rows_since_optimize = 0, commits_since_optimize = 0, last_optimized_at = now() where table_key = ${key}`;
    expect(await q.sweepDueMaintenance()).toBe(0);

    // A delete marks it; it is not due until the retention window has passed.
    await markLanceDbHistoryPruneDue(sql, dir, TABLE, background.versionRetentionMs);
    expect(await dueIn()).toBeGreaterThanOrEqual(600);
    expect(await q.sweepDueMaintenance()).toBe(0);

    // Due: the pass compacted, so the fragment it replaced needs one more pass after retention.
    await sql`update vector_index_tables set history_prune_due_at = now() - interval '1 second' where table_key = ${key}`;
    expect(await q.sweepDueMaintenance()).toBe(1);
    await pool.idle();
    expect(await dueIn()).toBeGreaterThanOrEqual(600);

    // The second pass had nothing left to compact: settled, and the table goes quiet again.
    await sql`update vector_index_tables set history_prune_due_at = now() - interval '1 second' where table_key = ${key}`;
    expect(await q.sweepDueMaintenance()).toBe(1);
    await pool.idle();
    expect(await dueIn()).toBeNull();
    expect(await q.sweepDueMaintenance()).toBe(0);
    expect(maintain).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("a write-triggered pass that compacted schedules the prune of what it replaced", async () => {
    const key = lanceTableKey(dir, TABLE);
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    const background = {
      enabled: true, mode: "background" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 20_000,
      optimizeIntervalMs: 300_000, versionRetentionMs: 600_000,
    };
    const maintain = vi.fn(async () => ({ ok: true, rows: 10, optimizedMs: 1, indexCreated: false, fragmentsRemoved: 2 }));
    await queue({ maintain, maintenance: { ...background, enabled: false }, pool }).indexDocument(job("hp-3", makeDocument("hp-3", 10), 10));
    const q = queue({ maintain, maintenance: background, pool });
    const dueIn = async () => (await sql<{ seconds: number | null }[]>`
      select extract(epoch from history_prune_due_at - now())::int as seconds from vector_index_tables where table_key = ${key}`)[0]!.seconds;
    // No delete marked the table: a compacting pass schedules nothing.
    await sql`update vector_index_tables set last_optimized_at = null, history_prune_due_at = null where table_key = ${key}`;
    expect(await q.sweepDueMaintenance()).toBe(1);
    await pool.idle();
    expect(await dueIn()).toBeNull();

    // A delete marked it, not yet due; a write-triggered pass compacts before the due time.
    await sql`update vector_index_tables set rows_since_optimize = 5, last_optimized_at = null,
      history_prune_due_at = now() + interval '5 minutes' where table_key = ${key}`;
    expect(await q.sweepDueMaintenance()).toBe(1);
    await pool.idle();
    expect(await dueIn()).toBeGreaterThanOrEqual(600);
  }, 30_000);

  it("does not settle a prune that came due while a pass started earlier was still running", async () => {
    const key = lanceTableKey(dir, TABLE);
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    const background = {
      enabled: true, mode: "background" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 20_000,
      optimizeIntervalMs: 300_000, versionRetentionMs: 600_000,
    };
    // The pass's cutoff predates the delete; the prune comes due while it is still running.
    const maintain = vi.fn(async () => {
      await sql`update vector_index_tables set history_prune_due_at = clock_timestamp() + interval '40 milliseconds' where table_key = ${key}`;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { ok: true, rows: 10, optimizedMs: 1, indexCreated: false, fragmentsRemoved: 0 };
    });
    await queue({ maintain, maintenance: { ...background, enabled: false }, pool }).indexDocument(job("hp-5", makeDocument("hp-5", 10), 10));
    await sql`update vector_index_tables set rows_since_optimize = 5, last_optimized_at = null,
      history_prune_due_at = now() + interval '5 minutes' where table_key = ${key}`;
    expect(await queue({ maintain, maintenance: background, pool }).sweepDueMaintenance()).toBe(1);
    await pool.idle();
    // Past due by the time the pass finished, and still pending.
    const [row] = await sql<{ overdue: boolean | null }[]>`select history_prune_due_at <= now() as overdue from vector_index_tables where table_key = ${key}`;
    expect(row!.overdue).toBe(true);
  }, 30_000);

  it("drops the prune of a table that no longer exists", async () => {
    const key = lanceTableKey(dir, TABLE);
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    const background = {
      enabled: true, mode: "background" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 20_000,
      optimizeIntervalMs: 300_000, versionRetentionMs: 600_000,
    };
    const maintain = vi.fn(async () => ({ ok: false, rows: null, optimizedMs: null, indexCreated: false, error: "Table 'chunks' was not found" }));
    await queue({ maintain, maintenance: { ...background, enabled: false }, pool }).indexDocument(job("hp-6", makeDocument("hp-6", 10), 10));
    await sql`update vector_index_tables set rows_since_optimize = 0, last_optimized_at = now(),
      history_prune_due_at = now() - interval '1 second' where table_key = ${key}`;
    expect(await queue({ maintain, maintenance: background, pool }).sweepDueMaintenance()).toBe(1);
    await pool.idle();
    const [row] = await sql<{ pending: boolean }[]>`select history_prune_due_at is not null as pending from vector_index_tables where table_key = ${key}`;
    expect(row!.pending).toBe(false);
  }, 30_000);

  it("inline and direct-write deployments sweep due history prunes only", async () => {
    const key = lanceTableKey(dir, TABLE);
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    const inline = { enabled: true, mode: "inline" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 5, optimizeIntervalMs: 1_000, versionRetentionMs: 600_000 };
    const maintain = vi.fn(async () => ({ ok: true, rows: 10, optimizedMs: 1, indexCreated: false, fragmentsRemoved: 0 }));
    await queue({ maintain, maintenance: { ...inline, enabled: false }, pool }).indexDocument(job("hp-4", makeDocument("hp-4", 10), 10));
    const q = queue({ maintain, maintenance: inline, pool });
    // Due by the write counters, which this sweep ignores.
    await sql`update vector_index_tables set rows_since_optimize = 50, last_optimized_at = now() - interval '1 hour' where table_key = ${key}`;
    expect(await q.sweepDueMaintenance(50, true)).toBe(0);
    await sql`update vector_index_tables set history_prune_due_at = now() - interval '1 second' where table_key = ${key}`;
    expect(await q.sweepDueMaintenance(50, true)).toBe(1);
    await pool.idle();
    expect(maintain).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("keeps a history prune that a delete scheduled while maintenance was running", async () => {
    const key = lanceTableKey(dir, TABLE);
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    const background = {
      enabled: true, mode: "background" as const, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 20_000,
      optimizeIntervalMs: 300_000, versionRetentionMs: 600_000,
    };
    const maintain = vi.fn(async () => {
      await markLanceDbHistoryPruneDue(sql, dir, TABLE, background.versionRetentionMs);
      return { ok: true, rows: 10, optimizedMs: 1, indexCreated: false, fragmentsRemoved: 0 };
    });
    await queue({ maintain, maintenance: { ...background, enabled: false }, pool }).indexDocument(job("hp-2", makeDocument("hp-2", 10), 10));
    await sql`update vector_index_tables set rows_since_optimize = 0, last_optimized_at = now(),
      history_prune_due_at = now() - interval '1 second' where table_key = ${key}`;
    expect(await queue({ maintain, maintenance: background, pool }).sweepDueMaintenance()).toBe(1);
    await pool.idle();
    const [row] = await sql<{ pending: boolean }[]>`select history_prune_due_at > now() as pending from vector_index_tables where table_key = ${key}`;
    expect(row!.pending).toBe(true);
  }, 30_000);

  it("background mode returns once rows are committed and runs maintenance in the pool", async () => {
    const pool = new KeyedTaskPool({ concurrency: 1, log: () => undefined });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const maintain = vi.fn(async () => {
      await hold;
      return { ok: true, rows: 3, optimizedMs: 1, indexCreated: false };
    });
    const maintenance = { enabled: true, vectorIndexMinRows: 1_000_000, optimizeEveryRows: 1, optimizeIntervalMs: 3_600_000 };
    const outcome = await queue({ maintain, maintenance, pool }).indexDocument(job("bg-1", makeDocument("bg-1", 3), 3));
    // The document completed while optimize is still running (or not yet started).
    expect(outcome).toMatchObject({ drains: 1, maintenance: null, maintenanceScheduled: true });
    expect(await tableRows()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "bg-1-000" })]));
    release();
    await pool.idle();
    expect(maintain).toHaveBeenCalledTimes(1);
    const key = lanceTableKey(dir, TABLE);
    const [row] = await sql<{ rows_since_optimize: string; maint_holder: string | null }[]>`
      select rows_since_optimize, maint_holder from vector_index_tables where table_key = ${key}`;
    expect(row).toMatchObject({ maint_holder: null });
    expect(Number(row!.rows_since_optimize)).toBe(0);
    // A closed pool (shutdown) refuses new checks; the counters stay due in Postgres.
    await pool.drain(1_000);
    const late = await queue({ maintain, maintenance, pool }).indexDocument(job("bg-2", makeDocument("bg-2", 2), 2));
    expect(late.maintenanceScheduled).toBe(false);
    const [after] = await sql<{ rows_since_optimize: string }[]>`select rows_since_optimize from vector_index_tables where table_key = ${key}`;
    expect(Number(after!.rows_since_optimize)).toBe(2);
  }, 30_000);

  it("applies the cadence in SQL: commits trigger, the minimum interval debounces, the sweep finds due tables", async () => {
    const pool = new KeyedTaskPool({ concurrency: 2, log: () => undefined });
    const maintain = vi.fn(async () => ({ ok: true, rows: 1, optimizedMs: 1, indexCreated: false }));
    const maintenance = {
      enabled: true, vectorIndexMinRows: 1_000_000,
      optimizeEveryRows: 1_000, optimizeEveryCommits: 3, optimizeIntervalMs: 3_600_000, optimizeMinIntervalMs: 60_000,
    };
    const q = queue({ maintain, maintenance, pool });
    await q.indexDocument(job("sq-1", makeDocument("sq-1", 2), 2));
    const key = lanceTableKey(dir, TABLE);
    await pool.idle();
    const runsAfterFirst = maintain.mock.calls.length;
    // Many commits but optimized moments ago: debounced.
    await sql`update vector_index_tables set rows_since_optimize = 5, commits_since_optimize = 9, last_optimized_at = now() where table_key = ${key}`;
    expect(await q.maybeMaintain(key, dir, TABLE)).toBeNull();
    expect(await q.sweepDueMaintenance()).toBe(0);
    // Past the minimum interval, 9 commits >= 3 makes it due; the sweep schedules it.
    await sql`update vector_index_tables set last_optimized_at = now() - interval '2 minutes' where table_key = ${key}`;
    expect(await q.sweepDueMaintenance()).toBe(1);
    await pool.idle();
    expect(maintain.mock.calls.length).toBe(runsAfterFirst + 1);
    const [row] = await sql<{ rows_since_optimize: string; commits_since_optimize: number }[]>`
      select rows_since_optimize, commits_since_optimize from vector_index_tables where table_key = ${key}`;
    expect(Number(row!.rows_since_optimize)).toBe(0);
    expect(Number(row!.commits_since_optimize)).toBe(0);
    // A held maintenance lease hides the table from the sweep (no double run).
    await sql`update vector_index_tables set rows_since_optimize = 5, last_optimized_at = now() - interval '2 hours',
      maint_holder = 'other', maint_expires_at = now() + interval '1 minute' where table_key = ${key}`;
    expect(await q.sweepDueMaintenance()).toBe(0);
  }, 30_000);
});

describe("lanceDbMaintenanceSettings write-path tuning", () => {
  it("defaults to the queued writer with 10-minute version retention", async () => {
    const { lanceDbMaintenanceSettings, DEFAULT_LANCEDB_CADENCE } = await import("../stages/lancedb-maintenance.js");
    const defaults = lanceDbMaintenanceSettings(new URLSearchParams(), {});
    expect(defaults).toMatchObject({ writeMode: "queued", versionRetentionMs: 600_000, vectorIndexMinRows: 1_000, optimizeEveryRows: DEFAULT_LANCEDB_CADENCE.optimizeEveryRows, queueBatchDocuments: 256 });
    const tuned = lanceDbMaintenanceSettings(new URLSearchParams("writeMode=direct&versionRetentionMinutes=30&queueBatchRecords=5000"), {});
    expect(tuned).toMatchObject({ writeMode: "direct", versionRetentionMs: 1_800_000, queueBatchRecords: 5_000 });
    expect(lanceDbMaintenanceSettings(new URLSearchParams("writeMode=direct"), { LANCEDB_WRITE_MODE: "queued" }).writeMode).toBe("queued");
  });
});
