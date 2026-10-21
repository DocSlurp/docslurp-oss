import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** The rate-limit plan lookup (services/rate-limit-plan.ts) against a migrated database. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let plan: typeof import("../services/rate-limit-plan.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')`;
  plan = await import("../services/rate-limit-plan.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  plan.resetRateLimitPlanCache();
  await sql`delete from org_memberships`;
  await sql`delete from organizations`;
  await sql`
    insert into organizations(id, name, slug, created_by_user_id, plan_id, subscription_status, past_due_since) values
      ('free', 'Free', 'free', 'u1', 'free', 'none', null),
      ('gold', 'Gold', 'gold', 'u1', 'gold', 'active', null),
      ('grace', 'Grace', 'grace', 'u1', 'silver', 'past_due', now() - interval '2 days'),
      ('lapsed', 'Lapsed', 'lapsed', 'u1', 'silver', 'past_due', now() - interval '9 days')
  `;
  await sql`insert into org_memberships(org_id, user_id, role) values ('free', 'u1', 'owner'), ('gold', 'u1', 'member'), ('free', 'u2', 'member'), ('lapsed', 'u2', 'owner')`;
});

describe("rate-limit plan lookup", () => {
  it("resolves an organization's plan, honoring the past-due grace", async () => {
    expect(await plan.orgRateLimitProfile("free")).toBe("free");
    expect(await plan.orgRateLimitProfile("gold")).toBe("paid");
    expect(await plan.orgRateLimitProfile("grace")).toBe("paid");
    expect(await plan.orgRateLimitProfile("lapsed")).toBe("free");
    expect(await plan.orgRateLimitProfile("missing")).toBe("free");
  });

  it("gives a user the paid table when any of their organizations is paid", async () => {
    expect(await plan.userRateLimitProfile("u1")).toBe("paid");
    expect(await plan.userRateLimitProfile("u2")).toBe("free");
  });
});
