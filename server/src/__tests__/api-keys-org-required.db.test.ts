import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Migration 0130: api_keys.org_id and webhooks.org_id are NOT NULL. A key row with
 * no org was never served (validateApiKey refuses it); the migration revokes such
 * rows and never grants them access: a row is re-homed only to its owner's
 * personal organization, and deleted when there is none. A webhook is re-homed to
 * an organization its creator owns or administers (personal first), else deleted.
 */
const migration = readFileSync(new URL("../../db/migrations/0125_tenant_scoped_keys_and_webhooks.sql", import.meta.url), "utf8");
let stop: () => Promise<void>;
let sql: postgres.Sql;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.test'), ('u2', 'B', 'b@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
    ('personal-u1', 'P', 'personal-u1', 'u1', true, 'u1'), ('team', 'T', 'team', 'u2', false, null)`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("api_keys.org_id", () => {
  it("rejects a key without an organization", async () => {
    await expect(sql`insert into api_keys (id, user_id, org_id, key_hash, name) values ('k0', 'u1', null, 'h0', 'n')`)
      .rejects.toMatchObject({ code: "23502" });
  });

  it("revokes orphaned legacy keys, re-homes them only to the owner's personal org and deletes the rest", async () => {
    await sql`alter table api_keys alter column org_id drop not null`;
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name) values
      ('orphan-personal', 'u1', null, 'h1', 'n'),
      ('orphan-nowhere', 'u2', null, 'h2', 'n'),
      ('healthy', 'u2', 'team', 'h3', 'n')`;
    await sql.unsafe(migration);
    const rows = await sql<{ id: string; org_id: string; revoked: boolean }[]>`
      select id, org_id, revoked_at is not null as revoked from api_keys order by id`;
    // u2 has no personal org, so its orphan is gone rather than attached to the team it never had.
    expect(rows).toEqual([
      { id: "healthy", org_id: "team", revoked: false },
      { id: "orphan-personal", org_id: "personal-u1", revoked: true },
    ]);
    await expect(sql`insert into api_keys (id, user_id, org_id, key_hash, name) values ('k9', 'u1', null, 'h9', 'n')`)
      .rejects.toMatchObject({ code: "23502" });
  });

  it("re-homes legacy webhooks to an org the creator administers and drops the rest", async () => {
    await sql`insert into "user"(id, name, email) values ('u3', 'C', 'c@example.test')`;
    await sql`insert into org_memberships (org_id, user_id, role) values
      ('personal-u1', 'u1', 'owner'), ('team', 'u2', 'owner'), ('team', 'u3', 'member')`;
    await sql`alter table webhooks alter column org_id drop not null`;
    await sql`insert into webhooks (id, user_id, org_id, url, secret) values
      ('w-personal', 'u1', null, 'https://example.test/a', 's'),
      ('w-team', 'u2', null, 'https://example.test/b', 's'),
      ('w-member-only', 'u3', null, 'https://example.test/c', 's')`;
    await sql.unsafe(migration);
    const rows = await sql<{ id: string; org_id: string }[]>`select id, org_id from webhooks order by id`;
    // u3 only belongs to the team as a plain member, so its webhook is not guessed into that org.
    expect(rows).toEqual([{ id: "w-personal", org_id: "personal-u1" }, { id: "w-team", org_id: "team" }]);
    await expect(sql`insert into webhooks (id, user_id, org_id, url, secret) values ('w-x', 'u1', null, 'https://example.test', 's')`)
      .rejects.toMatchObject({ code: "23502" });
  });
});
