import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";



let db: PGlite;
let server: PGLiteSocketServer;
let url: string;

async function seedRun(runId: string) {
  await db.exec(`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, execution_generation)
      values ('${runId}', 'o1', 'u1', 'w', 'upload', 'processing', 'embed', '{}', 3, null);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, created_at)
      values ('${runId}-bad', 'o1', 'u1', 'w', '${runId}', 'bad.pdf', 'application/pdf', 'k1', 'processing', 2, '2026-01-01'),
             ('${runId}-mid', 'o1', 'u1', 'w', '${runId}', 'mid.pdf', 'application/pdf', 'k2', 'processing', 1, '2026-01-02'),
             ('${runId}-new', 'o1', 'u1', 'w', '${runId}', 'new.pdf', 'application/pdf', 'k3', 'queued', 1, '2026-01-03');
  `);
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into webhooks(id, user_id, org_id, url, secret) values ('wh', 'u1', 'o1', 'https://example.test/hook', 's');
  `);
  await seedRun("run-fail");
  await seedRun("run-ok");
  const served = await serveOnRandomPort(db);
  server = served.server;
  url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
});

// The socket server serves one client at a time, so each phase opens and closes its own pool.
async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(url, 60_000, { poolMax: 1 });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

async function statuses(runId: string) {
  const rows = await db.query<{ id: string; status: string }>(
    `select id, status from documents where run_id = $1 order by id`, [runId]);
  return Object.fromEntries(rows.rows.map((row) => [row.id.replace(`${runId}-`, ""), row.status]));
}

describe("partial Document failure in the store", () => {
  it("commits success once after acknowledgement loss and fences stale and tenant owners", async () => {
    await seedRun("success-retry");
    await db.exec("update workspace_runs set execution_generation = 'g1' where id = 'success-retry'");
    const owner = { runId: "success-retry", orgId: "o1", workspaceId: "w", executionGeneration: "g1" };
    await withStore(async store => {
      await store.completeRun(await loadRunState(store, owner.runId), owner);
      await store.completeRun(await loadRunState(store, owner.runId), owner);
      for (const mismatch of [{ executionGeneration: "old" }, { orgId: "other" }, { workspaceId: "other" }]) {
        await expect(store.completeRun(await loadRunState(store, owner.runId), { ...owner, ...mismatch })).rejects.toThrow("ownership");
      }
    });
    for (const table of ["run_terminal_receipts", "workspace_run_events"]) {
      expect((await db.query(`select id from ${table} where run_id = 'success-retry'`)).rows).toHaveLength(1);
    }
    expect((await db.query("select id from webhook_outbox where payload->>'runId' = 'success-retry'")).rows).toHaveLength(1);
    expect((await db.query("select id from usage_events where id = 'fast:success-retry'")).rows).toHaveLength(1);
  });

  it("rolls back success documents, billing, receipt and event when webhook persistence fails", async () => {
    await seedRun("success-rollback");
    await withStore(async store => {
      const state = await loadRunState(store, "success-rollback");
      state.usageLedger.enqueue({ id: "rollback-usage", provider: "local", model: "compute", metric: "compute", amount: 1, unit: "second", costCents: 2 });
      const pending = state.usageLedger.pendingBillableCents;
      const spy = vi.spyOn(store, "triggerWebhooks").mockRejectedValueOnce(new Error("outbox unavailable"));
      await expect(store.completeRun(state)).rejects.toThrow("outbox unavailable");
      expect(state.usageLedger.pendingBillableCents).toBe(pending);
      spy.mockRestore();
    });
    expect(Object.values(await statuses("success-rollback"))).toEqual(["processing", "processing", "queued"]);
    for (const table of ["run_terminal_receipts", "workspace_run_events", "usage_events"]) {
      expect((await db.query(`select id from ${table} where run_id = 'success-rollback'`)).rows).toHaveLength(0);
    }
    expect((await db.query("select status from workspace_runs where id = 'success-rollback'")).rows).toEqual([{ status: "processing" }]);
    await withStore(async store => store.completeRun(await loadRunState(store, "success-rollback")));
  });

  it("deduplicates an acknowledged-lost commit and rejects stale or cross-tenant owners", async () => {
    await seedRun("receipt-retry");
    await db.exec("update workspace_runs set execution_generation = 'g1' where id = 'receipt-retry'");
    const owner = { runId: "receipt-retry", orgId: "o1", workspaceId: "w", executionGeneration: "g1" };
    await withStore(async (store) => {
      await store.failRun(owner.runId, "embed", "first", owner);
      // Caller lost the acknowledgement: retry with a different error must not rewrite the outcome.
      await store.failRun(owner.runId, "embed", "retry", owner);
      for (const mismatch of [{ executionGeneration: "old" }, { orgId: "other" }, { workspaceId: "other" }]) {
        await expect(store.failRun(owner.runId, "embed", "stale", { ...owner, ...mismatch })).rejects.toThrow("ownership");
      }
      await store.finalizeRun(owner, "completed", async () => { throw new Error("competing finalizer ran"); });
    });
    expect((await db.query("select failure_count, error from workspace_runs where id = 'receipt-retry'")).rows)
      .toEqual([{ failure_count: 1, error: "first" }]);
    expect((await db.query("select id from workspace_run_events where run_id = 'receipt-retry' and event_type = 'run.failed'")).rows).toHaveLength(1);
    expect((await db.query("select id from webhook_outbox where payload->>'runId' = 'receipt-retry'")).rows).toHaveLength(1);
  });

  it("rolls back all failure writes when webhook persistence fails, then retries", async () => {
    await seedRun("receipt-rollback");
    const owner = { runId: "receipt-rollback", orgId: "o1", workspaceId: "w" };
    await withStore(async (store) => {
      const webhook = vi.spyOn(store, "triggerWebhooks").mockRejectedValueOnce(new Error("outbox unavailable"));
      await expect(store.failRun(owner.runId, "embed", "failure", owner)).rejects.toThrow("outbox unavailable");
      webhook.mockRestore();
    });
    expect((await db.query("select status, failure_count from workspace_runs where id = 'receipt-rollback'")).rows)
      .toEqual([{ status: "processing", failure_count: 0 }]);
    expect(await statuses(owner.runId)).toEqual({ bad: "processing", mid: "processing", new: "queued" });
    expect((await db.query("select id from run_terminal_receipts where run_id = 'receipt-rollback'")).rows).toHaveLength(0);
    expect((await db.query("select id from workspace_run_events where run_id = 'receipt-rollback'")).rows).toHaveLength(0);
    await withStore(store => store.failRun(owner.runId, "embed", "failure", owner));
  });

  it.each(["complete", "fail"] as const)("retires an unflagged replaced pending document when its active run ends: %s", async (outcome) => {
    const runId = `unflagged-${outcome}`;
    await seedRun(runId);
    await db.exec(`
      update documents set status = 'cancelled' where id = '${runId}-bad';
      update documents set canonical_id = '/${runId}' where id = '${runId}-mid';
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
        values ('${runId}-replacement', 'o1', 'u1', 'w', 'upload', 'processing', 'index', '{}');
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, canonical_id, created_at)
        values ('${runId}-replacement-doc', 'o1', 'u1', 'w', '${runId}-replacement', 'mid.pdf', 'application/pdf', 'replacement', 'completed', '/${runId}', '2026-01-04');
    `);
    expect((await db.query<{ superseded_at: null }>("select superseded_at from documents where id = $1", [`${runId}-mid`])).rows[0]?.superseded_at).toBeNull();
    await withStore(async (store) => {
      if (outcome === "complete") await store.completeRun(await loadRunState(store, runId));
      else await store.failRun(runId, "embed", "lost worker", { runId: runId, orgId: "o1", workspaceId: "w" });
    });
    expect(await statuses(runId)).toEqual({ bad: "cancelled", mid: "cancelled", new: outcome === "complete" ? "completed" : "queued" });
    expect((await db.query<{ replacement: string }>("select superseded_by_document_id as replacement from documents where id = $1", [`${runId}-mid`])).rows[0]?.replacement)
      .toBe(`${runId}-replacement-doc`);
  });

  it("retires pending superseded history instead of promoting it when a run completes", async () => {
    await seedRun("run-closed-history");
    await db.exec(`update documents set status = 'cancelled' where id = 'run-closed-history-bad';
      update documents set superseded_at = now() where id = 'run-closed-history-mid'`);
    await withStore(async (store) => {
      const state = await loadRunState(store, "run-closed-history");
      await store.completeRun(state);
    });
    expect(await statuses("run-closed-history")).toEqual({ bad: "cancelled", mid: "cancelled", new: "completed" });
  });

  it("does not resurrect cancelled or superseded documents when a run fails", async () => {
    await seedRun("run-history");
    await db.exec(`update documents set status = 'cancelled' where id = 'run-history-bad';
      update documents set superseded_at = now() where id = 'run-history-mid'`);
    await withStore(async (store) => {
      await store.failRun("run-history", "embed", "lost worker", { runId: "run-history", orgId: "o1", workspaceId: "w" });
      expect((await store.loadDocumentsForRun("run-history")).map(document => document.id)).toEqual(["run-history-new"]);
    });
    expect(await statuses("run-history")).toEqual({ bad: "cancelled", mid: "cancelled", new: "queued" });
  });

  it("a failed Run fails only Documents with a failed stage and leaves the rest queued for retry", async () => {
    await withStore(async (store) => {
      const state = await loadRunState(store, "run-fail");
      await store.startDocumentStage(state, "run-fail-bad", "embed");
      await store.failDocumentStage(state, "run-fail-bad", "embed", "unparseable");
      await store.startDocumentStage(state, "run-fail-mid", "extract");
      await store.completeDocumentStage(state, "run-fail-mid", "extract", "s3://x", {});
      await store.failRun("run-fail", "embed", "database went away", { runId: "run-fail", orgId: "o1", workspaceId: "w" });
    });
    expect(await statuses("run-fail")).toEqual({ bad: "failed", mid: "queued", new: "queued" });
  });

  it("a Run with a failed Document completes, keeps it failed and records failedDocuments", async () => {
    await withStore(async (store) => {
      const state = await loadRunState(store, "run-ok");
      state.totalStages = 2;
      await store.startDocumentStage(state, "run-ok-bad", "embed");
      await store.failDocumentStage(state, "run-ok-bad", "embed", "unparseable");
      for (const id of ["run-ok-mid", "run-ok-new"]) {
        await store.startDocumentStage(state, id, "embed");
        await store.completeDocumentStage(state, id, "embed", "s3://x", {});
      }
      const fresh = await loadRunState(store, "run-ok", { totalStages: 2 });
      await store.completeRun(fresh);
    });
    expect(await statuses("run-ok")).toEqual({ bad: "failed", mid: "completed", new: "completed" });
    const [run] = (await db.query<{ status: string; processed_documents: number; stats: Record<string, number> }>(
      `select status, processed_documents, stats from workspace_runs where id = 'run-ok'`)).rows;
    expect(run).toMatchObject({ status: "completed", processed_documents: 3 });
    expect(run!.stats).toMatchObject({ failedDocuments: 1, failedDocumentStages: 1 });

    // The run.completed webhook carries the failure count.
    const outbox = await db.query<{ payload: Record<string, unknown> }>(
      `select payload from webhook_outbox where event_type = 'run.completed' and payload->>'runId' = 'run-ok'`);
    expect(outbox.rows[0]!.payload).toMatchObject({ runId: "run-ok", status: "completed", failedDocuments: 1 });
  });
});
