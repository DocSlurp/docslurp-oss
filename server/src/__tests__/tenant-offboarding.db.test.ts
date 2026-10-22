import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// PGlite and the cleanup sweep are worker code, shared through its testing export.
import {
  startMigratedPostgres,
  drainDocumentCleanupQueue,
  drainStorageCleanupQueue,
  type SupersededPurgeOptions,
} from "@docslurp/worker/testing";

/**
 * Tenant offboarding against a migrated Postgres (docs/data-deletion.md):
 * org deletion, account deletion, the creator FK fix, and a full sweep that
 * leaves no residual storage keys or vector tables. Stripe and Temporal are mocked.
 */

const cancelWorkflow = vi.fn(async (_runId: string) => {});
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, postgres.PostgresType>>;
let offboarding: typeof import("../services/tenant-offboarding.js");
let deps: import("../services/tenant-offboarding.js").OffboardingDeps;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({ signalPipelineCancel: cancelWorkflow }));
  offboarding = await import("../services/tenant-offboarding.js");
  deps = { sql, cancelWorkflow };
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

async function reset() {
  for (const table of [
    "workspaces", "document_cleanup_queue", "storage_cleanup_queue", "org_memberships", "api_keys",
    "credit_ledger", "usage_events", "audit_log", "webhooks", "session", "account",
  ]) {
    await sql`delete from ${sql(table)}`;
  }
  await sql`delete from organizations`;
  await sql`delete from "user"`;
}

async function seedUser(id: string) {
  await sql`insert into "user"(id, name, email, "emailVerified") values (${id}, ${`User ${id}`}, ${`${id}@example.test`}, true)`;
}

async function seedOrg(id: string, name: string, members: Array<[userId: string, role: string]>, personalOwner?: string) {
  await sql`
    insert into organizations(id, name, slug, created_by_user_id, is_personal, personal_owner_user_id, stripe_customer_id, auto_recharge_enabled)
    values (${id}, ${name}, ${id}, ${members[0]![0]}, ${Boolean(personalOwner)}, ${personalOwner ?? null}, ${`cus_${id}`}, true)
  `;
  for (const [userId, role] of members) {
    await sql`insert into org_memberships(org_id, user_id, role) values (${id}, ${userId}, ${role})`;
  }
}

/** A workspace with a finished run, an in-flight run, a document and its vectors. */
async function seedWorkspace(id: string, orgId: string, userId: string) {
  await sql`insert into workspaces(id, org_id, user_id, name) values (${id}, ${orgId}, ${userId}, ${`WS ${id}`})`;
  for (const [runId, status] of [[`${id}-done`, "completed"], [`${id}-live`, "processing"]] as const) {
    await sql`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pipeline)
      values (${runId}, ${orgId}, ${userId}, ${id}, 'bulk-upload', ${status}, ${status}, 1, '{}'::jsonb)
    `;
  }
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    values (${`${id}-doc`}, ${orgId}, ${userId}, ${id}, ${`${id}-done`}, 'a.pdf', 'application/pdf', ${`${userId}/up-${id}/raw/a.pdf`}, 'completed')
  `;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`vi-${id}`}, ${`${id}-doc`}, 'lancedb', 'b', 'p', 'model-x', 4)`;
}

describe("organization deletion", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await reset();
    await seedUser("owner");
    await seedUser("member");
    await seedOrg("team", "Acme Team", [["owner", "owner"], ["member", "member"]]);
    await seedWorkspace("ws", "team", "member");
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type) values ('key', 'member', 'team', 'h', 'CI key', 'server')`;
    await sql`insert into credit_ledger (id, user_id, org_id, delta, reason) values ('ledger', 'member', 'team', -5, 'usage')`;
    await sql`insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents)
      values ('usage', 'member', 'ws-done', 'openai', 'm', 'embed', 1, 'tokens', 2)`;
  });

  it("refuses non-owners, a wrong confirmation and personal orgs", async () => {
    await expect(offboarding.deleteOrganization({ orgId: "team", userId: "member", confirmation: "Acme Team" }, deps))
      .rejects.toMatchObject({ status: 403 });
    await expect(offboarding.deleteOrganization({ orgId: "team", userId: "owner", confirmation: "acme" }, deps))
      .rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
    await seedOrg("mine", "Mine", [["owner", "owner"]], "owner");
    await expect(offboarding.deleteOrganization({ orgId: "mine", userId: "owner", confirmation: "Mine" }, deps))
      .rejects.toMatchObject({ status: 409, code: "personal_organization" });
  });

  it("turns off auto top-up, cancels runs, revokes access, enqueues cleanup and keeps anonymized billing history", async () => {
    const result = await offboarding.deleteOrganization({ orgId: "team", userId: "owner", confirmation: "Acme Team" }, deps);

    expect(result).toMatchObject({ orgId: "team", workspaces: 1, documents: 1, runsCancelled: 1 });
    expect(cancelWorkflow.mock.calls.map(([runId]) => runId)).toEqual(["ws-live"]);
    expect(await sql`select count(*)::int as count from workspaces`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from org_memberships where org_id = 'team'`).toEqual([{ count: 0 }]);
    expect(await sql`select revoked_at is not null as revoked, name from api_keys`).toEqual([{ revoked: true, name: "Deleted key" }]);
    expect(await sql`select document_id from document_cleanup_queue`).toEqual([{ document_id: "ws-doc" }]);
    expect(await sql`select kind, target from storage_cleanup_queue order by kind, target`).toEqual([
      { kind: "storage_prefix", target: "member/ws-done/" },
      { kind: "storage_prefix", target: "member/ws-live/" },
      { kind: "vector_table", target: "team|model-x|4" },
    ]);
    const [org] = await sql`select name, slug, deleted_at is not null as deleted, offboarded_at is not null as offboarded,
      stripe_customer_id, auto_recharge_enabled from organizations where id = 'team'`;
    expect(org).toEqual({ name: "Deleted organization", slug: null, deleted: true, offboarded: true, stripe_customer_id: "cus_team", auto_recharge_enabled: false });
    // Billing records survive for accounting; the deleted run is detached.
    expect(await sql`select id from credit_ledger`).toEqual([{ id: "ledger" }]);
    expect(await sql`select id, run_id from usage_events`).toEqual([{ id: "usage", run_id: null }]);
    expect(await sql`select action from audit_log where org_id = 'team'`).toEqual([{ action: "organization.deleted" }]);
  });

  it("leaves no residual storage keys or vector tables once the sweep drains", async () => {
    await offboarding.deleteOrganization({ orgId: "team", userId: "owner", confirmation: "Acme Team" }, deps);
    await sql`update storage_cleanup_queue set not_before = now() - interval '1 second'`;
    await sql`update document_cleanup_queue set not_before = now() - interval '1 second'`;

    const objects = new Set(["member/ws-done/markdown/ws-doc.md", "member/ws-live/vision/late.json", "member/up-ws/raw/a.pdf", "other/keep.json"]);
    const tables = new Set(["/lance/team/vectors/model-x/4#chunks"]);
    const vectorRowDeletes: string[][] = [];
    const storage = {
      bucket: "b",
      async listKeys({ prefix }: { prefix: string }) { return { keys: [...objects].filter((key) => key.startsWith(prefix)) }; },
      async deleteKeys(keys: string[]) { for (const key of keys) objects.delete(key); },
    };
    const options: SupersededPurgeOptions = {
      graceSeconds: 0,
      batchSize: 10,
      deleteSources: false,
      lancedbRoot: "/lance",
      deleteVectorRows: async ({ documentIds }) => { vectorRowDeletes.push(documentIds); },
      dropVectorTable: async ({ uri, table }) => { tables.delete(`${uri}#${table}`); },
    };
    const db = sql as unknown as Parameters<typeof drainDocumentCleanupQueue>[0];
    await drainDocumentCleanupQueue(db, storage, options);
    await drainStorageCleanupQueue(db, storage, options);

    expect([...objects]).toEqual(["other/keep.json"]);
    expect([...tables]).toEqual([]);
    // The table is dropped whole, so no per-document vector deletes.
    expect(vectorRowDeletes).toEqual([]);
    expect(await sql`select count(*)::int as count from storage_cleanup_queue`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from document_cleanup_queue`).toEqual([{ count: 0 }]);
  });
});

describe("creator and member FKs", () => {
  beforeEach(async () => {
    await reset();
  });

  it("keeps the organization when its creator's user row is deleted", async () => {
    await seedUser("creator");
    await seedUser("owner2");
    await seedOrg("org", "Org", [["creator", "owner"], ["owner2", "owner"]]);
    await sql`delete from org_memberships where user_id = 'creator'`;
    await sql`delete from "user" where id = 'creator'`;
    expect(await sql`select id, created_by_user_id from organizations`).toEqual([{ id: "org", created_by_user_id: null }]);
  });

  it("refuses a hard user delete that would cascade into org content or billing history", async () => {
    await seedUser("owner");
    await seedUser("member");
    await seedOrg("org", "Org", [["owner", "owner"], ["member", "member"]]);
    await seedWorkspace("ws", "org", "member");
    await expect(sql`delete from "user" where id = 'member'`).rejects.toThrow(/foreign key/);
    expect(await sql`select count(*)::int as count from documents`).toEqual([{ count: 1 }]);
  });
});

describe("account deletion", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await reset();
    await seedUser("leaver");
    await seedUser("teammate");
    await seedOrg("personal", "Leaver Workspace", [["leaver", "owner"]], "leaver");
    await seedOrg("solo", "Side project", [["leaver", "owner"]]);
    await seedOrg("team", "Team", [["leaver", "owner"], ["teammate", "member"]]);
    await seedWorkspace("mine", "personal", "leaver");
    await seedWorkspace("shared", "team", "leaver");
    await sql`insert into webhooks (id, user_id, url, secret, events) values ('hook', 'leaver', 'https://example.test', 's', '{}')`;
    await sql`insert into "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
      values ('s1', now() + interval '1 day', 't1', now(), now(), 'leaver')`;
    await sql`insert into "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
      values ('a1', 'leaver', 'credential', 'leaver', now(), now())`;
  });

  it("requires an ownership transfer while the user is the sole owner of a team org", async () => {
    const plan = await offboarding.planAccountDeletion("leaver", sql);
    expect(plan).toEqual({
      blockers: [{ orgId: "team", name: "Team", memberCount: 2 }],
      deleteOrganizations: [
        { orgId: "personal", name: "Leaver Workspace", isPersonal: true },
        { orgId: "solo", name: "Side project", isPersonal: false },
      ],
      leaveOrganizations: [],
    });
    await expect(offboarding.deleteAccount({ userId: "leaver", confirmation: "leaver@example.test" }, deps))
      .rejects.toMatchObject({ status: 409, code: "ownership_transfer_required" });
    expect(await sql`select count(*)::int as count from workspaces`).toEqual([{ count: 2 }]);
  });

  it("purges personal and solo orgs, leaves team orgs with their content, and tombstones the user", async () => {
    await sql`update org_memberships set role = 'owner' where org_id = 'team' and user_id = 'teammate'`;
    await expect(offboarding.deleteAccount({ userId: "leaver", confirmation: "nope@example.test" }, deps))
      .rejects.toMatchObject({ status: 400 });

    const result = await offboarding.deleteAccount({ userId: "leaver", confirmation: " Leaver@Example.test " }, deps);

    expect(result).toEqual({ deletedOrganizations: ["personal", "solo"], leftOrganizations: ["team"] });
    expect(await sql`select id from workspaces`).toEqual([{ id: "shared" }]);
    expect(await sql`select user_id from documents`).toEqual([{ user_id: "leaver" }]);
    expect(await sql`select org_id, user_id from org_memberships`).toEqual([{ org_id: "team", user_id: "teammate" }]);
    expect(await sql`select name, email, deleted_at is not null as deleted from "user" where id = 'leaver'`)
      .toEqual([{ name: "Deleted user", email: "deleted-leaver@deleted.invalid", deleted: true }]);
    expect(await sql`select count(*)::int as count from "session"`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from "account"`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from webhooks`).toEqual([{ count: 0 }]);
    expect(await sql`select id, name from organizations where deleted_at is not null order by id`)
      .toEqual([{ id: "personal", name: "Deleted organization" }, { id: "solo", name: "Deleted organization" }]);
    expect(await sql`select document_id from document_cleanup_queue`).toEqual([{ document_id: "mine-doc" }]);
  });
});
