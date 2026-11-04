import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Migration 0125 is the expand step: api_keys without an org are revoked and re-homed only to the owner's personal
 * organization (never deleted, never granted access), and a CHECK (NOT VALID) forbids new ones. webhooks.org_id is
 * nullable: release N-1 still inserts without it, and a trigger homes such a row. The contract step is documented in
 * docs/rollout-expand-contract-0121-0125.md.
 */
const migration = readFileSync(new URL("../../db/migrations/0125_tenant_scoped_keys_and_webhooks.sql", import.meta.url), "utf8");
let stop: () => Promise<void>;
let sql: postgres.Sql;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.test'), ('u2', 'B', 'b@example.test'), ('u3', 'C', 'c@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
    ('personal-u1', 'P', 'personal-u1', 'u1', true, 'u1'), ('team', 'T', 'team', 'u2', false, null), ('team-b', 'T2', 'team-b', 'u2', false, null)`;
  await sql`insert into org_memberships (org_id, user_id, role) values
    ('personal-u1', 'u1', 'owner'), ('team', 'u2', 'owner'), ('team-b', 'u2', 'owner'), ('team', 'u3', 'member'), ('team-b', 'u3', 'member')`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("api_keys.org_id", () => {
  it("rejects a new live key without an organization", async () => {
    await expect(sql`insert into api_keys (id, user_id, org_id, key_hash, name) values ('k0', 'u1', null, 'h0', 'n')`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "api_keys_org_id_required" });
  });

  it("revokes orphaned legacy keys, re-homes them only to the owner's personal org and deletes nothing", async () => {
    await sql`alter table api_keys drop constraint api_keys_org_id_required`;
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name) values
      ('orphan-personal', 'u1', null, 'h1', 'n'),
      ('orphan-nowhere', 'u2', null, 'h2', 'n'),
      ('healthy', 'u2', 'team', 'h3', 'n')`;
    await sql.unsafe(migration);
    const rows = await sql<{ id: string; org_id: string | null; revoked: boolean }[]>`
      select id, org_id, revoked_at is not null as revoked from api_keys order by id`;
    // u2 has no personal org, so its orphan stays revoked and unhomed rather than attached to a team it never used.
    expect(rows).toEqual([
      { id: "healthy", org_id: "team", revoked: false },
      { id: "orphan-nowhere", org_id: null, revoked: true },
      { id: "orphan-personal", org_id: "personal-u1", revoked: true },
    ]);
    await expect(sql`insert into api_keys (id, user_id, org_id, key_hash, name) values ('k9', 'u1', null, 'h9', 'n')`)
      .rejects.toMatchObject({ code: "23514" });
    // The dead rows stay updatable: a membership-removal sweep that touches them must not fail.
    await expect(sql`update api_keys set name = 'x' where id = 'orphan-nowhere'`).resolves.toBeDefined();
  });

  it("is idempotent when the migration is applied twice", async () => {
    await sql.unsafe(migration);
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from api_keys`;
    expect(count).toBe("3");
  });
});

describe("webhooks.org_id (expand)", () => {
  it("keeps release N-1 inserts working and homes them to the creator's personal org", async () => {
    await sql`insert into webhooks (id, user_id, url, secret) values ('w-old-personal', 'u1', 'https://example.test/a', 's')`;
    await sql`insert into webhooks (id, user_id, url, secret) values ('w-old-team', 'u2', 'https://example.test/b', 's')`;
    const rows = await sql<{ id: string; org_id: string | null }[]>`select id, org_id from webhooks order by id`;
    expect(rows).toEqual([{ id: "w-old-personal", org_id: "personal-u1" }, { id: "w-old-team", org_id: expect.stringMatching(/^team/) }]);
  });

  it("backfills from the organization the webhook delivered for, then the personal org, and never deletes", async () => {
    await sql.unsafe("alter table webhooks disable trigger webhooks_default_org");
    await sql`delete from webhooks`;
    await sql`insert into webhooks (id, user_id, org_id, url, secret) values
      ('w-history', 'u2', null, 'https://example.test/h', 's'),
      ('w-personal', 'u1', null, 'https://example.test/p', 's'),
      ('w-member-only', 'u3', null, 'https://example.test/m', 's')`;
    await sql.unsafe("alter table webhooks enable trigger webhooks_default_org");
    // u2 owns two teams; the webhook's own deliveries were for runs of team-b.
    await sql.unsafe("set session_replication_role = replica");
    await sql`insert into workspaces (id, user_id, org_id, name) values ('ws-b', 'u2', 'team-b', 'B')`;
    await sql`insert into workspace_runs (id, workspace_id, user_id, org_id, kind, status, stage, pipeline) values ('run-b1', 'ws-b', 'u2', 'team-b', 'bulk-upload', 'completed', 'completed', '{}'::jsonb), ('run-b2', 'ws-b', 'u2', 'team-b', 'bulk-upload', 'completed', 'completed', '{}'::jsonb)`;
    await sql`insert into webhook_deliveries (id, webhook_id, user_id, event_type, target_url, payload) values
      ('d1', 'w-history', 'u2', 'run.completed', 'https://example.test/h', ${sql.json({ runId: "run-b1" })}),
      ('d2', 'w-history', 'u2', 'run.completed', 'https://example.test/h', ${sql.json({ runId: "run-b2" })})`;
    await sql.unsafe("set session_replication_role = origin");
    await sql.unsafe(migration);
    const rows = await sql<{ id: string; org_id: string | null }[]>`select id, org_id from webhooks order by id`;
    // u3 is only a plain member, so its webhook is not guessed into an org; it stays for the contract step.
    expect(rows).toEqual([
      { id: "w-history", org_id: "team-b" },
      { id: "w-member-only", org_id: null },
      { id: "w-personal", org_id: "personal-u1" },
    ]);
  });
});
