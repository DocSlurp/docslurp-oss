import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";
import { withTestSession } from "./helpers/session-app.js";

/**
 * The customer cost breakdown against a migrated database, with no service mocks: a member of one organization
 * reads only their own organization's run credits and tokens. A run id from another organization reads nothing
 * (council round 3, N1).
 */
let stop: () => Promise<void>;
let sql: postgres.Sql;
let app: Hono;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  // One connection (the PGlite socket serves one at a time), with the app client's numeric parsing.
  sql = postgres(pg.url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('oa', 'Org A', 'org-a', 'ua'), ('ob', 'Org B', 'org-b', 'ub')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('oa', 'ua', 'member'), ('ob', 'ub', 'owner')`;
  await sql`insert into projects(id, org_id, user_id, name) values ('pa', 'oa', 'ua', 'A'), ('pb', 'ob', 'ub', 'B')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values ('run-a', 'oa', 'ua', 'pa', 'bulk-upload', 'completed', 'completed', '{}'::jsonb),
           ('run-b', 'ob', 'ub', 'pb', 'bulk-upload', 'completed', 'completed', '{}'::jsonb)`;
  const event = (id: string, org: string, user: string, project: string, run: string, fields: Record<string, unknown>) => ({
    id, user_id: user, org_id: org, project_id: project, run_id: run, document_id: null, provider: "docslurp", model: "unit",
    metric: "ingest-page-fast", amount: 10, unit: "page", input_tokens: 0, output_tokens: 0, cost_cents: 0, metadata: { runId: run }, ...fields,
  });
  for (const row of [
    event("a-pages", "oa", "ua", "pa", "run-a", { cost_cents: 12 }),
    event("a-llm", "oa", "ua", "pa", "run-a", { provider: "openrouter", model: "openai/gpt-6-luna", metric: "page-analysis", unit: "token", input_tokens: 100, output_tokens: 50, cost_cents: 0.4 }),
    event("b-pages", "ob", "ub", "pb", "run-b", { cost_cents: 4000 }),
    event("b-llm", "ob", "ub", "pb", "run-b", { provider: "openrouter", model: "openai/gpt-6-luna", metric: "page-analysis", unit: "token", input_tokens: 900, output_tokens: 300, cost_cents: 7 }),
  ]) {
    await sql`insert into usage_events ${sql(row as never, Object.keys(row) as never)}`;
  }
  const { billingRoutes } = await import("../routes/billing.js");
  app = withTestSession(new Hono(), { id: "ua" }).route("/v1/billing", billingRoutes);
}, 300_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

const breakdown = async (runId: string, orgId: string) =>
  app.request(`/v1/billing/usage/run/${runId}/cost-breakdown?orgId=${orgId}`);

describe("customer cost breakdown is tenant-scoped", () => {
  it("shows the member's own run credits and tokens", async () => {
    const response = await breakdown("run-a", "oa");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.credits).toBe(12);
    expect(body.totalTokens).toBe(150);
    expect(JSON.stringify(body)).not.toMatch(/openai|luna|costCents/);
  });

  it("reads nothing for another organization's run id, even through the member's own org", async () => {
    const response = await breakdown("run-b", "oa");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ totalTokens: 0, credits: 0, byStage: [], byCategory: [] });
  });

  it("refuses an organization the member does not belong to", async () => {
    expect((await breakdown("run-b", "ob")).status).toBe(404);
  });

  it("scopes the usage rows the same way", async () => {
    const response = await app.request("/v1/billing/usage/jobs?orgId=oa&runId=run-b");
    expect(response.status).toBe(200);
    expect((await response.json()).costs).toEqual([]);
  });
});
