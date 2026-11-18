import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Run admission re-validates its principal after the organization's spend lock is held (council H1 on #482): an
 * authorization change that commits while an admission waits for the lock refuses it, with nothing admitted. Real
 * Postgres (TEST_DATABASE_URL, a throwaway database; scripts/run-database-tests.mjs provides one per file).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("run admission revalidates its principal under the spend lock", () => {
  let sql: typeof import("../db.js").sql;
  let admitRunSpend: typeof import("../services/billing/spend-guard.js").admitRunSpend;
  let runCreation: typeof import("../services/run-creation.js");
  const clients: Client[] = [];
  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    clients.push(client);
    await client.query("set statement_timeout = '10s'");
    return client;
  }
  const principal = { orgId: "adm-o", projectId: "adm-p", userId: "adm-u", apiKeyId: "adm-k", scope: "ingest" };
  /** Ordering, not timing: resolves once some backend of this database is blocked waiting on a lock. */
  async function untilSomeoneWaitsOnALock(): Promise<void> {
    const observer = await connect();
    await vi.waitFor(async () => {
      const { rows } = await observer.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
      expect(rows[0]!.n).toBeGreaterThan(0);
    }, { timeout: 10_000, interval: 20 });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    ({ sql } = await import("../db.js"));
    ({ admitRunSpend } = await import("../services/billing/spend-guard.js"));
    runCreation = await import("../services/run-creation.js");
    await sql`insert into "user" (id, name, email) values ('adm-u', 'Admission', 'adm-u@example.test') on conflict do nothing`;
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('adm-o', 'Org', 'adm-o', 'adm-u') on conflict do nothing`;
    await sql`insert into projects (id, org_id, user_id, name) values ('adm-p', 'adm-o', 'adm-u', 'Project') on conflict do nothing`;
  }, 60_000);
  afterAll(async () => {
    await Promise.all(clients.map(client => client.end().catch(() => {})));
    await sql?.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql`delete from api_keys where id = 'adm-k'`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('adm-o', 'adm-u', 'owner') on conflict do nothing`;
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, allowed_domains, project_ids)
      values ('adm-k', 'adm-u', 'adm-o', 'hash-adm', 'Ingest', 'server', ${sql.array(["ingest"])}, '{}', ${sql.array(["adm-p"])})`;
  });

  /**
   * Starts an admission while another connection holds the organization's spend lock, applies `change` (committed)
   * while it waits, then releases the lock. Returns whether the admission's insert ran, and its error.
   */
  async function admitAcrossChange(change: string): Promise<{ admitted: boolean; error: unknown }> {
    const holder = await connect();
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(spend_admission_lock_key($1))", ["adm-o"]);
    let admitted = false;
    const admission = admitRunSpend("adm-o", "adm-p", async () => { admitted = true; return true; }, {
      authorize: tx => runCreation.assertPrincipalAtAdmission(tx, principal),
    }).then(() => null, (error: unknown) => error);
    // The admission is now waiting for the spend lock: the change commits meanwhile.
    await untilSomeoneWaitsOnALock();
    const editor = await connect();
    await editor.query(change);
    await holder.query("commit");
    return { admitted, error: await admission };
  }

  it.each([
    ["the key is revoked", "update api_keys set revoked_at = now() where id = 'adm-k'"],
    ["the key loses its ingest scope", "update api_keys set scopes = '{search:hybrid}' where id = 'adm-k'"],
    ["the project leaves the key's allowlist", "update api_keys set project_ids = '{other}' where id = 'adm-k'"],
    ["the user leaves the organization", "delete from org_memberships where org_id = 'adm-o' and user_id = 'adm-u'"],
  ])("refuses an admission that waited while %s: nothing admitted", async (_label, change) => {
    const { admitted, error } = await admitAcrossChange(change);
    expect(error).toBeInstanceOf(runCreation.RunAdmissionRefusedError);
    expect(admitted).toBe(false);
  }, 20_000);

  it("refuses a key that expired while the admission waited for the spend lock", async () => {
    // Live when the admission's transaction starts (its now()), expired by the time the spend lock is granted.
    await sql`update api_keys set expires_at = clock_timestamp() + interval '150 milliseconds' where id = 'adm-k'`;
    // The "change" is time passing: it completes only after the key has expired, then the lock is released.
    const { admitted, error } = await admitAcrossChange("select pg_sleep(0.3)");
    expect(error).toBeInstanceOf(runCreation.RunAdmissionRefusedError);
    expect(admitted).toBe(false);
  }, 20_000);

  it("never deadlocks with a membership removal that deletes the membership and then revokes the key", async () => {
    // The removal's order (membership, then key) is the admission's lock order too.
    const remover = await connect();
    await remover.query("begin");
    await remover.query("delete from org_memberships where org_id = 'adm-o' and user_id = 'adm-u'");
    let admitted = false;
    const admission = admitRunSpend("adm-o", "adm-p", async () => { admitted = true; return true; }, {
      authorize: tx => runCreation.assertPrincipalAtAdmission(tx, principal),
    }).then(() => null, (error: unknown) => error);
    // The admission now waits on the deleted membership row; the removal goes on to the key and its shares, and commits.
    await untilSomeoneWaitsOnALock();
    await remover.query("update api_keys set revoked_at = now() where org_id = 'adm-o' and user_id = 'adm-u' and revoked_at is null");
    await remover.query("update mcp_oauth_grants set revoked_at = now() where org_id = 'adm-o' and user_id = 'adm-u' and revoked_at is null");
    await remover.query("delete from project_members where user_id = 'adm-u' and project_id in (select id from projects where org_id = 'adm-o')");
    await remover.query("commit");
    const error = await admission;
    expect(error).toBeInstanceOf(runCreation.RunAdmissionRefusedError);
    expect((error as { code?: string }).code).not.toBe("40P01");
    expect(admitted).toBe(false);
  }, 20_000);

  it("is not refused for its principal when nothing changed", async () => {
    const { error } = await admitAcrossChange("select 1");
    // Spend may still refuse an unfunded test organization; the principal check must not.
    expect(error).not.toBeInstanceOf(runCreation.RunAdmissionRefusedError);
  }, 20_000);

  it("holds the key row while admitting, so a revocation waits for the admission to commit", async () => {
    const events: string[] = [];
    let release!: () => void;
    const admission = sql.begin(async tx => {
      await runCreation.assertPrincipalAtAdmission(tx, principal);
      events.push("authorized");
      await new Promise<void>(resolve => { release = resolve; });
      events.push("admitted");
    });
    await vi.waitFor(() => expect(events).toEqual(["authorized"]));
    const editor = await connect();
    const revocation = editor.query("update api_keys set revoked_at = now() where id = 'adm-k'").then(() => { events.push("revoked"); });
    // The revocation is blocked by the admission's FOR SHARE lock until the admission commits.
    await untilSomeoneWaitsOnALock();
    expect(events).toEqual(["authorized"]);
    release();
    await admission;
    await revocation;
    expect(events).toEqual(["authorized", "admitted", "revoked"]);
  }, 20_000);

  describe("through the real confirm path", () => {
    // Sessions name their project by its id (a UUID): intake resolves anything else as a project name.
    const P2 = "b0000000-0000-4000-8000-000000000001";
    let confirm: typeof import("../services/project-intake-actions.js").confirmDirectUploadProjectIntake;
    let ports: import("../services/project-intake.js").ProjectIntakePorts;
    let counter = 0;
    beforeAll(async () => {
      ({ confirmDirectUploadProjectIntake: confirm } = await import("../services/project-intake-actions.js"));
      const intake = await import("../services/project-intake.js");
      const { createProjectIntakeFakes } = await import("./helpers/project-intake-fakes.js");
      // Real records and run creation; only object storage is in memory (nothing is read before admission).
      ports = { ...intake.projectIntakePorts, storage: createProjectIntakeFakes().ports.storage };
      await sql`insert into "user" (id, name, email) values ('adm-m', 'Member', 'adm-m@example.test'), ('adm-s', 'Shared', 'adm-s@example.test') on conflict do nothing`;
      await sql`insert into mcp_oauth_clients (id, name, redirect_uris) values ('adm-client', 'Device login', '[]') on conflict do nothing`;
      await sql`insert into projects (id, org_id, user_id, name) values (${P2}, 'adm-o', 'adm-u', 'Confirm path') on conflict do nothing`;
    });
    beforeEach(async () => {
      // The key admits the confirm path's project too.
      await sql`update api_keys set project_ids = ${sql.array(["adm-p", P2])} where id = 'adm-k'`;
    });

    /** A pending session whose one file is transferred and sealed: only admission is left. */
    async function seedReadySession(userId: string, apiKeyId: string | null, orgId = "adm-o", projectId = P2): Promise<string> {
      counter += 1;
      const id = `22222222-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      await sql`insert into upload_sessions (id, user_id, org_id, project_id, api_key_id, allowed_project_ids, status, next_reconcile_at)
        values (${id}, ${userId}, ${orgId}, ${projectId}, ${apiKeyId}, ${apiKeyId ? sql.array([projectId]) : null}, 'pending', now() + interval '1 hour')`;
      await sql`insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, status)
        values (${`${id}-f`}, ${id}, 'notes.txt', 'text/plain', 10, ${`${userId}/${id}/raw/sealed-f-notes.txt`}, 'single', 'completed')`;
      return id;
    }

    /** Confirms while the spend lock is held elsewhere, commits `change` once the admission is blocked, then releases. */
    async function confirmAcrossChange(sessionId: string, userId: string, change: string, orgId = "adm-o") {
      const holder = await connect();
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(spend_admission_lock_key($1))", [orgId]);
      const confirming = confirm({ sessionId, userId }, ports).then(() => null, (error: unknown) => error);
      // The confirm must reach admission and block on the spend lock; a confirm that ends first failed earlier.
      const early = await Promise.race([confirming.then(error => ({ error })), untilSomeoneWaitsOnALock().then(() => null)]);
      if (early) await holder.query("rollback");
      if (early) throw new Error(`confirm ended before admission: ${early.error instanceof Error ? `${early.error.name}: ${early.error.message}` : String(early.error)}`);
      const editor = await connect();
      await editor.query(change);
      await holder.query("commit");
      const error = await confirming;
      const [runs] = await sql<Array<{ n: number }>>`select count(*)::int as n from project_runs where id = ${sessionId}`;
      const [leases] = await sql<Array<{ n: number }>>`select count(*)::int as n from credit_leases where holder_id = ${sessionId}`;
      const [session] = await sql<Array<{ status: string }>>`select status from upload_sessions where id = ${sessionId}`;
      return { error, runs: runs!.n, leases: leases!.n, status: session!.status };
    }

    const refusedCleanly = (outcome: Awaited<ReturnType<typeof confirmAcrossChange>>) => {
      expect(outcome.error).toMatchObject({ statusCode: 403 });
      // No run row, no reservation, and the session back to its earlier status.
      expect(outcome).toMatchObject({ runs: 0, leases: 0, status: "pending" });
    };

    it("refuses a key-opened session whose key is revoked during the wait", async () => {
      const id = await seedReadySession("adm-u", "adm-k");
      refusedCleanly(await confirmAcrossChange(id, "adm-u", "update api_keys set revoked_at = now() where id = 'adm-k'"));
    }, 30_000);

    it("refuses a project-member-only contributor whose project role is removed during the wait", async () => {
      await sql`insert into org_memberships (org_id, user_id, role) values ('adm-o', 'adm-m', 'member') on conflict do nothing`;
      await sql`insert into project_members (project_id, user_id, role) values (${P2}, 'adm-m', 'editor') on conflict do nothing`;
      const id = await seedReadySession("adm-m", null);
      refusedCleanly(await confirmAcrossChange(id, "adm-m", `delete from project_members where project_id = '${P2}' and user_id = 'adm-m'`));
    }, 30_000);

    it("refuses a contributor with shared-project access only, when the share is removed during the wait", async () => {
      // A project shared out of a personal organization: the contributor is not a member of it.
      const P3 = "b0000000-0000-4000-8000-000000000003";
      await sql`insert into organizations (id, name, slug, created_by_user_id, is_personal) values ('adm-po', 'Personal', 'adm-po', 'adm-u', true) on conflict do nothing`;
      await sql`insert into org_memberships (org_id, user_id, role) values ('adm-po', 'adm-u', 'owner') on conflict do nothing`;
      await sql`insert into projects (id, org_id, user_id, name) values (${P3}, 'adm-po', 'adm-u', 'Shared') on conflict do nothing`;
      await sql`insert into project_members (project_id, user_id, role) values (${P3}, 'adm-s', 'editor') on conflict do nothing`;
      const id = await seedReadySession("adm-s", null, "adm-po", P3);
      refusedCleanly(await confirmAcrossChange(id, "adm-s", `delete from project_members where project_id = '${P3}' and user_id = 'adm-s'`, "adm-po"));
    }, 30_000);

    it("refuses an OAuth device-login key whose grant is revoked during the wait", async () => {
      await sql`delete from mcp_oauth_grants where id = 'adm-grant'`;
      await sql`delete from api_keys where id = 'adm-ok'`;
      await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, allowed_domains, project_ids)
        values ('adm-ok', 'adm-u', 'adm-o', 'hash-adm-ok', 'OAuth: Device login', 'server', ${sql.array(["ingest"])}, '{}', ${sql.array([P2])})`;
      await sql`insert into mcp_oauth_grants (id, client_id, user_id, org_id, resource, scopes, api_key_id)
        values ('adm-grant', 'adm-client', 'adm-u', 'adm-o', 'https://api.example.test', '["ingest"]', 'adm-ok')`;
      const id = await seedReadySession("adm-u", "adm-ok");
      refusedCleanly(await confirmAcrossChange(id, "adm-u", "update mcp_oauth_grants set revoked_at = now() where id = 'adm-grant'"));
    }, 30_000);
  });
});
