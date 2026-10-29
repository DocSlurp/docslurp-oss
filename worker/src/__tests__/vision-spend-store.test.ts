import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { PostgresVisionSpendBackend } from "../db/vision-spend-store.js";
import { visionReserveCents } from "../lib/vision-reserve.js";
import { VisionRunGuard, type VisionGuardConfig } from "../lib/vision-spend-guard.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import type { Config } from "../config.js";

/** The Postgres vision spend ledger (migration 0101) behind the vision guard. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
const config: VisionGuardConfig = {
  budgetCents: 100, breakerMinRejectedPages: 10, breakerRejectedRate: 0.2, orgUnbilledLimitCents: 1_000, orgWindowHours: 24,
};
const page = (pageNumber: number, rejected = false) => ({ documentId: "d1", pageNumber, rejected });

async function insertRuns(rows: Array<[runId: string, orgId: string, workspaceId: string]>): Promise<void> {
  const values = rows.map(([id, org, ws]) => `('${id}', '${org}', 'u1', '${ws}', 'upload', 'processing', 'vision-extract', '{}', '{}')`);
  await db.exec(`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts) values ${values.join(", ")};`);
}

const sum = async (query: string) => Number((await db.query<{ n: number }>(query)).rows[0]?.n ?? 0);

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'One', 'one', 'u1'), ('o2', 'Two', 'two', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'W2');
  `);
  await insertRuns([["r1", "o1", "w1"], ["r2", "o2", "w2"], ["r3", "o1", "w1"]]);
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

describe("PostgresVisionSpendBackend", () => {
  it("admits simultaneous calls of different models only while their own reservations fit the run budget", async () => {
    const flash = { target: "remote", modelUri: "llm://openrouter/google/gemini-3.1-flash-lite", maxPagesPerDocument: 1 } as never;
    const lite = { target: "remote", modelUri: "llm://openrouter/google/gemini-2.5-flash-lite", maxPagesPerDocument: 1 } as never;
    const size = { widthPx: 1275, heightPx: 1650 };
    const reserves = [flash, lite, flash, lite, flash, lite, flash, lite].map((vision) => visionReserveCents(vision, CFG, size));
    expect(new Set(reserves).size).toBe(2);
    const budget = reserves[0]! * 2 + reserves[1]! * 2;
    // Activities of the run (one guard each) admit at the same time against the shared ledger.
    // PGlite serves one connection, so this proves the rule and the per-call amounts; across
    // processes the run and org advisory locks serialize the same transactions.
    {
      const guards = reserves.map(() =>
        new VisionRunGuard({ id: "r1", orgId: "o1" }, { ...config, budgetCents: budget }, store.visionSpend));
      const admissions = await Promise.all(guards.map((guard, index) => guard.admit(reserves[index]!)));
      const admitted = admissions.flatMap((admission, index) => (admission.admitted ? [reserves[index]!] : []));
      // Never more reserved than the budget, and a refused call would not have fit.
      const reserved = admitted.reduce((total, cents) => total + cents, 0);
      expect(reserved).toBeLessThanOrEqual(budget + 1e-9);
      expect(admitted.length).toBeGreaterThanOrEqual(3);
      expect(await sum(`select coalesce(sum(cents), 0)::float as n from vision_spend_reservations where run_id = 'r1'`)).toBeCloseTo(reserved, 6);
      for (const [index, admission] of admissions.entries()) {
        if (!admission.admitted) {
          expect(admission.stop).toMatchObject({ reason: "provider-budget" });
          expect(admission.stop.reservedCents).toBeGreaterThan(budget - reserves[index]! - 1e-6);
        }
      }
      // Settling moves each call to its actual cost and frees its reservation.
      await Promise.all(admissions.map((admission, index) => admission.admitted && admission.settle({ costCents: 0.5, billable: true, page: page(index + 1) })));
      expect(await sum(`select count(*)::int as n from vision_spend_reservations where run_id = 'r1'`)).toBe(0);
      expect(await sum(`select provider_cost_cents::float as n from vision_run_spend where run_id = 'r1'`)).toBeCloseTo(0.5 * admitted.length, 6);
      expect(await sum(`select count(*)::int as n from vision_run_pages where run_id = 'r1'`)).toBe(admitted.length);
    }
  }, 60_000);

  it("stops many small runs of one org at the org's unbilled limit and leaves the other org alone", async () => {
    const runs = Array.from({ length: 8 }, (_, index) => `small-${index}`);
    await insertRuns(runs.map((id) => [id, "o1", "w1"]));
    const stops: string[] = [];
    for (const runId of runs) {
      // Each run: 4 rejected pages of 60 cents, under its own budget and breaker.
      const guard = new VisionRunGuard({ id: runId, orgId: "o1" }, { ...config, budgetCents: 2_500 }, store.visionSpend);
      for (let n = 1; n <= 4; n += 1) {
        const admission = await guard.admit(60);
        if (!admission.admitted) {
          stops.push(`${runId}:${admission.stop.reason}`);
          break;
        }
        await admission.settle({ costCents: 60, billable: false, page: page(n, true) });
      }
    }
    // 4 runs x 240 cents = 960; the fifth run's first call would pass 1,000.
    expect(stops[0]).toBe("small-4:org-unbilled-limit");
    expect(stops).toHaveLength(4);
    expect(await sum(`select coalesce(sum(cents), 0)::float as n from vision_org_unbilled_spend where org_id = 'o1'`)).toBeCloseTo(960, 6);
    // Another org's run is unaffected; a caller cannot move a run to another org's scope.
    const otherOrg = new VisionRunGuard({ id: "r2", orgId: "o1" }, { ...config, budgetCents: 2_500 }, store.visionSpend);
    const admitted = await otherOrg.admit(60);
    expect(admitted.admitted).toBe(true);
    if (admitted.admitted) await admitted.settle({ costCents: 60, billable: false, page: page(1, true) });
    expect(await sum(`select coalesce(sum(cents), 0)::float as n from vision_org_unbilled_spend where org_id = 'o2'`)).toBeCloseTo(60, 6);
    // Billable reads of the stopped org are not unbilled spend, but the org stays stopped for unbilled risk.
    expect((await new VisionRunGuard({ id: "r3", orgId: "o1" }, { ...config, budgetCents: 2_500 }, store.visionSpend).admit(60)).admitted).toBe(false);
  }, 60_000);

  it("counts a reservation that was never settled in full once it expires", async () => {
    await insertRuns([["crashed", "o2", "w2"]]);
    const shortLived = new PostgresVisionSpendBackend((store as unknown as { sql: never }).sql, 1);
    const admission = await shortLived.admit({ runId: "crashed", orgId: "o2", reserveCents: 40, config });
    expect(admission.admitted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The next admission folds it: 40 settled (unbilled) + 70 > 100.
    expect(await shortLived.admit({ runId: "crashed", orgId: "o2", reserveCents: 70, config }))
      .toMatchObject({ admitted: false, stop: { reason: "provider-budget", providerCostCents: 40 } });
    warn.mockRestore();
    // A late settle of the folded reservation changes nothing.
    if (admission.admitted) await shortLived.settle(admission.reservationId, { costCents: 1, billable: true });
    expect(await sum(`select provider_cost_cents::float as n from vision_run_spend where run_id = 'crashed'`)).toBe(40);
  }, 60_000);

  it("refuses to admit for a run that does not exist", async () => {
    await expect(store.visionSpend.admit({ runId: "missing", orgId: "o1", reserveCents: 1, config })).rejects.toThrow(/not found/);
  });
});
