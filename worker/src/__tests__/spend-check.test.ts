import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveChatCreditReserveConfig, resolveCreditLeaseConfig } from "@docslurp/shared";

import { setChatReserveConfig } from "../db/chat-reserve.js";
import { setCreditLeaseConfig } from "../db/credit-lease.js";
import { enforceRunSpend, resolveSpendCheckConfig, setSpendCheckConfig, spendCounterSql } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Mid-run balance check (OP-09): the cadence counters on the run row, and
 * pausing (not failing) a run once its org may no longer spend.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

const run = { id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "u1" };

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  await sql`insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents)
    values ('org-1', 'One', 'one', 'u1', 5)`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('ws-1', 'org-1', 'u1', 'W')`;
}, 120_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  setCreditLeaseConfig(null);
  setChatReserveConfig(null);
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
  // The cadence path: WORKER_CREDIT_LEASES=off (credit-lease.test.ts covers leases).
  setCreditLeaseConfig(resolveCreditLeaseConfig({ WORKER_CREDIT_LEASES: "off" }));
  // Cadence mechanics without the chat reserve; "chat reserve" below covers it.
  setChatReserveConfig(resolveChatCreditReserveConfig({ CHAT_CREDIT_RESERVE_CREDITS: "0", CHAT_CREDIT_RESERVE_STARTER_CREDITS: "0" }));
  await sql`delete from workspace_run_events`;
  await sql`delete from page_work_tasks`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
  await sql`update organizations set credit_balance_cents = 5, budget_paused = false where id = 'org-1'`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values ('run-1', 'org-1', 'u1', 'ws-1', 'bulk-upload', 'processing', 'vision-extract', '{}')`;
});

async function addUsage(pages: number, credits: number): Promise<boolean> {
  const counter = spendCounterSql(sql, run.id, sql`${pages}::int`, credits);
  const [row] = await sql<{ due: boolean }[]>`
    update workspace_runs set ${counter.assignments}
    from ${counter.from} where workspace_runs.id = spend_prev.id
    returning ${counter.checkDue} as due`;
  return row!.due;
}

describe("spend check cadence", () => {
  it("defaults to 25 pages or 10 credits, configurable by env", () => {
    expect(resolveSpendCheckConfig({})).toEqual({ enabled: true, pages: 25, credits: 10 });
    expect(resolveSpendCheckConfig({ WORKER_SPEND_CHECK_PAGES: "5", WORKER_SPEND_CHECK_CREDITS: "2.5" }))
      .toMatchObject({ pages: 5, credits: 2.5 });
    expect(resolveSpendCheckConfig({ WORKER_SPEND_CHECK: "off" }).enabled).toBe(false);
    expect(resolveSpendCheckConfig({ NODE_ENV: "development" }).enabled).toBe(false);
  });

  it("is due on the 25th unchecked page on cheap pages", async () => {
    const due: number[] = [];
    for (let page = 1; page <= 60; page++) if (await addUsage(1, 0.008)) due.push(page);
    expect(due).toEqual([25, 50]);
  });

  it("is due once 10 credits of unchecked spend accrue on expensive pages", async () => {
    const due: number[] = [];
    for (let page = 1; page <= 30; page++) if (await addUsage(1, 0.44)) due.push(page);
    // 0.44 credits/page: 10 credits after 23 pages, before the page trigger.
    expect(due).toEqual([23]);
  });

  it("counts a checkpoint's spend without pages", async () => {
    expect(await addUsage(0, 6)).toBe(false);
    expect(await addUsage(0, 4)).toBe(true);
    expect(await addUsage(0, 0)).toBe(false);
  });
});

describe("enforceRunSpend", () => {
  it("leaves a run alone while the org has credits", async () => {
    expect(await enforceRunSpend(sql, run, "stage-boundary")).toEqual({ blocked: false, paused: false });
    const [row] = await sql<{ control_state: string | null }[]>`select control_state from workspace_runs where id = 'run-1'`;
    expect(row!.control_state).toBeNull();
  });

  it("pauses, with a reason and a run event, once available credits are below 0", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await sql`update organizations set credit_balance_cents = -0.2 where id = 'org-1'`;
    expect(await enforceRunSpend(sql, run, "page-interval")).toMatchObject({ blocked: true, paused: true, reason: "credit_exhausted" });
    const [row] = await sql<{ status: string; control_state: string; pause_reason: string }[]>`
      select status, control_state, pause_reason from workspace_runs where id = 'run-1'`;
    // Paused, not failed: the workflow stays open and resumes later.
    expect(row).toEqual({ status: "processing", control_state: "paused", pause_reason: "credit_exhausted" });
    const events = await sql<{ payload: { spendPause: { reason: string } } }[]>`
      select payload from workspace_run_events where run_id = 'run-1'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.spendPause.reason).toBe("credit_exhausted");
    // A second check does not pause again.
    expect(await enforceRunSpend(sql, run, "page-interval")).toMatchObject({ blocked: true, paused: false });
  });

  it("pauses for a budget cap and does not pause a run an operator is cancelling", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await sql`update organizations set budget_paused = true where id = 'org-1'`;
    await sql`update workspace_runs set control_state = 'cancel_requested' where id = 'run-1'`;
    expect(await enforceRunSpend(sql, run, "stage-boundary")).toMatchObject({ paused: false });
    await sql`update workspace_runs set control_state = null where id = 'run-1'`;
    expect(await enforceRunSpend(sql, run, "stage-boundary")).toMatchObject({ paused: true, reason: "org_budget_paused" });
  });

  it("is checked from page checkpoints at the configured cadence", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setSpendCheckConfig({ enabled: true, pages: 2, credits: 0 });
    await sql`update organizations set credit_balance_cents = -1 where id = 'org-1'`;
    const state = {
      run: { ...run, stats: {} },
      usageLedger: { checkpoint: () => ({ events: [], commit: () => undefined }) },
    } as unknown as WorkflowState;
    const control = async () =>
      (await sql<{ control_state: string | null }[]>`select control_state from workspace_runs where id = 'run-1'`)[0]!.control_state;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values ('doc-1', 'org-1', 'u1', 'ws-1', 'run-1', 'a.pdf', 'application/pdf', 'raw/a', 'processing')`;
    for (const pageNumber of [1, 2]) {
      const task = { runId: "run-1", documentId: "doc-1", pageNumber } as never;
      await sql`insert into page_work_tasks (run_id, document_id, page_number) values ('run-1', 'doc-1', ${pageNumber})`;
      const lease = await store.pageTasks.claim(task, "w1");
      await store.pageTasks.finish(task, lease as string, state, { ok: true });
      expect(await control()).toBe(pageNumber === 1 ? null : "paused");
    }
  });
});

describe("chat reserve", () => {
  it("pauses a run once available credits fall below the org's reserve", async () => {
    setChatReserveConfig(resolveChatCreditReserveConfig({}));
    // 5 credits in a starter org: below the 100-credit reserve.
    expect(await enforceRunSpend(sql, { id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "u1" }, "stage-boundary"))
      .toMatchObject({ blocked: true, paused: true, reason: "credit_exhausted" });
    await sql`update workspace_runs set control_state = null, pause_reason = null where id = 'run-1'`;
    await sql`update organizations set credit_balance_cents = 150 where id = 'org-1'`;
    expect(await enforceRunSpend(sql, { id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "u1" }, "stage-boundary"))
      .toEqual({ blocked: false, paused: false });
    await sql`update organizations set credit_balance_cents = 150, funded_at = now() where id = 'org-1'`;
    try {
      expect(await enforceRunSpend(sql, { id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "u1" }, "stage-boundary"))
        .toMatchObject({ blocked: true, reason: "credit_exhausted" });
    } finally {
      await sql`update organizations set funded_at = null where id = 'org-1'`;
    }
  });

  it("measures the block code against the org's reserve", async () => {
    setChatReserveConfig(resolveChatCreditReserveConfig({}));
    const { spendBlockCode } = await import("../db/spend-check.js");
    const row = { org_id: "org-1", available: 150, workspace_budget_paused: false, org_budget_paused: false, workspace_in_org: true };
    expect(spendBlockCode({ ...row, funded: false })).toBeNull();
    expect(spendBlockCode({ ...row, funded: true })).toBe("credit_exhausted");
    expect(spendBlockCode({ ...row, funded: false, available: 99 })).toBe("credit_exhausted");
  });
});

describe("house org exemption", () => {
  it("never pauses an exempt org for credits, but still for budgets", async () => {
    const { spendBlockCode } = await import("../db/spend-check.js");
    const row = { available: -4, workspace_budget_paused: false, org_budget_paused: false, workspace_in_org: true };
    process.env.BILLING_EXEMPT_ORG_IDS = "org-house";
    try {
      expect(spendBlockCode({ ...row, org_id: "org-house" })).toBeNull();
      expect(spendBlockCode({ ...row, org_id: "org-1" })).toBe("credit_exhausted");
      expect(spendBlockCode({ ...row, org_id: "org-house", org_budget_paused: true })).toBe("org_budget_paused");
    } finally {
      delete process.env.BILLING_EXEMPT_ORG_IDS;
    }
  });
});
