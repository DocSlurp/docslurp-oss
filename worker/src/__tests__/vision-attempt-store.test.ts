import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { VisionRunGuard, type VisionAttemptPurpose, type VisionGuardConfig } from "../lib/vision-attempt-guard.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** The Postgres vision attempt ledger (migration 0101) behind the vision guard. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const config: VisionGuardConfig = {
  pageAttempts: 2, regionAttempts: 4, breakerMinFailures: 1_000, breakerFailureRate: 1, orgAttemptLimit: 10,
};

async function insertRuns(rows: Array<[runId: string, orgId: string | null, workspaceId: string]>): Promise<void> {
  const values = rows.map(([id, org, ws]) =>
    `('${id}', ${org ? `'${org}'` : "null"}, 'u1', '${ws}', 'upload', 'processing', 'vision-extract', '{}', '{}')`);
  await db.exec(`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts) values ${values.join(", ")};`);
}

const count = async (query: string) => Number((await db.query<{ n: number }>(query)).rows[0]?.n ?? 0);
const orgCount = (org: string) => count(`select count(*)::int as n from vision_org_attempts where org_id = '${org}'`);

/** `orgId` is what the caller believes; the backend scopes by the run row. */
const guardOf = (runId: string, orgId: string | null = null, overrides: Partial<VisionGuardConfig> = {}) =>
  new VisionRunGuard({ id: runId, orgId }, { ...config, ...overrides }, store.visionAttempts);

/** One call sending `requests` requests (failed or not), optionally charging its page, then settling. */
async function call(guard: VisionRunGuard, pageNumber: number, requests: number,
  outcome: { failed?: boolean; charged?: boolean } = {}, purpose: VisionAttemptPurpose = "page") {
  const gate = guard.call({ documentId: "d1", pageNumber, purpose });
  try {
    for (let n = 0; n < requests; n += 1) {
      await gate.admit();
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
    await runGate.admit();
    await db.exec(`delete from workspace_runs where id = 'doomed-run';`);
    // Even a claimed charge cannot un-count it: the run is gone, so the charge cannot be confirmed.
    runGate.charged();
    await runGate.finish();
    // Same through workspace deletion (which cascades its runs).
    const wsGate = guardOf("doomed-ws-run").call({ documentId: "d1", pageNumber: 1, purpose: "page" });
    await wsGate.admit();
    await wsGate.admit();
    await db.exec(`delete from workspaces where id = 'w3-doomed';`);
    await wsGate.finish();
    expect(await count(`select count(*)::int as n from vision_run_attempts where run_id in ('doomed-run', 'doomed-ws-run')`)).toBe(0);
    expect(await orgCount("o3")).toBe(3);
    expect(await count(`select count(*)::int as n from vision_org_attempts where org_id = 'o3' and settled`)).toBe(3);
    // A deleted run admits nothing more.
    await expect(call(guardOf("doomed-run", "o3"), 2, 1)).rejects.toMatchObject({ stop: { reason: "unscoped-run", sticky: true } });
    // A new run of the org starts from the org's count, not zero.
    await insertRuns([["after-delete", "o3", "w3"]]);
    await expect(call(guardOf("after-delete", null, { orgAttemptLimit: 3 }), 1, 1)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", orgAttempts: 3 } });
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
    const guard = guardOf("inflight", null, { orgAttemptLimit: 2 });
    const first = guard.call({ documentId: "d1", pageNumber: 1, purpose: "page" });
    const second = guard.call({ documentId: "d1", pageNumber: 2, purpose: "page" });
    await first.admit();
    await second.admit();
    await expect(call(guard, 3, 1)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", sticky: false, orgSettledAttempts: 0 } });
    expect(guard.stop).toBeNull();
    // The first read creates the page's charge: its request leaves the count.
    first.charged();
    await first.finish();
    await call(guard, 3, 1);
    await second.finish();
    await expect(call(guard, 4, 1)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", sticky: true } });
    expect(guard.stop?.reason).toBe("org-attempt-limit");
  }, 60_000);

  it("un-counts only the first charge of a page per run; regions, critique and second reads stay uncharged", async () => {
    await db.exec(`insert into organizations(id, name, slug, created_by_user_id) values ('o6', 'Six', 'six', 'u1');
      insert into workspaces(id, org_id, user_id, name) values ('w6', 'o6', 'u1', 'W6');`);
    await insertRuns([["charges", "o6", "w6"]]);
    await call(guardOf("charges"), 1, 1, { charged: true });
    expect(await orgCount("o6")).toBe(0);
    // Another activity of the run claims a charge for the same page: the run already has it.
    await call(guardOf("charges"), 1, 1, { charged: true }, "region");
    await call(guardOf("charges"), 1, 1, {}, "critique");
    expect(await orgCount("o6")).toBe(2);
    // Page bounds are per page and purpose, in the shared ledger across guards of the run.
    await call(guardOf("charges"), 1, 1, { failed: true });
    await expect(call(guardOf("charges"), 1, 1)).rejects.toMatchObject({ stop: { reason: "page-attempt-limit", sticky: false, pageAttempts: 2 } });
    expect(await count(`select failures::int as n from vision_run_attempts where run_id = 'charges' and page_number = 1 and purpose = 'page'`)).toBe(1);
  }, 60_000);
});
