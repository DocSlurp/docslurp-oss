import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { applyRemainingMigrations, createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * One attribution rule for app and worker (architect gaps A6, A7): the
 * usage_attribution view (migration 0042). Seeds the fixtures of
 * server/src/__tests__/usage-attribution.db.test.ts in the pre-0041 shape
 * (scope only in run_id and metadata), applies the tenant-column backfill and
 * the view, and checks that the view and the worker's budget alerts both give
 * the totals the app's attribution has always given.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: "usage_event_tenant_columns" });
  await db.exec(`
    insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com');
    insert into notification_prefs (user_id, cost_alert) values ('u1', false);
    insert into organizations (id, name, slug, created_by_user_id) values
      ('org-1', 'One', 'one', 'u1'), ('org-2', 'Two', 'two', 'u1');
    insert into workspaces (id, org_id, user_id, name) values
      ('ws-a', 'org-1', 'u1', 'A'), ('ws-b', 'org-1', 'u1', 'B'), ('ws-c', 'org-2', 'u1', 'C');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values
      ('run-a', 'org-1', 'u1', 'ws-a', 'bulk-upload', 'completed', 'completed', '{}');
    -- legacy double-encoded session metadata
    insert into search_sessions (id, user_id, query, metadata) values
      ('sess-b', 'u1', 'q', to_jsonb('{"workspaceId":"ws-b"}'::text));
    insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, input_tokens, output_tokens, cost_cents, metadata) values
      ('ingest', 'u1', 'run-a', 'openrouter', 'm', 'llm', 0, 'token', 100, 0, 10, '{}'),
      ('search-ws', 'u1', null, 'openrouter', 'm', 'llm', 0, 'token', 40, 10, 4, '{"workspaceId":"ws-a"}'),
      ('search-session', 'u1', null, 'openrouter', 'm', 'llm', 0, 'token', 20, 0, 2, '{"sessionId":"sess-b"}'),
      ('aggregate', 'u1', null, 'openrouter', 'm', 'llm', 0, 'token', 60, 0, 6, '{"workspaceIds":["ws-a","ws-b","ws-c"]}'),
      ('org-only', 'u1', null, 'openrouter', 'm', 'llm', 0, 'token', 5, 0, 1, '{"orgId":"org-2"}');
    insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata, created_at) values
      ('last-year', 'u1', 'run-a', 'openrouter', 'm', 'llm', 0, 'token', 1000, '{}', now() - interval '400 days');
  `);
  await applyRemainingMigrations(db, "usage_event_tenant_columns");
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

async function totals(column: "workspace_id" | "org_id", id: string, window: "month" | "all" = "month") {
  const [row] = await sql<{ cost: number; tokens: number; events: number }[]>`
    select
      coalesce(sum(cost_cents), 0)::double precision as cost,
      coalesce(sum(input_tokens + output_tokens), 0)::double precision as tokens,
      count(distinct id)::int as events
    from usage_attribution
    where ${sql(column)} = ${id}
      and (${window} = 'all' or created_at >= date_trunc('month', now()))
  `;
  return { cost: Number(row!.cost), tokens: Number(row!.tokens), events: Number(row!.events) };
}

describe("usage_attribution view parity with the app fixtures", () => {
  it("counts run-linked, search, session, and split aggregate spend per workspace", async () => {
    expect((await totals("workspace_id", "ws-a")).cost).toBeCloseTo(16);
    expect((await totals("workspace_id", "ws-b")).cost).toBeCloseTo(4);
    expect((await totals("workspace_id", "ws-c")).cost).toBeCloseTo(2);
  });

  it("rolls run-less spend into org totals without double counting split events", async () => {
    const org1 = await totals("org_id", "org-1");
    expect(org1.cost).toBeCloseTo(20);
    expect(org1.events).toBe(4);
    const org2 = await totals("org_id", "org-2");
    expect(org2.cost).toBeCloseTo(3);
    expect(org2.tokens).toBeCloseTo(25);
  });

  it("respects the window", async () => {
    expect((await totals("org_id", "org-1", "all")).cost).toBeCloseTo(1020);
  });

  it("sums to the raw usage_events total", async () => {
    const [view] = await sql<{ cost: number }[]>`select sum(cost_cents)::double precision as cost from usage_attribution`;
    const [raw] = await sql<{ cost: number }[]>`select sum(cost_cents)::double precision as cost from usage_events`;
    expect(Number(view!.cost)).toBeCloseTo(Number(raw!.cost));
  });
});

describe("worker budget alerts use the same rule", () => {
  it("pauses and warns from attributed spend, including org spend with no stamped orgId", async () => {
    await sql`update workspaces set monthly_budget_cents = 16 where id = 'ws-a'`;
    await sql`update workspaces set monthly_budget_cents = 5 where id = 'ws-b'`;
    await sql`update organizations set monthly_budget_cents = 25 where id = 'org-1'`;
    // Old worker rule: only metadata.orgId = 'org-2' (1 credit) counted here.
    await sql`update organizations set monthly_budget_cents = 3 where id = 'org-2'`;

    await store.processBudgetAlerts();

    const workspaces = await sql<{ id: string; level: number; paused: boolean }[]>`
      select id, budget_alert_level as level, budget_paused as paused from workspaces
      where id in ('ws-a', 'ws-b') order by id`;
    expect(workspaces).toEqual([
      { id: "ws-a", level: 100, paused: true },
      { id: "ws-b", level: 80, paused: false },
    ]);
    const orgs = await sql<{ id: string; level: number; paused: boolean }[]>`
      select id, budget_alert_level as level, budget_paused as paused from organizations order by id`;
    expect(orgs).toEqual([
      { id: "org-1", level: 80, paused: false },
      { id: "org-2", level: 100, paused: true },
    ]);
  });

  it("re-pauses an over-budget scope whose budget_paused was cleared without a level change", async () => {
    // A budget edit clears budget_paused but leaves budget_alert_level at 100.
    await sql`update organizations set budget_alert_level = 100, budget_paused = false where id = 'org-2'`;
    await store.processBudgetAlerts();
    const [org] = await sql<{ level: number; paused: boolean }[]>`
      select budget_alert_level as level, budget_paused as paused from organizations where id = 'org-2'`;
    expect(org).toEqual({ level: 100, paused: true });
  });

  it("keeps a deleted workspace's spend in its org budget", async () => {
    await sql`update organizations set budget_alert_level = 0, budget_paused = false, monthly_budget_cents = 20 where id = 'org-1'`;
    await sql`delete from workspaces where id = 'ws-a'`;
    await store.processBudgetAlerts();
    const [org] = await sql<{ level: number; paused: boolean }[]>`
      select budget_alert_level as level, budget_paused as paused from organizations where id = 'org-1'`;
    // ingest 10 + search 4 (both in the deleted workspace) + session 2 + two split thirds 4 = 20.
    expect(org).toEqual({ level: 100, paused: true });
  });
});
