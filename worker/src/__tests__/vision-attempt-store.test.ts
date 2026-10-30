import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { recordMaterializedPageFee } from "../db/page-base-fee.js";
import { debitRunUsageCredits, persistRunUsageEvents } from "../db/usage-event-store.js";
import { recordVisionRead, VisionRunGuard, type VisionAttemptPurpose, type VisionGuardConfig } from "../lib/vision-attempt-guard.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import type { VisionPageTask } from "../temporal/shared.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** The Postgres vision attempt ledger (migration 0101) behind the vision guard. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const config: VisionGuardConfig = {
  pageAttempts: 2, regionAttempts: 4, breakerMinFailures: 1_000, breakerFailureRate: 1, orgLimitCents: 10, throttleAllowance: 5, routeOverrunLimit: 3,
};

async function insertRuns(rows: Array<[runId: string, orgId: string | null, workspaceId: string]>): Promise<void> {
  const values = rows.map(([id, org, ws]) =>
    `('${id}', ${org ? `'${org}'` : "null"}, 'u1', '${ws}', 'upload', 'processing', 'vision-extract', '{}', '{}')`);
  await db.exec(`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts) values ${values.join(", ")};`);
}

const count = async (query: string) => Number((await db.query<{ n: number }>(query)).rows[0]?.n ?? 0);
const orgCount = (org: string) => count(`select count(*)::int as n from vision_org_attempts where org_id = '${org}'`);
const orgCents = (org: string) => count(`select coalesce(sum(weight_cents), 0)::float8 as n from vision_org_attempts where org_id = '${org}'`);

/** `orgId` is what the caller believes; the backend scopes by the run row. */
const guardOf = (runId: string, orgId: string | null = null, overrides: Partial<VisionGuardConfig> = {}) =>
  new VisionRunGuard({ id: runId, orgId }, { ...config, ...overrides }, store.visionAttempts);

/** One call sending `requests` requests (failed or not), optionally charging its page, then settling. */
async function call(guard: VisionRunGuard, pageNumber: number, requests: number,
  outcome: { failed?: boolean; charged?: boolean } = {}, purpose: VisionAttemptPurpose = "page") {
  const gate = guard.call({ documentId: "d1", pageNumber, purpose });
  try {
    for (let n = 0; n < requests; n += 1) {
      await gate.admit({ weightCents: 1 });
      if (outcome.failed) gate.failed();
    }
    if (outcome.charged) gate.charged();
  } finally {
    await gate.finish();
  }
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id)
      values ('o1', 'One', 'one', 'u1'), ('o2', 'Two', 'two', 'u1'), ('o3', 'Three', 'three', 'u1'), ('o4', 'Four', 'four', 'u1');
    insert into workspaces(id, org_id, user_id, name)
      values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'W2'), ('w3', 'o3', 'u1', 'W3'), ('w4', 'o4', 'u1', 'W4'), ('w-none', null, 'u1', 'Orphan');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
  store = new Store(url, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("PostgresVisionAttemptBackend", () => {
  it("stops many small runs of one org at the org's uncharged count and leaves another org alone", async () => {
    const runs = Array.from({ length: 6 }, (_, index) => `small-${index}`);
    await insertRuns([...runs.map((id): [string, string, string] => [id, "o1", "w1"]), ["other-org", "o2", "w2"]]);
    const stops: string[] = [];
    for (const runId of runs) {
      // Each run: two rejected pages of two requests, under its page bound and breaker.
      const guard = guardOf(runId);
      try {
        for (let page = 1; page <= 2; page += 1) await call(guard, page, 2, { failed: true });
      } catch (error) {
        stops.push(`${runId}:${(error as { stop: { reason: string } }).stop.reason}`);
      }
    }
    // Ten uncharged requests: the third run is refused on its third request, and every later run too.
    expect(stops).toEqual(["small-2:org-attempt-limit", "small-3:org-attempt-limit", "small-4:org-attempt-limit", "small-5:org-attempt-limit"]);
    expect(await orgCount("o1")).toBe(10);
    // The caller's org never moves the scope: claiming o1 for o2's run counts against o2.
    await call(guardOf("other-org", "o1"), 1, 2, { failed: true });
    expect(await orgCount("o2")).toBe(2);
    expect(await orgCount("o1")).toBe(10);
  }, 60_000);

  it("deleting the run or its workspace mid-call does not reset the org's count", async () => {
    await db.exec(`insert into workspaces(id, org_id, user_id, name) values ('w3-doomed', 'o3', 'u1', 'Doomed');`);
    await insertRuns([["doomed-run", "o3", "w3"], ["doomed-ws-run", "o3", "w3-doomed"]]);
    // A call admits a request, then the run is deleted while the request is in flight.
    const runGate = guardOf("doomed-run").call({ documentId: "d1", pageNumber: 1, purpose: "page" });
    await runGate.admit({ weightCents: 1 });
    await db.exec(`delete from workspace_runs where id = 'doomed-run';`);
    await runGate.finish();
    // Same through workspace deletion (which cascades its runs).
    const wsGate = guardOf("doomed-ws-run").call({ documentId: "d1", pageNumber: 1, purpose: "page" });
    await wsGate.admit({ weightCents: 1 });
    await wsGate.admit({ weightCents: 1 });
    await db.exec(`delete from workspaces where id = 'w3-doomed';`);
    await wsGate.finish();
    expect(await count(`select count(*)::int as n from vision_run_attempts where run_id in ('doomed-run', 'doomed-ws-run')`)).toBe(0);
    expect(await orgCount("o3")).toBe(3);
    expect(await count(`select count(*)::int as n from vision_org_attempts where org_id = 'o3' and settled`)).toBe(3);
    // A deleted run admits nothing more.
    await expect(call(guardOf("doomed-run", "o3"), 2, 1)).rejects.toMatchObject({ stop: { reason: "unscoped-run", sticky: true } });
    // A new run of the org starts from the org's count, not zero.
    await insertRuns([["after-delete", "o3", "w3"]]);
    await expect(call(guardOf("after-delete", null, { orgLimitCents: 3 }), 1, 1)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", orgCents: 3 } });
  }, 60_000);

  it("scopes a run without an org to its workspace's org, and refuses one with neither", async () => {
    await insertRuns([["null-org", null, "w4"], ["no-org-at-all", null, "w-none"]]);
    await call(guardOf("null-org"), 1, 1, { failed: true });
    expect(await orgCount("o4")).toBe(1);
    await expect(call(guardOf("no-org-at-all", "o4"), 1, 1)).rejects.toMatchObject({ stop: { reason: "unscoped-run", sticky: true } });
    expect(await orgCount("o4")).toBe(1);
  }, 60_000);

  it("in-flight requests never make a refusal sticky; finished uncharged ones do", async () => {
    await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o5', 'Five', 'five', 'u1');
      insert into workspaces(id, org_id, user_id, name) values ('w5', 'o5', 'u1', 'W5');`);
    await insertRuns([["inflight", "o5", "w5"]]);
    const guard = guardOf("inflight", null, { orgLimitCents: 2 });
    const first = guard.call({ documentId: "d1", pageNumber: 1, purpose: "page" });
    const second = guard.call({ documentId: "d1", pageNumber: 2, purpose: "page" });
    await first.admit({ weightCents: 1 });
    await second.admit({ weightCents: 1 });
    await expect(call(guard, 3, 1)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", sticky: false, orgSettledCents: 0 } });
    expect(guard.stop).toBeNull();
    // A request the provider throttled before accepting it is handed back: room again.
    expect(await first.unbilled("throttle")).toBe(true);
    await call(guard, 3, 1);
    await second.finish();
    await first.finish();
    await expect(call(guard, 4, 1)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", sticky: true } });
    expect(guard.stop?.reason).toBe("org-attempt-limit");
  }, 60_000);

  it("weighs each request by its route's worst case: mixed models in one org share one cents bound", async () => {
    await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o7', 'Seven', 'seven', 'u1');
      insert into workspaces(id, org_id, user_id, name) values ('w7a', 'o7', 'u1', 'Cheap'), ('w7b', 'o7', 'u1', 'Pricey');`);
    await insertRuns([["cheap-run", "o7", "w7a"], ["pricey-run", "o7", "w7b"]]);
    const limit = { orgLimitCents: 10 };
    // The cheap workspace sends 1.5-cent requests, the pricey one 3.5-cent requests, on separate pages.
    const send = async (runId: string, page: number, weightCents: number) => {
      const gate = guardOf(runId, null, limit).call({ documentId: "d1", pageNumber: page, purpose: "page" });
      try {
        await gate.admit({ weightCents });
        gate.failed();
      } finally {
        await gate.finish();
      }
    };
    await send("cheap-run", 1, 1.5);
    await send("pricey-run", 1, 3.5);
    await send("cheap-run", 2, 1.5);
    await send("pricey-run", 2, 3.5);
    expect(await orgCents("o7")).toBe(10);
    // Full by weight (10 of 10), though only four requests were sent.
    await expect(send("cheap-run", 3, 1.5)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", orgCents: 10, requestCents: 1.5 } });
    expect(await orgCount("o7")).toBe(4);
  }, 60_000);

  it("tops up the run row's org by a billed overrun and refuses the route across orgs after the limit", async () => {
    await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o12', 'Twelve', 'twelve', 'u1'), ('o13', 'Thirteen', 'thirteen', 'u1');
      insert into workspaces(id, org_id, user_id, name) values ('w12', 'o12', 'u1', 'W12'), ('w13', 'o13', 'u1', 'W13');`);
    await insertRuns([["overrun-run", "o12", "w12"], ["other-org-run", "o13", "w13"]]);
    const route = { provider: "openrouter", model: "acme/overrun-vl" };
    const limits = { orgLimitCents: 100, routeOverrunLimit: 2 };
    const overrun = async (runId: string, claimedOrg: string | null, page: number) => {
      const gate = guardOf(runId, claimedOrg, limits).call({ documentId: "d1", pageNumber: page, purpose: "page" });
      try {
        await gate.admit({ weightCents: 1, route });
        await gate.overrun({ route, billedCents: 3.5, boundCents: 1 });
      } finally {
        await gate.finish();
      }
    };
    // The caller claims o13; the run row says o12: the top-up lands on o12, settled, beside the request itself.
    await overrun("overrun-run", "o13", 1);
    expect(await orgCents("o12")).toBe(3.5);
    expect(await orgCents("o13")).toBe(0);
    expect(await count(`select count(*)::int as n from vision_org_attempts where org_id = 'o12' and settled`)).toBe(2);
    expect(await count(`select count(*)::int as n from vision_route_overruns where model = 'acme/overrun-vl' and org_id = 'o12'`)).toBe(1);
    // A second overrun, from another org, reaches the route's limit: the route is refused for every org, before
    // anything is admitted, and other routes stay open.
    await overrun("other-org-run", null, 1);
    for (const runId of ["overrun-run", "other-org-run"]) {
      const gate = guardOf(runId, null, limits).call({ documentId: "d1", pageNumber: 9, purpose: "page" });
      await expect(gate.admit({ weightCents: 1, route })).rejects.toMatchObject({ stop: { reason: "route-overrun", sticky: false, routeOverruns: 2 } });
      await gate.admit({ weightCents: 1, route: { provider: "openrouter", model: "acme/other-vl" } });
      await gate.finish();
    }
  }, 60_000);

  it("un-counts only the first charge of a page per run; regions, critique and second reads stay uncharged", async () => {
    await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o6', 'Six', 'six', 'u1');
      insert into workspaces(id, org_id, user_id, name) values ('w6', 'o6', 'u1', 'W6');`);
    await insertRuns([["charges", "o6", "w6"]]);
    await insertDocument("charges-doc", "o6", "w6", "charges");
    const first = await stateOf("charges");
    await readPage(first, "charges-doc", 1);
    await store.updateProgress(first);
    expect(await orgCount("o6")).toBe(0);
    // Another activity of the run reads the same page again: its charge is already persisted.
    const second = await stateOf("charges");
    await readPage(second, "charges-doc", 1, "region");
    await store.updateProgress(second);
    expect(await orgCount("o6")).toBe(1);
    // Critique charges nothing.
    await call(guardOf("charges"), 1, 1, {}, "critique");
    expect(await orgCount("o6")).toBe(2);
    expect(await count(`select count(*)::int as n from usage_events where id = 'rich:charges:charges-doc:1'`)).toBe(1);
    // Page bounds are per page and purpose, in the shared ledger across guards of the run.
    await call(guardOf("charges"), 1, 1, { failed: true });
    await call(guardOf("charges"), 1, 1, { failed: true });
    await expect(call(guardOf("charges"), 1, 1)).rejects.toMatchObject({ stop: { reason: "page-attempt-limit", sticky: false, pageAttempts: 2 } });
    expect(await count(`select failures::int as n from vision_run_attempts where run_id = 'charges' and document_id = 'd1' and page_number = 1 and purpose = 'page'`)).toBe(2);
  }, 60_000);

  describe("a charged read leaves the org count only with its persisted charge", () => {
    beforeAll(async () => {
      await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o8', 'Eight', 'eight', 'u1');
        insert into workspaces(id, org_id, user_id, name) values ('w8', 'o8', 'u1', 'W8'), ('w8-doomed', 'o8', 'u1', 'Doomed');`);
    });

    it("stays counted after settlement and leaves in the checkpoint that inserts the Rich charge", async () => {
      await insertRuns([["h1-ok", "o8", "w8"]]);
      await insertDocument("h1-ok-doc", "o8", "w8", "h1-ok");
      const before = await orgCount("o8");
      const state = await stateOf("h1-ok");
      await readPage(state, "h1-ok-doc", 1);
      // Settled, charge buffered, not yet persisted: still counted, and in flight (never sticky).
      expect(await orgCount("o8")).toBe(before + 1);
      expect(await count(`select count(*)::int as n from vision_org_attempts where org_id = 'o8' and settled`)).toBe(0);
      await store.updateProgress(state);
      expect(await orgCount("o8")).toBe(before);
      expect(await count(`select count(*)::int as n from usage_events where id = 'rich:h1-ok:h1-ok-doc:1'`)).toBe(1);
    }, 60_000);

    it("cancel, workspace deletion or a crash between the read and its checkpoint leave the org count unchanged", async () => {
      await insertRuns([["h1-cancel", "o8", "w8"], ["h1-deleted", "o8", "w8-doomed"], ["h1-crash", "o8", "w8"]]);
      await insertDocument("h1-cancel-doc", "o8", "w8", "h1-cancel");
      await insertDocument("h1-deleted-doc", "o8", "w8-doomed", "h1-deleted");
      await insertDocument("h1-crash-doc", "o8", "w8", "h1-crash");
      const before = await orgCount("o8");
      const cancelled = await stateOf("h1-cancel");
      const deleted = await stateOf("h1-deleted");
      const crashed = await stateOf("h1-crash");
      await readPage(cancelled, "h1-cancel-doc", 1);
      await readPage(deleted, "h1-deleted-doc", 1);
      await readPage(crashed, "h1-crash-doc", 1);
      // Cancel: the activity stops and its state is dropped without a checkpoint.
      await db.exec(`update workspace_runs set status = 'cancelled' where id = 'h1-cancel';`);
      // Workspace deletion cascades the run; its checkpoint then cannot persist the charge.
      await db.exec(`delete from workspaces where id = 'w8-doomed';`);
      await expect(store.updateProgress(deleted)).rejects.toThrow();
      // Crash: the worker dies with the charge only in memory (no checkpoint at all).
      expect(await orgCount("o8")).toBe(before + 3);
      expect(await count(`select count(*)::int as n from usage_events where id like 'rich:h1-%'`)).toBe(1);
    }, 60_000);

    it("a page task that lost its lease persists no charge and keeps its request counted", async () => {
      await insertRuns([["h1-lease", "o8", "w8"]]);
      await insertDocument("h1-lease-doc", "o8", "w8", "h1-lease");
      const task = { runId: "h1-lease", documentId: "h1-lease-doc", pageNumber: 1, pageCount: 1, vision: {} } as unknown as VisionPageTask;
      await store.pageTasks.enqueue([task]);
      const lease = await store.pageTasks.claim(task, "worker-a");
      expect(typeof lease).toBe("string");
      const before = await orgCount("o8");
      const state = await stateOf("h1-lease");
      await readPage(state, "h1-lease-doc", 1);
      // Another worker took the task over.
      await db.exec(`update page_work_tasks set lease_id = 'other-lease' where run_id = 'h1-lease';`);
      await expect(store.pageTasks.finish(task, lease as string, state, { ok: true })).rejects.toThrow(/lease lost/);
      expect(await orgCount("o8")).toBe(before + 1);
      expect(await count(`select count(*)::int as n from usage_events where id = 'rich:h1-lease:h1-lease-doc:1'`)).toBe(0);
    }, 60_000);

    it("a page already charged through another path removes no extra request", async () => {
      await insertRuns([["h1-dup", "o8", "w8"]]);
      await insertDocument("h1-dup-doc", "o8", "w8", "h1-dup");
      // The page's charge was persisted first by a path with no guard request (page-image embedding).
      const other = await stateOf("h1-dup");
      other.usageLedger.chargeRichPage({ documentId: "h1-dup-doc", pageNumber: 1, readBy: "page-image-embedding" });
      await store.updateProgress(other);
      const before = await orgCount("o8");
      // Then a vision read of the same page in a later activity, checkpointed through the page-task path.
      const state = await stateOf("h1-dup");
      await readPage(state, "h1-dup-doc", 1);
      const sql = (store as unknown as { sql: import("postgres").Sql<Record<string, unknown>> }).sql;
      await sql.begin(async (tx) => {
        await persistRunUsageEvents({ client: tx as unknown as import("postgres").Sql<Record<string, unknown>>, state, usageEvents: state.usageLedger.checkpoint().events });
      });
      expect(await orgCount("o8")).toBe(before + 1);
      expect(await count(`select count(*)::int as n from usage_events where id = 'rich:h1-dup:h1-dup-doc:1'`)).toBe(1);
    }, 60_000);

    it("a run without an org bills, attributes and releases under its workspace's org", async () => {
      await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o9', 'Nine', 'nine', 'u1');
        insert into workspaces(id, org_id, user_id, name) values ('w9', 'o9', 'u1', 'W9');`);
      await insertRuns([["null-org-billed", null, "w9"]]);
      await insertDocument("null-org-doc", "o9", "w9", "null-org-billed");
      const state = await stateOf("null-org-billed");
      expect(state.run.orgId).toBe("o9");
      await readPage(state, "null-org-doc", 1);
      expect(await orgCount("o9")).toBe(1);
      await store.updateProgress(state);
      expect(await orgCount("o9")).toBe(0);
      const [charge] = (await db.query<{ org_id: string; cost_cents: string }>(
        `select org_id, cost_cents::text from usage_events where id = 'rich:null-org-billed:null-org-doc:1'`)).rows;
      expect(charge?.org_id).toBe("o9");
      expect(Number(charge?.cost_cents)).toBeGreaterThan(0);
      expect(await count(`select count(*)::int as n from credit_debits_pending where org_id = 'o9' and run_id = 'null-org-billed'`)).toBe(1);
    }, 60_000);

    describe("a failing credit debit rolls back the charge and the ticket release together", () => {
      beforeAll(async () => {
        await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o10', 'Ten', 'ten', 'u1');
          insert into workspaces(id, org_id, user_id, name) values ('w10', 'o10', 'u1', 'W10');
          create function test_fail_o10_debit() returns trigger language plpgsql as $$
          begin
            if new.org_id = 'o10' then raise exception 'injected debit failure'; end if;
            return new;
          end $$;
          create trigger test_fail_o10_debit before insert on credit_debits_pending
            for each row execute function test_fail_o10_debit();`);
      });

      afterAll(async () => {
        await db.exec(`drop trigger test_fail_o10_debit on credit_debits_pending; drop function test_fail_o10_debit();`);
      });

      it("in the run checkpoint", async () => {
        await insertRuns([["debit-fail", "o10", "w10"]]);
        await insertDocument("debit-fail-doc", "o10", "w10", "debit-fail");
        const state = await stateOf("debit-fail");
        await readPage(state, "debit-fail-doc", 1);
        expect(await orgCount("o10")).toBe(1);
        await expect(store.updateProgress(state)).rejects.toThrow(/injected debit failure/);
        // Neither the charge nor the release survived: the request is still counted for the org.
        expect(await count(`select count(*)::int as n from usage_events where id = 'rich:debit-fail:debit-fail-doc:1'`)).toBe(0);
        expect(await orgCount("o10")).toBe(1);
      }, 60_000);

      it("in the page-task path (persistRunUsageEvents then debitRunUsageCredits)", async () => {
        await insertRuns([["debit-fail-task", "o10", "w10"]]);
        await insertDocument("debit-fail-task-doc", "o10", "w10", "debit-fail-task");
        const before = await orgCount("o10");
        const state = await stateOf("debit-fail-task");
        await readPage(state, "debit-fail-task-doc", 1);
        const sql = (store as unknown as { sql: import("postgres").Sql<Record<string, unknown>> }).sql;
        await expect(sql.begin(async (tx) => {
          const client = tx as unknown as import("postgres").Sql<Record<string, unknown>>;
          const cost = await persistRunUsageEvents({ client, state, usageEvents: state.usageLedger.checkpoint().events });
          // The release happened inside the transaction before the debit fails.
          expect(Number((await client`select count(*)::int as n from vision_org_attempts where org_id = 'o10'`)[0]!.n)).toBe(before);
          await debitRunUsageCredits({ client, state, costCents: cost });
        })).rejects.toThrow(/injected debit failure/);
        expect(await count(`select count(*)::int as n from usage_events where id = 'rich:debit-fail-task:debit-fail-task-doc:1'`)).toBe(0);
        expect(await orgCount("o10")).toBe(before + 1);
      }, 60_000);
    });

    it("bills a null-org run's materialized pages under its workspace's org", async () => {
      await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o11', 'Eleven', 'eleven', 'u1');
        insert into workspaces(id, org_id, user_id, name) values ('w11', 'o11', 'u1', 'W11');`);
      await insertRuns([["null-org-fee", null, "w11"]]);
      await insertDocument("null-org-fee-doc", "o11", "w11", "null-org-fee");
      const sql = (store as unknown as { sql: import("postgres").Sql<Record<string, unknown>> }).sql;
      expect(await recordMaterializedPageFee(sql, "null-org-fee", "null-org-fee-doc", [1, 2])).toBeGreaterThan(0);
      expect(await count(`select count(*)::int as n from usage_events where run_id = 'null-org-fee' and org_id = 'o11'`)).toBe(2);
      expect(await count(`select count(*)::int as n from credit_debits_pending where org_id = 'o11' and run_id = 'null-org-fee'`)).toBe(1);
    }, 60_000);
  });
});

async function insertDocument(id: string, orgId: string, workspaceId: string, runId: string): Promise<void> {
  await db.exec(`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
    values ('${id}', '${orgId}', 'u1', '${workspaceId}', '${runId}', '${id}.pdf', 'application/pdf', 'raw/${id}', 'processing', 2);`);
}

/** An activity's state for `runId`, loaded through the store with the shared ledger. */
async function stateOf(runId: string): Promise<WorkflowState> {
  const state = WorkflowState.create(await store.loadRun(runId), []);
  state.visionAttempts = store.visionAttempts;
  return state;
}

/** One successful vision read of a page, recorded in `state`'s usage ledger, then settled. */
async function readPage(state: WorkflowState, documentId: string, pageNumber: number, purpose: VisionAttemptPurpose = "page") {
  const guard = new VisionRunGuard({ id: state.run.id, orgId: state.run.orgId ?? null }, config, store.visionAttempts);
  const gate = guard.call({ documentId, pageNumber, purpose });
  try {
    await gate.admit({ weightCents: 1 });
    recordVisionRead(state.usageLedger, gate, { documentId, pageNumber }, {
      provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017", metric: "page-analysis", amount: 1, unit: "page",
      costCents: 0.1, inputTokens: 1_000, outputTokens: 200, metadata: { documentId, pageNumber },
    });
  } finally {
    await gate.finish();
  }
}

describe("startup schema check", () => {
  it("passes on the current 0101 and refuses an earlier draft loudly, asking for a reset", async () => {
    await expect(store.visionAttempts.assertSchema()).resolves.toBeUndefined();
    await db.exec(`alter table vision_org_attempts rename column weight_cents to weight_cents_old;`);
    try {
      await expect(store.visionAttempts.assertSchema()).rejects.toThrow(/weight_cents missing.*database reset required/);
    } finally {
      await db.exec(`alter table vision_org_attempts rename column weight_cents_old to weight_cents;`);
    }
    await db.exec(`create table vision_run_charged_pages (run_id text);`);
    try {
      await expect(store.visionAttempts.assertSchema()).rejects.toThrow(/stale vision_run_charged_pages present.*database reset required/);
    } finally {
      await db.exec(`drop table vision_run_charged_pages;`);
    }
    await db.exec(`alter table vision_route_overruns rename to vision_route_overruns_old;`);
    try {
      await expect(store.visionAttempts.assertSchema()).rejects.toThrow(/vision_route_overruns missing.*database reset required/);
    } finally {
      await db.exec(`alter table vision_route_overruns_old rename to vision_route_overruns;`);
    }
    await expect(store.visionAttempts.assertSchema()).resolves.toBeUndefined();
  }, 60_000);
});
