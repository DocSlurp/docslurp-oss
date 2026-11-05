import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";

/**
 * Migration 0125 makes the organization the only tenant of api_keys and webhooks in one release: a legacy row is moved to
 * an organization only when its user belongs to exactly one (and, for a webhook, administers it); every other one is
 * deleted. Both org_id columns end NOT NULL.
 */
const MIGRATION = "tenant_scoped_keys_and_webhooks";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;

const rows = async <T>(text: string) => (await db.query<T>(text)).rows;

beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: MIGRATION });
  // solo: only a personal org (owner). duo: personal org + a team. member: one team, plain member. gone: one org, deleted.
  await db.exec(`
    insert into "user"(id, name, email) values
      ('solo', 'S', 'solo@example.test'), ('duo', 'D', 'duo@example.test'), ('member', 'M', 'member@example.test'),
      ('gone', 'G', 'gone@example.test'), ('none', 'N', 'none@example.test');
    insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
      ('p-solo', 'P', 'p-solo', 'solo', true, 'solo'), ('p-duo', 'P2', 'p-duo', 'duo', true, 'duo'),
      ('team', 'T', 'team', 'duo', false, null), ('dead', 'X', 'dead', 'gone', false, null);
    update organizations set deleted_at = now() where id = 'dead';
    insert into org_memberships (org_id, user_id, role) values
      ('p-solo', 'solo', 'owner'), ('p-duo', 'duo', 'owner'), ('team', 'duo', 'owner'), ('team', 'member', 'member'),
      ('dead', 'gone', 'owner');
    insert into api_keys (id, user_id, org_id, key_hash, name, revoked_at) values
      ('k-solo', 'solo', null, 'h1', 'n', null),
      ('k-duo', 'duo', null, 'h2', 'n', null),
      ('k-duo-revoked', 'duo', null, 'h3', 'n', now()),
      ('k-member', 'member', null, 'h4', 'n', null),
      ('k-gone', 'gone', null, 'h5', 'n', null),
      ('k-none', 'none', null, 'h6', 'n', now()),
      ('k-healthy', 'duo', 'team', 'h7', 'n', null);
    insert into webhooks (id, user_id, url, secret) values
      ('w-solo', 'solo', 'https://example.test/solo', 's'),
      ('w-duo', 'duo', 'https://example.test/duo', 's'),
      ('w-member', 'member', 'https://example.test/member', 's'),
      ('w-gone', 'gone', 'https://example.test/gone', 's'),
      ('w-none', 'none', 'https://example.test/none', 's');
    insert into webhook_deliveries (id, webhook_id, user_id, event_type, target_url) values
      ('d-solo', 'w-solo', 'solo', 'run.completed', 'https://example.test/solo'),
      ('d-duo', 'w-duo', 'duo', 'run.completed', 'https://example.test/duo');
  `);
  await applyRemainingMigrations(db, MIGRATION);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("0125 api_keys", () => {
  it("homes a null-org key only to the owner's single live org, keeps it revoked, and deletes the rest", async () => {
    expect(await rows("select id, org_id, revoked_at is not null as revoked from api_keys order by id")).toEqual([
      { id: "k-healthy", org_id: "team", revoked: false },
      // A member of exactly one organization: homed there, but never revived.
      { id: "k-member", org_id: "team", revoked: true },
      { id: "k-solo", org_id: "p-solo", revoked: true },
    ]);
  });

  it("refuses a key without an organization", async () => {
    await expect(db.query("insert into api_keys (id, user_id, org_id, key_hash, name, revoked_at) values ('k9', 'solo', null, 'h9', 'n', now())"))
      .rejects.toThrow(/null value in column "org_id"/);
  });
});

describe("0125 webhooks", () => {
  it("homes a webhook only when its creator administers their one live org, and deletes the others with their deliveries", async () => {
    expect(await rows("select id, org_id from webhooks order by id")).toEqual([{ id: "w-solo", org_id: "p-solo" }]);
    expect(await rows("select id from webhook_deliveries order by id")).toEqual([{ id: "d-solo" }]);
  });

  it("has no workspace scope and refuses a webhook without an organization", async () => {
    expect(await rows("select column_name from information_schema.columns where table_name = 'webhooks' and column_name = 'workspace_id'")).toEqual([]);
    await expect(db.query("insert into webhooks (id, user_id, url, secret) values ('w9', 'solo', 'https://example.test/x', 's')"))
      .rejects.toThrow(/null value in column "org_id"/);
  });
});

describe("0125 on an empty database", () => {
  it("applies cleanly", async () => {
    const empty = await createMigratedDatabase();
    try {
      expect(await empty.query("select is_nullable from information_schema.columns where table_name = 'webhooks' and column_name = 'org_id'"))
        .toMatchObject({ rows: [{ is_nullable: "NO" }] });
      expect(await empty.query("select is_nullable from information_schema.columns where table_name = 'api_keys' and column_name = 'org_id'"))
        .toMatchObject({ rows: [{ is_nullable: "NO" }] });
    } finally {
      await empty.close();
    }
  }, 120_000);
});
