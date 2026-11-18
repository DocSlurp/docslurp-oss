import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
    await new Promise(resolve => setTimeout(resolve, 300));
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
    await new Promise(resolve => setTimeout(resolve, 200));
    const editor = await connect();
    const revocation = editor.query("update api_keys set revoked_at = now() where id = 'adm-k'").then(() => { events.push("revoked"); });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(events).toEqual(["authorized"]);
    release();
    await admission;
    await revocation;
    expect(events).toEqual(["authorized", "admitted", "revoked"]);
  }, 20_000);
});
