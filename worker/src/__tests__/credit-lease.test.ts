import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { creditLeaseTarget, resolveChatCreditReserveConfig, resolveCreditLeaseConfig, type CreditLeaseConfig } from "@docslurp/shared";

import {
  consumeRunCreditLease,
  grantRunCreditLease,
  RunCreditLeases,
  setCreditLeaseConfig,
} from "../db/credit-lease.js";
import { setChatReserveConfig } from "../db/chat-reserve.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Org-level credit leases (migration 0052, credit-lease.ts): atomic grants that
 * never exceed the org's available credits, adaptive sizing, consumption in
 * checkpoints, pausing on refusal, settlement, expiry, budgets and exemptions.
 */
type Sql = postgres.Sql<Record<string, unknown>>;

const config: CreditLeaseConfig = {
  ...resolveCreditLeaseConfig({ WORKER_CREDIT_LEASES: "on" }),
  minCredits: 0.5,
  maxCredits: 500,
  initialCredits: 10,
  fraction: 0.25,
  horizonSeconds: 30,
  ttlSeconds: 300,
  renewAt: 0.8,
};

const noReserve = resolveChatCreditReserveConfig({ CHAT_CREDIT_RESERVE_CREDITS: "0", CHAT_CREDIT_RESERVE_STARTER_CREDITS: "0" });
/** Defaults: 100 credits for starter orgs, 300 for funded orgs. */
const withReserve = resolveChatCreditReserveConfig({});

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: Sql;

async function seedOrg(client: Sql, orgId: string, credits: number) {
  await client`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents)
    values (${orgId}, ${orgId}, ${orgId}, 'u1', ${credits})`;
  await client`insert into workspaces (id, org_id, user_id, name) values (${`ws-${orgId}`}, ${orgId}, 'u1', 'W')`;
}

async function seedRuns(client: Sql, orgId: string, count: number, prefix = orgId): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}-run-${index}`);
  for (const id of ids) {
    await client`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
      values (${id}, ${orgId}, 'u1', ${`ws-${orgId}`}, 'bulk-upload', 'processing', 'vision-extract', '{}')`;
  }
  return ids;
}

const runOf = (orgId: string, id: string) => ({ id, orgId, workspaceId: `ws-${orgId}`, userId: "u1" });

/** A checkpoint: debit and lease consumption in one transaction, as Store does. */
async function spend(client: Sql, orgId: string, runId: string, credits: number) {
  return await client.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`select enqueue_org_credit_debit(${orgId}, ${credits}, 'u1', 'usage', ${runId}, ${`ws-${orgId}`}, '{}'::jsonb)`;
    return await consumeRunCreditLease(t, { id: runId, orgId }, credits);
  });
}

async function available(client: Sql, orgId: string): Promise<number> {
  const [row] = await client<{ available: number }[]>`select available from org_available_credits(${orgId})`;
  return Number(row!.available);
}

/** One statement, one snapshot: live leases never exceed available credits. */
async function leasesWithinAvailable(client: Sql, orgId: string): Promise<boolean> {
  const [row] = await client<{ ok: boolean }[]>`
    select org_outstanding_credit_leases(${orgId}) <= (select available from org_available_credits(${orgId})) + 1e-9 as ok`;
  return row!.ok;
}

async function outstanding(client: Sql, orgId: string): Promise<number> {
  const [row] = await client<{ total: number }[]>`select org_outstanding_credit_leases(${orgId}) as total`;
  return Number(row!.total);
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: Sql }).sql;
  await sql`insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com')`;
}, 120_000);

afterAll(async () => {
  setCreditLeaseConfig(null);
  setSpendCheckConfig(null);
  setChatReserveConfig(null);
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
  setCreditLeaseConfig(config);
  // Lease mechanics without the chat reserve; "chat reserve" below covers it.
  setChatReserveConfig(noReserve);
  vi.restoreAllMocks();
  await sql`delete from workspace_run_events`;
  await sql`delete from page_work_tasks`;
  await sql`delete from usage_events`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
  await sql`delete from credit_leases`;
  await sql`delete from credit_debits_pending`;
  await sql`delete from workspaces`;
  await sql`delete from organizations`;
});

describe("grant_credit_lease", () => {
  it("gives a rich org the initial lease, then sizes renewals from the burn rate up to the cap", async () => {
    await seedOrg(sql, "rich", 1_000_000);
    const [runId] = await seedRuns(sql, "rich", 1);
    const first = await grantRunCreditLease(sql, runOf("rich", runId!), config);
    expect(first).toMatchObject({ remaining: 10, leaseSize: 10, added: 10, blockReason: null });

    // 8 credits in ~1 s => burn 8/s, 30 s horizon => 240 credits.
    await spend(sql, "rich", runId!, 8);
    await sql`update credit_leases set granted_at = now() - interval '1 second' where holder_id = ${runId!}`;
    const renewed = await grantRunCreditLease(sql, runOf("rich", runId!), config);
    expect(renewed.leaseSize).toBeGreaterThan(200);
    expect(renewed.leaseSize).toBeLessThanOrEqual(240.5);
    expect(renewed.remaining).toBeCloseTo(renewed.leaseSize, 6);

    // A runaway burn rate is capped at maxCredits.
    await spend(sql, "rich", runId!, renewed.remaining * 0.9);
    await sql`update credit_leases set granted_at = now() - interval '1 second' where holder_id = ${runId!}`;
    expect((await grantRunCreditLease(sql, runOf("rich", runId!), config)).leaseSize).toBe(500);
  });

  it("is idempotent while the lease is topped up: concurrent renewals do not stack", async () => {
    await seedOrg(sql, "o", 1_000);
    const [runId] = await seedRuns(sql, "o", 1);
    await grantRunCreditLease(sql, runOf("o", runId!), config);
    const again = await grantRunCreditLease(sql, runOf("o", runId!), config);
    expect(again.added).toBe(0);
    expect(again.remaining).toBe(10);
    expect(await outstanding(sql, "o")).toBe(10);
  });

  it("never lets the org's live leases exceed available credits (random interleavings)", async () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (const credits of [50, 0.5, 7]) {
      const orgId = `prop-${String(credits).replace(".", "_")}`;
      await seedOrg(sql, orgId, credits);
      const runs = await seedRuns(sql, orgId, 20);
      let totalSpent = 0;
      for (let step = 0; step < 300; step++) {
        const runId = runs[Math.floor(random() * runs.length)]!;
        if (random() < 0.5) {
          await grantRunCreditLease(sql, runOf(orgId, runId), config);
        } else {
          // Spend only what the lease covers, like a hot path that checks first.
          const [lease] = await sql<{ remaining: number }[]>`
            select greatest(granted - consumed, 0) as remaining from credit_leases
            where holder_id = ${runId} and status = 'active' and expires_at > now()`;
          const amount = Math.min(Number(lease?.remaining ?? 0), random() * 2);
          if (amount > 0) {
            await spend(sql, orgId, runId, amount);
            totalSpent += amount;
          }
        }
        expect(await leasesWithinAvailable(sql, orgId)).toBe(true);
      }
      // Spending within leases can never overdraw the org.
      expect(totalSpent).toBeLessThanOrEqual(credits + 1e-9);
      expect(await available(sql, orgId)).toBeGreaterThanOrEqual(-1e-9);
    }
  }, 120_000);

  it("shrinks leases toward one batch near exhaustion, then hands out the rest", async () => {
    await seedOrg(sql, "poor", 50);
    const runs = await seedRuns(sql, "poor", 20);
    const sizes: number[] = [];
    for (const runId of runs) sizes.push((await grantRunCreditLease(sql, runOf("poor", runId), config)).leaseSize);
    // 25% of 50 = 12.5 is above the 10-credit initial lease; later runs get less.
    expect(sizes[0]).toBe(10);
    expect(sizes.at(-1)!).toBeLessThan(sizes[0]!);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(0);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(50 + 1e-9);
    // With 0.3 credits free the next lease is all of it (below minCredits).
    await sql`update credit_leases set status = 'released'`;
    await sql`update organizations set credit_balance_cents = 0.3 where id = 'poor'`;
    const tail = await grantRunCreditLease(sql, runOf("poor", runs[0]!), config);
    expect(tail.remaining).toBeCloseTo(0.3, 9);
    expect(tail.blockReason).toBeNull();
    const none = await grantRunCreditLease(sql, runOf("poor", runs[1]!), config);
    expect(none).toMatchObject({ remaining: 0, blockReason: "credit_exhausted" });
  });

  it("matches the TypeScript sizing mirror used by the simulation", () => {
    const cfg = config;
    expect(creditLeaseTarget({ free: 1_000_000, burnPerSecond: null, config: cfg })).toBe(10);
    expect(creditLeaseTarget({ free: 1_000_000, burnPerSecond: 8, config: cfg })).toBe(240);
    expect(creditLeaseTarget({ free: 1_000_000, burnPerSecond: 100, config: cfg })).toBe(500);
    expect(creditLeaseTarget({ free: 4, burnPerSecond: 8, config: cfg })).toBe(1);
    expect(creditLeaseTarget({ free: 0.3, burnPerSecond: 8, config: cfg })).toBeCloseTo(0.3);
    expect(creditLeaseTarget({ free: -2, burnPerSecond: 8, config: cfg })).toBe(0);
  });

  it("enforces tenant scope: a run of another org cannot take this org's credits", async () => {
    await seedOrg(sql, "a", 100);
    await seedOrg(sql, "b", 100);
    const [runA] = await seedRuns(sql, "a", 1);
    await expect(grantRunCreditLease(sql, { id: runA!, orgId: "b", workspaceId: "ws-b" }, config))
      .rejects.toThrow(/not in org/);
    await expect(grantRunCreditLease(sql, { id: runA!, orgId: "a", workspaceId: "ws-b" }, config))
      .rejects.toThrow(/not in org/);
    await grantRunCreditLease(sql, runOf("a", runA!), config);
    // Consuming with the wrong org touches nothing.
    expect(await consumeRunCreditLease(sql, { id: runA!, orgId: "b" }, 5)).toBeNull();
    expect(await outstanding(sql, "a")).toBe(10);
    expect(await outstanding(sql, "b")).toBe(0);
    await expect(sql`select * from grant_credit_lease('a', null, 'app', ${runA!}, 1, 1, 1, 0.5, 30, 60, false)`)
      .rejects.toThrow(/unsupported holder kind/);
  });

  it("is counted in org_spend_status().reserved, so app admission sees leased credits", async () => {
    await seedOrg(sql, "o", 40);
    const [runId] = await seedRuns(sql, "o", 1);
    await grantRunCreditLease(sql, runOf("o", runId!), config);
    const [status] = await sql<{ available: number; reserved: number }[]>`select available, reserved from org_spend_status('o', 'ws-o', 0)`;
    expect(Number(status!.available)).toBe(40);
    expect(Number(status!.reserved)).toBe(10);
  });
});

describe("chat reserve", () => {
  it("never grants into the reserve: live leases stay within available - reserve", async () => {
    setChatReserveConfig(withReserve);
    await seedOrg(sql, "small", 130);
    const runs = await seedRuns(sql, "small", 20);
    for (let round = 0; round < 3; round++) {
      for (const runId of runs) await grantRunCreditLease(sql, runOf("small", runId), config);
    }
    expect(await outstanding(sql, "small")).toBeLessThanOrEqual(30 + 1e-9);
    expect(await outstanding(sql, "small")).toBeGreaterThan(29);
    // Spending every lease leaves the starter reserve for chat.
    for (const runId of runs) {
      const [lease] = await sql<{ remaining: number }[]>`select greatest(granted - consumed, 0) as remaining from credit_leases where holder_id = ${runId}`;
      if (Number(lease?.remaining ?? 0) > 0) await spend(sql, "small", runId, Number(lease!.remaining));
    }
    expect(await available(sql, "small")).toBeCloseTo(100, 6);
    const refused = await grantRunCreditLease(sql, runOf("small", runs[0]!), config);
    expect(refused).toMatchObject({ remaining: 0, blockReason: "credit_exhausted" });
    // available_credits reports what jobs may still use.
    expect(refused.available).toBeCloseTo(0, 6);
  });

  it("uses the funded reserve for funded orgs and none for billing-exempt orgs", async () => {
    setChatReserveConfig(withReserve);
    await seedOrg(sql, "gold", 310);
    await sql`update organizations set funded_at = now() where id = 'gold'`;
    const [goldRun] = await seedRuns(sql, "gold", 1);
    expect((await grantRunCreditLease(sql, runOf("gold", goldRun!), { ...config, fraction: 1, initialCredits: 50 })).remaining).toBeCloseTo(10, 6);

    process.env.BILLING_EXEMPT_ORG_IDS = "house";
    try {
      await seedOrg(sql, "house", 0);
      const [houseRun] = await seedRuns(sql, "house", 1);
      expect((await grantRunCreditLease(sql, runOf("house", houseRun!), config)).remaining).toBe(500);
    } finally {
      delete process.env.BILLING_EXEMPT_ORG_IDS;
    }
  });

  it("keeps the 0052 call working (no reserve arguments)", async () => {
    await seedOrg(sql, "old", 20);
    const [runId] = await seedRuns(sql, "old", 1);
    const [row] = await sql<{ lease_remaining: number }[]>`
      select lease_remaining from grant_credit_lease('old', 'ws-old', 'run', ${runId!}, 0.5, 500, 10, 1, 30, 300, false)`;
    expect(Number(row!.lease_remaining)).toBe(10);
  });
});

describe("settlement, expiry, budgets and exemptions", () => {
  it("releases the unused remainder when the run finishes, pauses or is cancelled", async () => {
    await seedOrg(sql, "o", 100);
    const [done, paused, cancelled] = await seedRuns(sql, "o", 3);
    for (const runId of [done!, paused!, cancelled!]) await grantRunCreditLease(sql, runOf("o", runId), config);
    await spend(sql, "o", done!, 4);
    expect(await outstanding(sql, "o")).toBe(26);
    await sql`update workspace_runs set status = 'completed' where id = ${done!}`;
    await sql`update workspace_runs set control_state = 'paused' where id = ${paused!}`;
    await sql`update workspace_runs set control_state = 'cancel_requested' where id = ${cancelled!}`;
    expect(await outstanding(sql, "o")).toBe(0);
    const rows = await sql<{ status: string }[]>`select status from credit_leases order by holder_id`;
    expect(rows.map((row) => row.status)).toEqual(["released", "released", "released"]);
    // Re-granting after a resume starts a fresh lease from what was consumed.
    await sql`update workspace_runs set control_state = null where id = ${paused!}`;
    expect((await grantRunCreditLease(sql, runOf("o", paused!), config)).remaining).toBe(10);
    // An inactive run gets nothing.
    expect((await grantRunCreditLease(sql, runOf("o", done!), config)).blockReason).toBe("run_inactive");
  });

  it("returns a crashed worker's lease to the pool after its TTL", async () => {
    await seedOrg(sql, "o", 12);
    const [crashed, other] = await seedRuns(sql, "o", 2);
    // 25% of 12 free.
    expect((await grantRunCreditLease(sql, runOf("o", crashed!), config)).remaining).toBe(3);
    // 25% of the 9 left while the crashed run holds 3.
    expect((await grantRunCreditLease(sql, runOf("o", other!), config)).remaining).toBe(2.25);
    await sql`update credit_leases set expires_at = now() - interval '1 second' where holder_id = ${crashed!}`;
    expect(await outstanding(sql, "o")).toBe(2.25);
    // The other run spends its lease; its renewal may now draw on the expired 3.
    await spend(sql, "o", other!, 2.25);
    await sql`update credit_leases set granted_at = now() - interval '1 second' where holder_id = ${other!}`;
    const renewed = await grantRunCreditLease(sql, runOf("o", other!), config);
    // 9.75 free, 25% = 2.44 < burn 2.25/s * 30 s: the expired credits count as free.
    expect(renewed.remaining).toBeCloseTo(9.75 * 0.25, 9);
    // A late checkpoint of the crashed run does not revive its expired lease...
    const late = await consumeRunCreditLease(sql, { id: crashed!, orgId: "o" }, 0);
    expect(late).toMatchObject({ live: false });
    // ...it must be re-granted from what is free now.
    const regrant = await grantRunCreditLease(sql, runOf("o", crashed!), config);
    expect(regrant.remaining + renewed.remaining).toBeLessThanOrEqual(9.75 + 1e-9);
    expect(await leasesWithinAvailable(sql, "o")).toBe(true);
  });

  it("refuses and revokes leases when the workspace or org budget is paused", async () => {
    await seedOrg(sql, "o", 100);
    const [runId] = await seedRuns(sql, "o", 1);
    await grantRunCreditLease(sql, runOf("o", runId!), config);
    await sql`update workspaces set budget_paused = true where id = 'ws-o'`;
    // The trigger revokes the scope's live leases at once.
    expect(await outstanding(sql, "o")).toBe(0);
    expect(await consumeRunCreditLease(sql, { id: runId!, orgId: "o" }, 0)).toMatchObject({ live: false });
    expect(await grantRunCreditLease(sql, runOf("o", runId!), config)).toMatchObject({ remaining: 0, blockReason: "workspace_budget_paused" });
    await sql`update workspaces set budget_paused = false where id = 'ws-o'`;
    await sql`update organizations set budget_paused = true where id = 'o'`;
    expect(await grantRunCreditLease(sql, runOf("o", runId!), config)).toMatchObject({ remaining: 0, blockReason: "org_budget_paused" });
    await sql`update organizations set budget_paused = false where id = 'o'`;
    expect((await grantRunCreditLease(sql, runOf("o", runId!), config)).remaining).toBe(10);
  });

  it("gives billing-exempt orgs the maximum lease without counting it, but still applies budgets", async () => {
    process.env.BILLING_EXEMPT_ORG_IDS = "house";
    try {
      await seedOrg(sql, "house", 0);
      const [runId] = await seedRuns(sql, "house", 1);
      const grant = await grantRunCreditLease(sql, runOf("house", runId!), config);
      expect(grant).toMatchObject({ remaining: 500, blockReason: null });
      expect(await outstanding(sql, "house")).toBe(0);
      await sql`update organizations set budget_paused = true where id = 'house'`;
      expect((await grantRunCreditLease(sql, runOf("house", runId!), config)).blockReason).toBe("org_budget_paused");
    } finally {
      delete process.env.BILLING_EXEMPT_ORG_IDS;
    }
  });
});

describe("worker checkpoints", () => {
  async function seedPage(runId: string, orgId: string, pageNumber: number) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values (${`doc-${runId}`}, ${orgId}, 'u1', ${`ws-${orgId}`}, ${runId}, 'a.pdf', 'application/pdf', 'raw/a', 'processing')
      on conflict do nothing`;
    await sql`insert into page_work_tasks (run_id, document_id, page_number) values (${runId}, ${`doc-${runId}`}, ${pageNumber})`;
    return { runId, documentId: `doc-${runId}`, pageNumber } as never;
  }

  function pageState(orgId: string, runId: string, credits: number): WorkflowState {
    const ledger = new PipelineUsageEventLedger();
    ledger.enqueue({ provider: "local", model: "cpu", metric: "worker-page", amount: 1, unit: "page", costCents: credits });
    return { run: { ...runOf(orgId, runId), stats: {} }, usageLedger: ledger } as unknown as WorkflowState;
  }

  async function finishPage(leases: RunCreditLeases, orgId: string, runId: string, pageNumber: number, credits: number) {
    const task = await seedPage(runId, orgId, pageNumber);
    const pages = new (store.pageTasks.constructor as new (sql: Sql, leases: RunCreditLeases) => typeof store.pageTasks)(sql, leases);
    const lease = await pages.claim(task, "w1");
    await pages.finish(task, lease as string, pageState(orgId, runId, credits), { ok: true });
  }

  const control = async (runId: string) =>
    (await sql<{ control_state: string | null; pause_reason: string | null }[]>`
      select control_state, pause_reason from workspace_runs where id = ${runId}`)[0]!;

  it("consumes the lease in page checkpoints, renews in the background at 80%, and skips the cadence counters", async () => {
    await seedOrg(sql, "o", 1_000);
    const [runId] = await seedRuns(sql, "o", 1);
    const leases = new RunCreditLeases(sql);
    // Admission grants the first lease (app side); here the run starts with one.
    await grantRunCreditLease(sql, runOf("o", runId!), config);
    await finishPage(leases, "o", runId!, 1, 1);
    expect(leases.grants).toBe(0);
    let [lease] = await sql<{ granted: number; consumed: number }[]>`select granted, consumed from credit_leases where holder_id = ${runId!}`;
    expect(Number(lease!.consumed)).toBe(1);
    for (let page = 2; page <= 7; page++) await finishPage(leases, "o", runId!, page, 1);
    expect(leases.grants).toBe(0);
    // The 8th credit of the 10-credit lease crosses 80%: a background renewal.
    await finishPage(leases, "o", runId!, 8, 1);
    await vi.waitFor(() => expect(leases.grants).toBe(1));
    [lease] = await sql<{ granted: number; consumed: number }[]>`select granted, consumed from credit_leases where holder_id = ${runId!}`;
    expect(Number(lease!.granted) - Number(lease!.consumed)).toBeGreaterThan(2);
    const [run] = await sql<{ pages: number; credits: number; cost: number }[]>`
      select spend_unchecked_pages as pages, spend_unchecked_credits as credits, spent_cents as cost from workspace_runs where id = ${runId!}`;
    expect(run).toMatchObject({ pages: 0 });
    expect(Number(run!.credits)).toBe(0);
    expect(Number(run!.cost)).toBe(8);
    // The lease and the run cap take the same per-checkpoint delta.
    [lease] = await sql<{ granted: number; consumed: number }[]>`select granted, consumed from credit_leases where holder_id = ${runId!}`;
    expect(Number(lease!.consumed)).toBe(Number(run!.cost));
    expect(leases.localRemaining(runId!)).toBeGreaterThan(0);
  });

  it("pauses the run when the lease is exhausted and nothing more can be granted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await seedOrg(sql, "o", 3);
    const [runId] = await seedRuns(sql, "o", 1);
    const leases = new RunCreditLeases(sql);
    await finishPage(leases, "o", runId!, 1, 1);
    expect(await control(runId!)).toEqual({ control_state: null, pause_reason: null });
    await finishPage(leases, "o", runId!, 2, 1.5);
    await finishPage(leases, "o", runId!, 3, 0.5);
    await vi.waitFor(async () => expect((await control(runId!)).control_state).toBe("paused"));
    expect((await control(runId!)).pause_reason).toBe("credit_exhausted");
    const events = await sql<{ payload: { spendPause: { reason: string } } }[]>`
      select payload from workspace_run_events where run_id = ${runId!}`;
    expect(events.map((event) => event.payload.spendPause.reason)).toEqual(["credit_exhausted"]);
    // Paused: the lease is settled.
    expect(await outstanding(sql, "o")).toBe(0);
    expect(leases.wouldExhaust(runId!, 1)).toBe(false);
  });

  it("falls back to the cadence rule when a grant fails, so an exhausted run is still gated", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await seedOrg(sql, "o", -1);
    const [runId] = await seedRuns(sql, "o", 1);
    const leases = new RunCreditLeases(sql);
    // A scope the grant refuses (raises): the fallback reads org_spend_status and pauses.
    const result = await leases.afterConsume({ ...runOf("o", runId!), workspaceId: "ws-other" }, null, "checkpoint-interval");
    expect(result).toMatchObject({ paused: true, reason: "plan_not_entitled" });
    expect(leases.grants).toBe(1);
  });

  it("asks hot paths to checkpoint early once unflushed usage would use up the lease", async () => {
    await seedOrg(sql, "o", 1_000);
    const [runId] = await seedRuns(sql, "o", 1);
    const leases = new RunCreditLeases(sql);
    expect(leases.wouldExhaust(runId!, 100)).toBe(false); // unknown lease: wait for the first checkpoint
    await finishPage(leases, "o", runId!, 1, 1);
    const remaining = leases.localRemaining(runId!)!;
    expect(leases.wouldExhaust(runId!, remaining - 0.01)).toBe(false);
    expect(leases.wouldExhaust(runId!, remaining)).toBe(true);
  });

  it("keeps the cadence path when WORKER_CREDIT_LEASES is off", async () => {
    setCreditLeaseConfig({ ...config, enabled: false });
    await seedOrg(sql, "o", 1_000);
    const [runId] = await seedRuns(sql, "o", 1);
    const leases = new RunCreditLeases(sql);
    await finishPage(leases, "o", runId!, 1, 2);
    expect(leases.grants).toBe(0);
    expect(await sql`select 1 from credit_leases`).toHaveLength(0);
    const [run] = await sql<{ pages: number; credits: number }[]>`
      select spend_unchecked_pages as pages, spend_unchecked_credits as credits from workspace_runs where id = ${runId!}`;
    expect(run!.pages).toBe(1);
    expect(Number(run!.credits)).toBe(2);
  });
});

/**
 * True concurrency against a real Postgres (PGlite serves one connection at a
 * time). Opt-in: CREDIT_LEASE_TEST_DATABASE_URL=postgres://… (a throwaway,
 * migrated database; rows are seeded and wiped).
 */
const realUrl = process.env.CREDIT_LEASE_TEST_DATABASE_URL;
describe.skipIf(!realUrl)("credit leases under real concurrency", () => {
  let pg: Sql;

  beforeAll(async () => {
    pg = postgres(realUrl!, { max: 24, prepare: false, onnotice: () => undefined }) as unknown as Sql;
    await pg`insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com') on conflict do nothing`;
  });

  afterAll(async () => {
    await pg?.end();
  });

  beforeEach(async () => {
    await pg`delete from credit_leases`;
    await pg`delete from credit_debits_pending where org_id like 'cc-%'`;
    await pg`delete from workspace_runs where org_id like 'cc-%'`;
    await pg`delete from workspaces where org_id like 'cc-%'`;
    await pg`delete from organizations where id like 'cc-%'`;
  });

  it("many concurrent grants and spends in one org never exceed available", async () => {
    for (const credits of [50, 0.5]) {
      const orgId = `cc-${String(credits).replace(".", "_")}`;
      await seedOrg(pg, orgId, credits);
      const runs = await seedRuns(pg, orgId, 20);
      let spent = 0;
      const worker = async (runId: string) => {
        for (let round = 0; round < 15; round++) {
          const grant = await grantRunCreditLease(pg, runOf(orgId, runId), config);
          if (grant.remaining <= 0) return;
          // Two workers share each run's lease: claim under the lease row lock
          // so they never both spend the same remainder.
          const amount = await pg.begin(async (tx) => {
            const t = tx as unknown as Sql;
            const [lease] = await t<{ remaining: number }[]>`
              select greatest(granted - consumed, 0) as remaining from credit_leases
              where holder_kind = 'run' and holder_id = ${runId} and status = 'active' and expires_at > now()
              for update`;
            const take = Math.min(Number(lease?.remaining ?? 0), 0.05 + Math.random() * 3);
            if (take <= 0) return 0;
            await t`select enqueue_org_credit_debit(${orgId}, ${take}, 'u1', 'usage', ${runId}, ${`ws-${orgId}`}, '{}'::jsonb)`;
            await consumeRunCreditLease(t, { id: runId, orgId }, take);
            return take;
          });
          spent += amount;
          expect(await leasesWithinAvailable(pg, orgId)).toBe(true);
        }
      };
      // Each run twice: two workers sharing one run's lease.
      await Promise.all([...runs, ...runs].map((runId) => worker(runId)));
      expect(spent).toBeLessThanOrEqual(credits + 1e-9);
      expect(await available(pg, orgId)).toBeGreaterThanOrEqual(-1e-9);
    }
  }, 120_000);

  it("concurrent grants never reach into the chat reserve", async () => {
    setChatReserveConfig(withReserve);
    await seedOrg(pg, "cc-reserve", 150);
    const runs = await seedRuns(pg, "cc-reserve", 20);
    let spent = 0;
    const worker = async (runId: string) => {
      for (let round = 0; round < 15; round++) {
        const grant = await grantRunCreditLease(pg, runOf("cc-reserve", runId), config);
        if (grant.remaining <= 0) return;
        const amount = await pg.begin(async (tx) => {
          const t = tx as unknown as Sql;
          const [lease] = await t<{ remaining: number }[]>`
            select greatest(granted - consumed, 0) as remaining from credit_leases
            where holder_kind = 'run' and holder_id = ${runId} and status = 'active' and expires_at > now()
            for update`;
          const take = Math.min(Number(lease?.remaining ?? 0), 0.05 + Math.random() * 3);
          if (take <= 0) return 0;
          await t`select enqueue_org_credit_debit('cc-reserve', ${take}, 'u1', 'usage', ${runId}, 'ws-cc-reserve', '{}'::jsonb)`;
          await consumeRunCreditLease(t, { id: runId, orgId: "cc-reserve" }, take);
          return take;
        });
        spent += amount;
      }
    };
    await Promise.all([...runs, ...runs].map((runId) => worker(runId)));
    // Jobs spent at most the 50 credits above the Free reserve.
    expect(spent).toBeLessThanOrEqual(50 + 1e-9);
    expect(await available(pg, "cc-reserve")).toBeGreaterThanOrEqual(100 - 1e-9);
  }, 120_000);

  it("concurrent interactive admissions near zero stop at the overdraft allowance", async () => {
    await pg`delete from interactive_spend_holds where org_id = 'cc-chat'`;
    await seedOrg(pg, "cc-chat", -50);
    const results = await Promise.all(Array.from({ length: 40 }, async () => {
      const [row] = await pg<{ admitted: boolean }[]>`select admitted from admit_interactive_spend('cc-chat', 'ws-cc-chat', 100, 5, 120)`;
      return row!.admitted;
    }));
    // available - holds must stay above -100: ten 5-credit holds fit, however the calls interleave.
    expect(results.filter(Boolean)).toHaveLength(10);
    await pg`delete from interactive_spend_holds where org_id = 'cc-chat'`;
  }, 60_000);

  it("notifies org_spend_changed on top-ups and on released leases", async () => {
    await seedOrg(pg, "cc-n", 5);
    const [runId] = await seedRuns(pg, "cc-n", 1);
    const payloads: string[] = [];
    const listener = await pg.listen("org_spend_changed", (payload) => payloads.push(payload));
    try {
      await grantRunCreditLease(pg, runOf("cc-n", runId!), config);
      await pg`update workspace_runs set control_state = 'paused' where id = ${runId!}`;
      await pg`select grant_org_credits('cc-n', 'topup', 'cc-n-topup', 10)`;
      await vi.waitFor(() => expect(payloads.length).toBeGreaterThanOrEqual(2));
      const reasons = payloads.map((payload) => JSON.parse(payload) as { orgId: string; reason: string });
      expect(reasons).toEqual(expect.arrayContaining([
        { orgId: "cc-n", reason: "lease_released" },
        { orgId: "cc-n", reason: "org" },
      ]));
    } finally {
      await listener.unlisten();
    }
  });
});
