import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type postgres from "postgres";

import type { VectorBackendRecord } from "./embedding-runtime.js";
import {
  lanceMaintenanceKey,
  runLanceDbMaintenance,
  type LanceDbCadencePolicy,
  type LanceDbMaintenanceMode,
  type LanceDbMaintenanceOptions,
  type LanceDbMaintenanceResult,
} from "./lancedb-maintenance.js";
import { lanceMaintenancePool, type KeyedTaskPool } from "./lancedb-maintenance-pool.js";
import { writeLanceDbRecords } from "./lancedb-writer.js";

/**
 * Group-commit writer for the per-org LanceDB tables.
 *
 * Every document of an org (per embedding model) lands in one Lance table, and Lance
 * commits are optimistic: N slots committing to one table at once retry against each
 * other until Lance gives up ("Too many concurrent writers"). This queue turns N commits
 * into one:
 *
 *  1. A document enqueues one outbox row (Postgres) that points at its embedding artifact.
 *  2. It then polls its row. Whoever finds the table's write lease free takes it and
 *     becomes the drainer: it loads every pending document of that table, writes them in
 *     one merge-insert commit, marks them written, and repeats until the queue is empty
 *     or it has led long enough. Everyone else just waits for their row to flip.
 *  3. After draining, the drainer hands a maintenance check to the process maintenance pool
 *     and returns: the document is searchable as soon as its rows are committed (unindexed
 *     rows are flat-scanned), so it does not wait for optimize(). The check claims the table's
 *     maintenance lease (one optimize fleet-wide) when the cadence policy says it is due. The
 *     counters and lease live in Postgres, so a check lost to a crash or shutdown is redone by
 *     the next drainer or the maintenance leader's sweep (sweepDueMaintenance).
 *
 * The lease is fleet-wide (a Postgres row, so it works through a transaction pooler) and
 * only a performance device: writes upsert by chunk id, so a stale drainer racing a new
 * one, or a replayed batch, converges on the same rows. A document's index stage
 * completes only after its rows are committed, so a finished run is searchable.
 */

type Sql = postgres.Sql<Record<string, unknown>>;

export type VectorWriteJob = {
  uri: string;
  table: string;
  orgId: string | null;
  documentId: string;
  runId: string | null;
  /** Object-storage key of the document's embedding artifact. */
  artifactKey: string;
  metadata?: Record<string, unknown>;
  recordCount: number;
};

export type VectorOutboxRow = {
  id: number;
  generation: number;
  documentId: string;
  runId: string | null;
  orgId: string | null;
  artifactKey: string;
  metadata: Record<string, unknown>;
  recordCount: number;
};

export type LanceDbWriteQueueSettings = {
  maxBatchDocuments: number;
  maxBatchRecords: number;
  /** Write lease TTL; renewed every TTL/3 while draining. A dead drainer is replaced after this. */
  leaseTtlMs: number;
  /** A drainer hands the lease back after this long, so one slot does not drain forever. */
  maxLeadMs: number;
  pollMinMs: number;
  pollMaxMs: number;
  waitTimeoutMs: number;
  /** A document whose load or write failed this many times is marked failed. */
  maxAttempts: number;
  loadConcurrency: number;
};

export type LanceDbQueueMaintenancePolicy = LanceDbMaintenanceOptions & Partial<LanceDbCadencePolicy> & {
  enabled: boolean;
  optimizeEveryRows: number;
  optimizeIntervalMs: number;
  /** background (default): schedule into the maintenance pool; inline: await it. */
  mode?: LanceDbMaintenanceMode;
  /** Maintenance lease TTL (renewed while running). */
  leaseTtlMs?: number;
};

export type LanceDbWriteQueueDeps = {
  sql: Sql;
  /** Build a document's Lance rows from its outbox row (normally: read the embedding artifact). */
  loadRecords: (row: VectorOutboxRow) => Promise<VectorBackendRecord[]>;
  write?: (uri: string, table: string, records: VectorBackendRecord[]) => Promise<void>;
  maintain?: (uri: string, table: string, options: LanceDbMaintenanceOptions) => Promise<LanceDbMaintenanceResult>;
  maintenance: LanceDbQueueMaintenancePolicy;
  settings?: Partial<LanceDbWriteQueueSettings>;
  /** Identifies this process in lease rows (diagnostics only; leases use a fresh token per drain). */
  workerId?: string;
  /** Where background maintenance runs (default: the process maintenance pool). */
  pool?: KeyedTaskPool;
};

export type VectorWriteOutcome = {
  /** Wall time from enqueue until the document's rows were committed. */
  waitedMs: number;
  /** Drain leaderships this call took, the batches it committed and the documents in them. */
  drains: number;
  batches: number;
  batchedDocuments: number;
  /** Inline mode: the maintenance this call ran afterwards, if any. */
  maintenance: LanceDbMaintenanceResult | null;
  /** Background mode: whether this call handed a maintenance check to the pool. */
  maintenanceScheduled: boolean;
};

export const DEFAULT_QUEUE_SETTINGS: LanceDbWriteQueueSettings = {
  maxBatchDocuments: 256,
  maxBatchRecords: 20_000,
  leaseTtlMs: 30_000,
  maxLeadMs: 20_000,
  pollMinMs: 150,
  pollMaxMs: 1_500,
  waitTimeoutMs: 600_000,
  maxAttempts: 5,
  loadConcurrency: 16,
};

export class VectorIndexWriteFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorIndexWriteFailed";
  }
}

export function lanceTableKey(uri: string, table: string): string {
  return `${uri}#${table}`;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 1_000);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class LanceDbWriteQueue {
  private readonly sql: Sql;
  private readonly settings: LanceDbWriteQueueSettings;
  private readonly write: NonNullable<LanceDbWriteQueueDeps["write"]>;
  private readonly maintain: NonNullable<LanceDbWriteQueueDeps["maintain"]>;
  private readonly workerId: string;

  constructor(private readonly deps: LanceDbWriteQueueDeps) {
    this.sql = deps.sql;
    this.settings = { ...DEFAULT_QUEUE_SETTINGS, ...deps.settings };
    this.write = deps.write ?? ((uri, table, records) => writeLanceDbRecords(uri, table, records));
    this.maintain = deps.maintain ?? runLanceDbMaintenance;
    this.workerId = deps.workerId ?? process.env.FLY_MACHINE_ID ?? `local-${process.pid}`;
  }

  /** Enqueue a document and return once its rows are committed (draining if nobody else is). */
  async indexDocument(job: VectorWriteJob, signal?: AbortSignal): Promise<VectorWriteOutcome> {
    const started = performance.now();
    const tableKey = lanceTableKey(job.uri, job.table);
    const { id, generation } = await this.enqueue(tableKey, job);
    const outcome: VectorWriteOutcome = {
      waitedMs: 0, drains: 0, batches: 0, batchedDocuments: 0, maintenance: null, maintenanceScheduled: false,
    };
    const deadline = Date.now() + this.settings.waitTimeoutMs;
    let pause = this.settings.pollMinMs;

    for (;;) {
      signal?.throwIfAborted();
      const state = await this.status(id, tableKey);
      if (!state || state.status === "written" || state.generation !== generation) break;
      if (state.status === "failed") {
        throw new VectorIndexWriteFailed(
          `LanceDB write failed for document ${job.documentId} after ${state.attempts} attempts: ${state.lastError ?? "unknown error"}`,
        );
      }
      if (state.leaseFree) {
        const holder = `${this.workerId}:${randomUUID()}`;
        if (await this.tryAcquireWriteLease(tableKey, holder)) {
          const drained = await this.lead(tableKey, job.uri, job.table, holder);
          outcome.drains += 1;
          outcome.batches += drained.batches;
          outcome.batchedDocuments += drained.documents;
          pause = this.settings.pollMinMs;
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new VectorIndexWriteFailed(
          `Timed out after ${this.settings.waitTimeoutMs} ms waiting for the LanceDB write queue (document ${job.documentId}); ` +
            "the row stays queued and a retry re-enqueues it",
        );
      }
      // Jittered so waiters of one table do not poll in lockstep.
      await delay(Math.round(pause * (0.5 + Math.random())), undefined, { signal });
      pause = Math.min(this.settings.pollMaxMs, Math.round(pause * 1.6));
    }

    outcome.waitedMs = Math.round(performance.now() - started);
    // Only drainers check for due maintenance: it keeps the statement count per document at
    // one enqueue plus its polls, and drainers are exactly the ones who just added rows.
    if (outcome.drains > 0 && this.deps.maintenance.enabled) {
      if (this.deps.maintenance.mode === "inline") {
        outcome.maintenance = await this.maybeMaintain(tableKey, job.uri, job.table);
      } else {
        outcome.maintenanceScheduled = this.scheduleMaintenance(tableKey, job.uri, job.table);
      }
    }
    return outcome;
  }

  /**
   * Hand a maintenance check for one table to the pool. The pool keeps it referenced, runs at
   * most one per table, and drains it on shutdown; the check itself claims the fleet-wide
   * lease only if the table is due, so redundant checks are cheap single UPDATEs.
   */
  scheduleMaintenance(tableKey: string, uri: string, table: string): boolean {
    const pool = this.deps.pool ?? lanceMaintenancePool();
    // Same key as direct-mode scheduling, so every background path serializes per table.
    return pool.schedule(lanceMaintenanceKey(uri, table), () => this.maybeMaintain(tableKey, uri, table));
  }

  /**
   * Maintenance leader sweep: schedule a check for every table that is due by the cadence
   * policy and not leased, including tables nobody has written to since (their unindexed tail
   * would otherwise wait for the next write). Returns the number of checks scheduled.
   */
  async sweepDueMaintenance(limit = 50): Promise<number> {
    if (!this.deps.maintenance.enabled) return 0;
    const rows = await this.sql<{ table_key: string; lance_uri: string; lance_table: string }[]>`
      select t.table_key, o.lance_uri, o.lance_table
      from vector_index_tables t
      cross join lateral (
        select lance_uri, lance_table from vector_index_outbox o
        where o.table_key = t.table_key order by o.id desc limit 1
      ) o
      where ${this.dueSql()}
      order by t.last_optimized_at nulls first
      limit ${limit}`;
    let scheduled = 0;
    for (const row of rows) if (this.scheduleMaintenance(row.table_key, row.lance_uri, row.lance_table)) scheduled += 1;
    return scheduled;
  }

  /** lanceDbMaintenanceDue() over vector_index_tables "t", plus a free maintenance lease. */
  private dueSql() {
    const policy = this.deps.maintenance;
    if (policy.mode === "inline") {
      // The trigger before the cadence policy, unchanged.
      return this.sql`
        t.maint_expires_at < now()
        and t.rows_since_optimize > 0
        and (t.rows_since_optimize >= ${policy.optimizeEveryRows}
             or t.last_optimized_at is null and t.rows_since_optimize >= ${Math.min(policy.optimizeEveryRows, 1_000)}
             or t.last_optimized_at < now() - (${policy.optimizeIntervalMs} * interval '1 millisecond'))`;
    }
    const everyCommits = policy.optimizeEveryCommits ?? 2_147_483_647;
    const minIntervalMs = policy.optimizeMinIntervalMs ?? 0;
    return this.sql`
      t.maint_expires_at < now()
      and t.rows_since_optimize > 0
      and (t.last_optimized_at is null
           or t.last_optimized_at < now() - (${minIntervalMs} * interval '1 millisecond')
              and (t.rows_since_optimize >= ${policy.optimizeEveryRows}
                   or t.commits_since_optimize >= ${everyCommits}
                   or t.last_optimized_at < now() - (${policy.optimizeIntervalMs} * interval '1 millisecond')))`;
  }

  async enqueue(tableKey: string, job: VectorWriteJob): Promise<{ id: number; generation: number }> {
    const [row] = await this.sql<{ id: string | number; generation: number }[]>`
      insert into vector_index_outbox
        (table_key, lance_uri, lance_table, org_id, document_id, run_id, artifact_key, metadata, record_count)
      values (${tableKey}, ${job.uri}, ${job.table}, ${job.orgId}, ${job.documentId}, ${job.runId},
              ${job.artifactKey}, ${this.sql.json((job.metadata ?? {}) as postgres.JSONValue)}, ${job.recordCount})
      on conflict (table_key, document_id) do update set
        run_id = excluded.run_id,
        org_id = excluded.org_id,
        artifact_key = excluded.artifact_key,
        metadata = excluded.metadata,
        record_count = excluded.record_count,
        generation = vector_index_outbox.generation + 1,
        status = 'pending',
        attempts = 0,
        last_error = null,
        enqueued_at = now(),
        written_at = null
      returning id, generation`;
    return { id: Number(row!.id), generation: Number(row!.generation) };
  }

  private async status(id: number, tableKey: string): Promise<{
    status: string; generation: number; attempts: number; lastError: string | null; leaseFree: boolean;
  } | null> {
    const [row] = await this.sql<{
      status: string; generation: number; attempts: number; last_error: string | null; lease_free: boolean;
    }[]>`
      select o.status, o.generation, o.attempts, o.last_error,
             (t.table_key is null or t.write_expires_at < now()) as lease_free
      from vector_index_outbox o
      left join vector_index_tables t on t.table_key = ${tableKey}
      where o.id = ${id}`;
    if (!row) return null;
    return {
      status: row.status,
      generation: Number(row.generation),
      attempts: Number(row.attempts),
      lastError: row.last_error,
      leaseFree: Boolean(row.lease_free),
    };
  }

  private async tryAcquireWriteLease(tableKey: string, holder: string): Promise<boolean> {
    const rows = await this.sql`
      insert into vector_index_tables (table_key, write_holder, write_expires_at, updated_at)
      values (${tableKey}, ${holder}, now() + (${this.settings.leaseTtlMs} * interval '1 millisecond'), now())
      on conflict (table_key) do update set
        write_holder = excluded.write_holder, write_expires_at = excluded.write_expires_at, updated_at = now()
      where vector_index_tables.write_expires_at < now()
      returning table_key`;
    return rows.length > 0;
  }

  private async renewWriteLease(tableKey: string, holder: string): Promise<boolean> {
    const rows = await this.sql`
      update vector_index_tables
      set write_expires_at = now() + (${this.settings.leaseTtlMs} * interval '1 millisecond'), updated_at = now()
      where table_key = ${tableKey} and write_holder = ${holder}
      returning table_key`;
    return rows.length > 0;
  }

  private async releaseWriteLease(tableKey: string, holder: string): Promise<void> {
    await this.sql`
      update vector_index_tables set write_holder = null, write_expires_at = now(), updated_at = now()
      where table_key = ${tableKey} and write_holder = ${holder}`;
  }

  /** Drain pending documents of one table while holding its write lease. */
  private async lead(tableKey: string, uri: string, table: string, holder: string): Promise<{ batches: number; documents: number }> {
    const started = Date.now();
    let batches = 0;
    let documents = 0;
    let leaseLost = false;
    const renew = setInterval(() => {
      this.renewWriteLease(tableKey, holder)
        .then((alive) => { if (!alive) leaseLost = true; })
        .catch((error) => console.warn(`[lancedb-queue] lease renew failed table=${table}: ${errorText(error)}`));
    }, Math.max(1_000, Math.floor(this.settings.leaseTtlMs / 3)));
    renew.unref?.();
    try {
      while (!leaseLost) {
        const pending = await this.sql<{
          id: string | number; generation: number; document_id: string; run_id: string | null; org_id: string | null;
          artifact_key: string; metadata: Record<string, unknown>; record_count: number;
        }[]>`
          select id, generation, document_id, run_id, org_id, artifact_key, metadata, record_count
          from vector_index_outbox
          where table_key = ${tableKey} and status = 'pending'
          order by id
          limit ${this.settings.maxBatchDocuments}`;
        if (pending.length === 0) break;
        const batch: VectorOutboxRow[] = [];
        let records = 0;
        for (const row of pending) {
          const count = Number(row.record_count);
          if (batch.length > 0 && records + count > this.settings.maxBatchRecords) break;
          records += count;
          batch.push({
            id: Number(row.id),
            generation: Number(row.generation),
            documentId: row.document_id,
            runId: row.run_id,
            orgId: row.org_id,
            artifactKey: row.artifact_key,
            metadata: row.metadata ?? {},
            recordCount: count,
          });
        }
        documents += await this.commitBatch(tableKey, uri, table, batch);
        batches += 1;
        if (Date.now() - started >= this.settings.maxLeadMs) break;
        if (!(await this.renewWriteLease(tableKey, holder))) break;
      }
    } finally {
      clearInterval(renew);
      await this.releaseWriteLease(tableKey, holder).catch((error) =>
        console.warn(`[lancedb-queue] lease release failed table=${table}: ${errorText(error)}`));
    }
    return { batches, documents };
  }

  /** Load, write and mark one batch. Returns the number of documents committed. */
  private async commitBatch(tableKey: string, uri: string, table: string, batch: VectorOutboxRow[]): Promise<number> {
    const started = performance.now();
    const loaded = await mapLimit(batch, this.settings.loadConcurrency, async (row) => {
      try {
        return { row, records: await this.deps.loadRecords(row), error: null as unknown };
      } catch (error) {
        return { row, records: [] as VectorBackendRecord[], error };
      }
    });
    for (const item of loaded) if (item.error !== null) await this.recordFailure(item.row, item.error);
    const ready = loaded.filter((item) => item.error === null);
    const loadMs = Math.round(performance.now() - started);
    if (ready.length === 0) return 0;

    const writeStarted = performance.now();
    const records = ready.flatMap((item) => item.records);
    let committed: typeof ready = [];
    try {
      await this.write(uri, table, records);
      committed = ready;
    } catch (error) {
      if (ready.length === 1) {
        await this.recordFailure(ready[0]!.row, error);
      } else {
        // Isolate a poison document: write the batch one document at a time.
        console.warn(`[lancedb-queue] batch write failed table=${table} documents=${ready.length}; retrying per document: ${errorText(error)}`);
        for (const item of ready) {
          try {
            await this.write(uri, table, item.records);
            committed.push(item);
          } catch (single) {
            await this.recordFailure(item.row, single);
          }
        }
      }
    }
    if (committed.length > 0) {
      await this.markWritten(tableKey, committed.map((item) => item.row), committed.reduce((sum, item) => sum + item.records.length, 0));
    }
    console.log(
      `[lancedb-queue] commit table=${table} documents=${committed.length}/${batch.length} ` +
        `records=${records.length} load_ms=${loadMs} write_ms=${Math.round(performance.now() - writeStarted)}`,
    );
    return committed.length;
  }

  private async markWritten(tableKey: string, rows: VectorOutboxRow[], records: number): Promise<void> {
    const ids = rows.map((row) => row.id);
    const generations = rows.map((row) => row.generation);
    // A row re-enqueued (generation bumped) during the write stays pending for the next batch.
    await this.sql`
      update vector_index_outbox o set status = 'written', written_at = now(), attempts = o.attempts + 1, last_error = null
      from (select unnest(${ids}::bigint[]) as id, unnest(${generations}::int[]) as generation) v
      where o.id = v.id and o.generation = v.generation and o.status = 'pending'`;
    await this.sql`
      update vector_index_tables set
        rows_since_optimize = rows_since_optimize + ${records},
        commits_since_optimize = commits_since_optimize + 1,
        last_drained_at = now(), updated_at = now()
      where table_key = ${tableKey}`;
  }

  private async recordFailure(row: VectorOutboxRow, error: unknown): Promise<void> {
    const message = errorText(error);
    console.warn(`[lancedb-queue] document write failed document=${row.documentId} generation=${row.generation}: ${message}`);
    await this.sql`
      update vector_index_outbox set
        attempts = attempts + 1,
        last_error = ${message},
        status = case when attempts + 1 >= ${this.settings.maxAttempts} then 'failed' else status end
      where id = ${row.id} and generation = ${row.generation} and status = 'pending'`;
  }

  /**
   * Run optimize + cleanup + index maintenance when due, under the table's maintenance
   * lease so exactly one process fleet-wide compacts a table. Runs concurrently with
   * appends (Lance resolves compaction against pure inserts without conflict); a failed
   * run backs off one interval and keeps its counters.
   */
  async maybeMaintain(tableKey: string, uri: string, table: string): Promise<LanceDbMaintenanceResult | null> {
    const policy = this.deps.maintenance;
    const holder = `${this.workerId}:${randomUUID()}`;
    const ttlMs = policy.leaseTtlMs ?? 600_000;
    const [claim] = await this.sql<{ rows_since_optimize: string | number; commits_since_optimize: number }[]>`
      update vector_index_tables t set maint_holder = ${holder},
        maint_expires_at = now() + (${ttlMs} * interval '1 millisecond'), updated_at = now()
      where t.table_key = ${tableKey} and ${this.dueSql()}
      returning t.rows_since_optimize, t.commits_since_optimize`;
    if (!claim) return null;
    const snapshot = Number(claim.rows_since_optimize);
    const commitsSnapshot = Number(claim.commits_since_optimize);
    const renew = setInterval(() => {
      this.sql`update vector_index_tables set maint_expires_at = now() + (${ttlMs} * interval '1 millisecond')
               where table_key = ${tableKey} and maint_holder = ${holder}`
        .catch((error) => console.warn(`[lancedb-queue] maintenance lease renew failed table=${table}: ${errorText(error)}`));
    }, Math.max(5_000, Math.floor(ttlMs / 3)));
    renew.unref?.();
    let result: LanceDbMaintenanceResult;
    try {
      result = await this.maintain(uri, table, {
        vectorIndexMinRows: policy.vectorIndexMinRows,
        versionRetentionMs: policy.versionRetentionMs,
        // Inline mode keeps the old maintenance: no consolidation.
        maxIndexSegments: policy.mode === "inline" ? 0 : policy.maxIndexSegments,
        consolidateMaxRows: policy.consolidateMaxRows,
      });
    } catch (error) {
      result = { ok: false, rows: null, optimizedMs: null, indexCreated: false, error: errorText(error) };
    } finally {
      clearInterval(renew);
    }
    if (result.ok) {
      await this.sql`
        update vector_index_tables set
          rows_since_optimize = greatest(0, rows_since_optimize - ${snapshot}),
          commits_since_optimize = greatest(0, commits_since_optimize - ${commitsSnapshot}),
          last_optimized_at = now(), last_maintenance_error = null,
          maint_holder = null, maint_expires_at = now(), updated_at = now()
        where table_key = ${tableKey} and maint_holder = ${holder}`;
      // Written rows are only needed until their waiters have seen them.
      await this.sql`
        delete from vector_index_outbox
        where table_key = ${tableKey} and status = 'written' and written_at < now() - interval '1 day'`;
    } else {
      // Leave the counters; the lease expiry doubles as the retry back-off.
      await this.sql`
        update vector_index_tables set
          last_maintenance_error = ${result.error ?? "unknown"}, maint_holder = null,
          maint_expires_at = now() + (${policy.optimizeIntervalMs} * interval '1 millisecond'), updated_at = now()
        where table_key = ${tableKey} and maint_holder = ${holder}`;
    }
    return result;
  }
}
