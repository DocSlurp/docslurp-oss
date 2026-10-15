import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolveCreditLeaseConfig } from "@docslurp/shared";

import { setCreditLeaseConfig } from "../db/credit-lease.js";
import { setSpendCheckConfig, spendCounterSql } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { WorkflowState } from "../pipeline/pipeline.js";

/**
 * Lock order between run-row checkpoints and the child rows written beside
 * them (page_stage_states, usage_events, performance_log, ...), under real
 * concurrency. PGlite serves one connection at a time, so this needs a real,
 * migrated, throwaway Postgres:
 *
 *   CHECKPOINT_LOCK_TEST_DATABASE_URL=postgres://… pnpm --filter worker test -- checkpoint-lock-order
 *
 * Regression for the `deadlock detected` (40P01) a 10-document sharded batch
 * hit in extract-markdown (internal research notes):
 * a shard's finishShard checkpoint updated the run row, then took
 * `FOR UPDATE` on it for the spend counters. FOR UPDATE conflicts with the
 * FOR KEY SHARE lock every foreign-key check on a child row takes, so a
 * concurrent multi-row page_stage_states insert from another shard and the
 * checkpoint waited on each other.
 */
type Sql = postgres.Sql<Record<string, unknown>>;

const realUrl = process.env.CHECKPOINT_LOCK_TEST_DATABASE_URL;
const prefix = "lockorder";
const runId = `${prefix}-run`;
const docIds = Array.from({ length: 16 }, (_, index) => `${prefix}-doc-${index}`);

async function seed(pg: Sql) {
  await pg`insert into "user" (id, name, email) values ('lock-u1', 'U', 'lock-u1@example.com') on conflict do nothing`;
  await pg`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents)
    values (${`${prefix}-org`}, 'Lock', ${`${prefix}-org`}, 'lock-u1', 1000000)`;
  await pg`insert into workspaces (id, org_id, user_id, name) values (${`${prefix}-ws`}, ${`${prefix}-org`}, 'lock-u1', 'W')`;
  await pg`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts)
    values (${runId}, ${`${prefix}-org`}, 'lock-u1', ${`${prefix}-ws`}, 'bulk-upload', 'processing', 'extract-markdown', '{}', '{}')`;
  for (const id of docIds) {
    await pg`insert into documents (id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values (${id}, 'lock-u1', ${`${prefix}-ws`}, ${runId}, ${`${id}.pdf`}, 'application/pdf', ${`k/${id}`}, 'processing', 10)`;
  }
}

async function wipe(pg: Sql) {
  await pg`delete from credit_debits_pending where org_id = ${`${prefix}-org`}`;
  await pg`delete from usage_events where run_id = ${runId}`;
  await pg`delete from workspace_runs where id = ${runId}`;
  await pg`delete from documents where id like ${`${prefix}-%`}`;
  await pg`delete from workspaces where id = ${`${prefix}-ws`}`;
  await pg`delete from organizations where id = ${`${prefix}-org`}`;
}

describe.skipIf(!realUrl)("run checkpoint lock order under real concurrency", () => {
  let pg: Sql;
  let store: Store;

  beforeAll(async () => {
    pg = postgres(realUrl!, { max: 16, prepare: false, onnotice: () => undefined }) as unknown as Sql;
    store = new Store(realUrl!, 60_000, { poolMax: 16 });
    // The cadence counters (spendCounterSql) are the default path.
    setCreditLeaseConfig(resolveCreditLeaseConfig({ WORKER_CREDIT_LEASES: "off" }));
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
  });

  afterAll(async () => {
    if (pg) await wipe(pg);
    await store?.close();
    await pg?.end();
    setSpendCheckConfig(null);
    setCreditLeaseConfig(null);
  });

  beforeEach(async () => {
    await wipe(pg);
    await seed(pg);
  });

  it("a shard checkpoint never waits on child-row foreign-key locks (the observed interleaving)", async () => {
    const pages = await pg.reserve();
    const checkpoint = await pg.reserve();
    try {
      // Shard B: a page_stage_states insert holds FOR KEY SHARE on the run row.
      await pages`begin`;
      await pages`insert into page_stage_states (run_id, document_id, stage_name, page_number, status, completed_at)
        values (${runId}, ${docIds[0]!}, 'extract-markdown', 1, 'completed', now())`;
      // Shard A: finishShard's prelude, then the spend-counter checkpoint update.
      await checkpoint`begin`;
      await checkpoint`update workspace_runs set shard_demand = greatest(0, shard_demand - 1) where id = ${runId}`;
      const counter = spendCounterSql(checkpoint as unknown as Sql, runId, checkpoint`0`, 0);
      const runUpdate = checkpoint`
        update workspace_runs set ${counter.assignments}, stage = 'extract-markdown', updated_at = now()
        from ${counter.from} where workspace_runs.id = spend_prev.id
        returning ${counter.checkDue} as spend_check_due`;
      const runUpdateDone = runUpdate.then(() => "done" as const, (error: { code?: string }) => error.code ?? "error");
      // With FOR UPDATE the checkpoint queues behind B's open transaction (a
      // convoy, and half of the deadlock cycle); FOR NO KEY UPDATE goes through.
      const whileBOpen = await Promise.race([
        runUpdateDone,
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
      ]);
      // Shard B: more pages of the same batch, each with its own FK check.
      const pageInsert = await pages`insert into page_stage_states (run_id, document_id, stage_name, page_number, status, completed_at)
        values (${runId}, ${docIds[0]!}, 'extract-markdown', 2, 'completed', now())`.then(() => "done", (error: { code?: string }) => error.code ?? "error");
      await pages`commit`.catch(() => undefined);
      const afterBCommit = await runUpdateDone;
      await checkpoint`commit`.catch(() => undefined);
      expect({ whileBOpen, pageInsert, afterBCommit }).toEqual({ whileBOpen: "done", pageInsert: "done", afterBCommit: "done" });
    } finally {
      await checkpoint`rollback`.catch(() => undefined);
      await pages`rollback`.catch(() => undefined);
      checkpoint.release();
      pages.release();
    }
  }, 30_000);

  // The cycle needs a particular interleaving; repeat the batch to hit it (about
  // one batch in four deadlocked with FOR UPDATE on an idle 8-CPU host).
  it.each(Array.from({ length: 6 }, (_, index) => index + 1))("parallel shard checkpoints and page batches finish without deadlocks or lost usage (batch %i)", async () => {
    const shards = 4;
    const rounds = 10;
    const pageNumbers = Array.from({ length: 50 }, (_, index) => index + 1);
    const docsPerShard = docIds.length / shards;
    const errors: unknown[] = [];
    let expectedCents = 0;

    const runShard = async (shardIndex: number) => {
      const documentIds = docIds.slice(shardIndex * docsPerShard, (shardIndex + 1) * docsPerShard);
      const state = WorkflowState.create(await store.loadRun(runId), []);
      state.stage = "extract-markdown";
      state.beginShard(documentIds);
      // Documents of a shard run concurrently and share its state, as runDocuments does.
      await Promise.all(documentIds.map(async (documentId) => {
        for (let round = 0; round < rounds; round++) {
          // A multi-row page batch (one FK check per row) racing other shards' checkpoints.
          await store.setPagesStageComplete(runId, documentId, `extract-markdown-${round}`, pageNumbers);
          state.usageLedger.enqueue({
            provider: "docslurp", model: "local-compute", metric: "worker-stage",
            amount: 1, unit: "stage", costCents: 0.5, metadata: { shardIndex, round, documentId },
          });
          expectedCents += 0.5;
          state.artifactLedger.record(`${documentId}:round-${round}`, `s3://x/${documentId}/${round}`);
          await store.updateProgress(state);
        }
      }));
      await store.finishShard(state);
    };

    await Promise.all(Array.from({ length: shards }, (_, index) => runShard(index).catch((error) => {
      errors.push(error);
    })));

    expect(errors.map((error) => (error as { code?: string; message?: string }).code ?? String(error))).toEqual([]);
    const [usage] = await pg<{ events: number; cents: string }[]>`
      select count(*)::int as events, coalesce(sum(cost_cents), 0) as cents from usage_events where run_id = ${runId}`;
    expect(usage!.events).toBe(shards * docsPerShard * rounds);
    expect(Number(usage!.cents)).toBeCloseTo(expectedCents, 6);
    const [run] = await pg<{ spent_cents: string; artifacts: Record<string, string> }[]>`
      select spent_cents, artifacts from workspace_runs where id = ${runId}`;
    expect(Number(run!.spent_cents)).toBeCloseTo(expectedCents, 6);
    expect(Object.keys(run!.artifacts)).toHaveLength(docIds.length * rounds);
  }, 120_000);

  it("concurrent checkpoints of one shard state count its cost and usage once", async () => {
    const state = WorkflowState.create(await store.loadRun(runId), []);
    state.stage = "extract-markdown";
    state.beginShard(docIds.slice(0, 2));
    state.usageLedger.enqueue({ provider: "docslurp", model: "local-compute", metric: "worker-stage", amount: 1, unit: "stage", costCents: 5 });
    await Promise.all([store.updateProgress(state), store.updateProgress(state), store.finishShard(state)]);
    const [run] = await pg<{ spent_cents: string }[]>`select spent_cents from workspace_runs where id = ${runId}`;
    expect(Number(run!.spent_cents)).toBe(5);
    const [usage] = await pg<{ cents: string }[]>`select coalesce(sum(cost_cents), 0) as cents from usage_events where run_id = ${runId}`;
    expect(Number(usage!.cents)).toBe(5);
  }, 30_000);
});
