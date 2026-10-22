import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { persistRunUsageEvents, persistScopedUsageEvents } from "../db/usage-event-store.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { applyRemainingMigrations, createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * usage_events tenant columns (migration 0042): writers stamp org, workspace
 * and API key at write time, and the migration backfills older rows with the
 * previous read-time rule, so spend survives run and workspace deletion.
 */
const TENANT_MIGRATION = "usage_event_tenant_columns";

async function seedTenants(db: PGlite) {
  await db.exec(`
    insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com');
    insert into organizations (id, name, slug, created_by_user_id) values
      ('org-1', 'One', 'one', 'u1'), ('org-2', 'Two', 'two', 'u1');
    insert into workspaces (id, org_id, user_id, name) values
      ('ws-a', 'org-1', 'u1', 'A'), ('ws-b', 'org-1', 'u1', 'B'), ('ws-c', 'org-2', 'u1', 'C');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, stats) values
      ('run-a', 'org-1', 'u1', 'ws-a', 'bulk-upload', 'processing', 'embed', '{}', '{"apiKeyId":"key-run"}');
    insert into search_sessions (id, user_id, query, metadata) values
      ('sess-b', 'u1', 'q', to_jsonb('{"workspaceId":"ws-b"}'::text));
  `);
}

type Columns = { id: string; org_id: string | null; workspace_id: string | null; api_key_id: string | null };

async function columns(db: PGlite): Promise<Record<string, Omit<Columns, "id">>> {
  const { rows } = await db.query<Columns>(
    "select id, org_id, workspace_id, api_key_id from usage_events order by id",
  );
  return Object.fromEntries(rows.map(({ id, ...rest }) => [id, rest]));
}

// A PGlite socket server owns the database while a client is connected.
async function sqlColumns(sql: postgres.Sql<Record<string, unknown>>): Promise<Record<string, Omit<Columns, "id">>> {
  const rows = await sql<Columns[]>`select id, org_id, workspace_id, api_key_id from usage_events order by id`;
  return Object.fromEntries(rows.map(({ id, ...rest }) => [id, rest]));
}

describe("usage_events tenant column backfill", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDatabase({ stopBefore: TENANT_MIGRATION });
    await seedTenants(db);
    // Rows in the pre-0042 shape: scope only in run_id and metadata.
    await db.exec(`
      insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata) values
        ('ingest', 'u1', 'run-a', 'openrouter', 'm', 'llm', 1, 'token', 10, '{}'),
        ('search-ws', 'u1', null, 'openrouter', 'm', 'llm', 1, 'token', 4, '{"workspaceId":"ws-a","apiKeyId":"key-req"}'),
        ('search-session', 'u1', null, 'openrouter', 'm', 'llm', 1, 'token', 2, '{"sessionId":"sess-b"}'),
        ('aggregate', 'u1', null, 'openrouter', 'm', 'llm', 1, 'token', 6, '{"workspaceIds":["ws-c","ws-a"]}'),
        ('org-only', 'u1', null, 'openrouter', 'm', 'llm', 1, 'token', 1, '{"orgId":"org-2"}');
    `);
    await applyRemainingMigrations(db, TENANT_MIGRATION);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("stamps each legacy row with the scope the old read-time rule gave it", async () => {
    expect(await columns(db)).toEqual({
      aggregate: { org_id: "org-2", workspace_id: null, api_key_id: null },
      ingest: { org_id: "org-1", workspace_id: "ws-a", api_key_id: "key-run" },
      "org-only": { org_id: "org-2", workspace_id: null, api_key_id: null },
      "search-session": { org_id: "org-1", workspace_id: "ws-b", api_key_id: null },
      "search-ws": { org_id: "org-1", workspace_id: "ws-a", api_key_id: "key-req" },
    });
    const { rows } = await db.query<{ run_id: string }>(
      "select metadata ->> 'runId' as run_id from usage_events where id = 'ingest'",
    );
    expect(rows[0]?.run_id).toBe("run-a");
  });

  it("keeps the stamp after the run and workspace are deleted", async () => {
    await db.exec("delete from workspaces where id = 'ws-a'");
    const after = await columns(db);
    expect(after.ingest).toEqual({ org_id: "org-1", workspace_id: "ws-a", api_key_id: "key-run" });
    const { rows } = await db.query<{ run_id: string | null }>("select run_id from usage_events where id = 'ingest'");
    expect(rows[0]?.run_id).toBeNull();
  });
});

describe("worker usage writers", () => {
  let db: PGlite;
  let server: PGLiteSocketServer;
  let sql: postgres.Sql<Record<string, unknown>>;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    await seedTenants(db);
    const served = await serveOnRandomPort(db);
    server = served.server;
    const port = served.port;
    sql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, {
      max: 1, prepare: false, onnotice: () => {},
      types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
    }) as unknown as postgres.Sql<Record<string, unknown>>;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await server?.stop();
    await db?.close();
  });

  it("stamps run usage with the run's org, workspace and API key", async () => {
    const state = {
      run: { id: "run-a", userId: "u1", orgId: "org-1", workspaceId: "ws-a", stats: { apiKeyId: "key-run" } },
    } as unknown as WorkflowState;
    const cost = await persistRunUsageEvents({
      client: sql,
      state,
      usageEvents: [
        { id: "w-1", provider: "docslurp", model: "price-card", metric: "ingest-page-rich", amount: 12, unit: "page", costCents: 3, metadata: { billable: true, unitCharge: true } },
        // Provider AI cost is stamped too but bills nothing.
        { id: "w-2", provider: "openrouter", model: "m", metric: "vision", amount: 1, unit: "page", costCents: 3 },
      ],
    });
    expect(cost).toBe(3);
    expect((await sqlColumns(sql))["w-2"]).toEqual({ org_id: "org-1", workspace_id: "ws-a", api_key_id: "key-run" });
    expect((await sqlColumns(sql))["w-1"]).toEqual({ org_id: "org-1", workspace_id: "ws-a", api_key_id: "key-run" });
  });

  it("stamps run-less job usage and debits its org", async () => {
    const cost = await persistScopedUsageEvents({
      client: sql,
      userId: "u1",
      scope: { orgId: "org-2", workspaceId: "ws-c" },
      usageEvents: [
        { id: "g-1", provider: "docslurp", model: "price-card", metric: "ingest-page-fast", amount: 400, unit: "page", costCents: 2, metadata: { billable: true, unitCharge: true } },
        { id: "g-2", provider: "openrouter", model: "m", metric: "graph-extract", amount: 10, unit: "token", costCents: 2, inputTokens: 10 },
      ],
    });
    expect(cost).toBe(2);
    expect((await sqlColumns(sql))["g-1"]).toEqual({ org_id: "org-2", workspace_id: "ws-c", api_key_id: null });
    const rows = await sql<{ credits: string }[]>`
      select credits::text from credit_debits_pending where org_id = 'org-2'`;
    expect(rows.map((row) => Number(row.credits))).toEqual([2]);
  });
});
