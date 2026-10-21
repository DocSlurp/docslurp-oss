import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** A key's requests-per-minute is an optional cap (migration 0067): null means the plan's limits. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let keys: typeof import("../services/api-keys.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  keys = await import("../services/api-keys.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("api key rpm cap", () => {
  it("creates keys without a cap unless one is given, and PATCH null removes it", async () => {
    const plain = await keys.createApiKey("u1", "plain");
    expect(plain.key.rateLimitRpm).toBeNull();
    const capped = await keys.createApiKey("u1", "capped", { rpm: 30 });
    expect(capped.key.rateLimitRpm).toBe(30);

    expect((await keys.updateApiKey(capped.key.id, "u1", { name: "renamed" }))?.rateLimitRpm).toBe(30);
    expect((await keys.updateApiKey(capped.key.id, "u1", { rateLimitRpm: null }))?.rateLimitRpm).toBeNull();
    expect((await keys.updateApiKey(plain.key.id, "u1", { rateLimitRpm: 45 }))?.rateLimitRpm).toBe(45);

    const validated = await keys.validateApiKey(plain.rawKey);
    expect(validated?.rateLimitRpm).toBe(45);
    expect((await keys.validateApiKey(capped.rawKey))?.rateLimitRpm).toBeNull();
  });

  it("moves keys at the old default (60) to no cap and keeps explicit caps", async () => {
    const [{ org_id: orgId }] = await sql<{ org_id: string }[]>`select org_id from api_keys limit 1`;
    await sql`
      insert into api_keys(id, user_id, org_id, key_hash, name, rate_limit_rpm) values
        ('old-default', 'u1', ${orgId}, 'h-old', 'old', 60),
        ('explicit', 'u1', ${orgId}, 'h-explicit', 'explicit', 90),
        ('oauth', 'u1', ${orgId}, 'h-oauth', 'OAuth: Claude', 120)
    `;
    const migration = readFileSync(new URL("../../db/migrations/0067_api_key_rpm_optional_cap.sql", import.meta.url), "utf8");
    await sql.unsafe(migration);
    const rows = await sql<{ id: string; rate_limit_rpm: number | null }[]>`select id, rate_limit_rpm from api_keys where id in ('old-default', 'explicit', 'oauth') order by id`;
    expect(rows).toEqual([
      { id: "explicit", rate_limit_rpm: 90 },
      { id: "oauth", rate_limit_rpm: null },
      { id: "old-default", rate_limit_rpm: null },
    ]);
  });
});
