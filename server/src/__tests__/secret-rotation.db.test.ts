import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { openSecret, sealSecret } from "../lib/encryption.js";
import { rotateStoredSecrets } from "../lib/secret-rotation.js";
import type { SqlClient } from "../db.js";

let sql: SqlClient;
let stop: () => Promise<void>;
const oldKey = "ab".repeat(32);
const newKey = "cd".repeat(32);
const keys = ["SECRETS_ENCRYPTION_KEY", "CREDENTIALS_ENCRYPTION_KEY"];
beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as SqlClient;
  await sql`insert into "user" (id,name,email) values ('rotate-user','Rotate','rotate@example.com')`;
  await sql`insert into organizations (id,name,slug,created_by_user_id) values ('rotate-org','Rotate','rotate','rotate-user')`;
  await sql`insert into workspaces (id,org_id,user_id,name) values ('rotate-ws','rotate-org','rotate-user','Rotate')`;
}, 120_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await sql?.end(); await stop?.(); });

it("dry-runs and re-encrypts every real store in bounded resumable passes", async () => {
  for (const key of keys) {
    vi.stubEnv(key, oldKey);
    vi.stubEnv(`${key}_ID`, "axb");
    vi.stubEnv(`${key}_PREVIOUS_KEYS`, "{}");
  }
  const secret = sealSecret(keys[0]!, "stored secret");
  const credential = sealSecret(keys[1]!, '{"token":"credential"}');
  await sql`insert into workspace_secrets (id,workspace_id,name,type,encrypted_value) values
    ('s1','rotate-ws','one','token',${secret}), ('s2','rotate-ws','two','token',${secret})`;
  await sql`insert into workspace_connectors (id,workspace_id,type,name,credentials_encrypted) values
    ('c1','rotate-ws','test','Connector',${credential})`;
  await sql`insert into mcp_service_connections (id,user_id,name,url,transport,auth_type,credentials_encrypted)
    values ('m1','rotate-user','MCP','https://example.com','streamable-http','header-token',${credential})`;
  await sql`insert into webhooks (id,user_id,url,secret) values
    ('h1','rotate-user','https://example.com','plaintext webhook secret')`;
  await sql`update organizations set sso_config = ${sql.json({ clientSecret: "plaintext sso secret", enabled: false })} where id='rotate-org'`;
  for (const key of keys) {
    vi.stubEnv(key, newKey);
    vi.stubEnv(`${key}_ID`, "a_b"); // Must not match the old axb ID as a LIKE wildcard.
    vi.stubEnv(`${key}_PREVIOUS_KEYS`, JSON.stringify({ axb: oldKey }));
  }
  const dry = await rotateStoredSecrets(sql, { apply: false, limit: 1 });
  expect(dry.map((r) => r.candidates)).toEqual([1, 1, 1, 1, 1]);
  expect(dry.every((r) => r.updated === 0)).toBe(true);
  expect((await sql`select encrypted_value from workspace_secrets where id='s1'`)[0]!.encrypted_value).toBe(secret);
  const applied = await rotateStoredSecrets(sql, { apply: true, limit: 1 });
  expect(applied.map((r) => r.updated)).toEqual([1, 1, 1, 1, 1]);
  expect((await rotateStoredSecrets(sql, { apply: true, limit: 1 }))[0]!.updated).toBe(1);
  expect((await rotateStoredSecrets(sql, { apply: false, limit: 1 })).every((r) => r.candidates === 0)).toBe(true);
  for (const key of keys) vi.stubEnv(`${key}_PREVIOUS_KEYS`, "{}");
  expect(openSecret(keys[0]!, String((await sql`select secret from webhooks where id='h1'`)[0]!.secret))).toBe("plaintext webhook secret");
  expect(openSecret(keys[1]!, String((await sql`select credentials_encrypted from mcp_service_connections where id='m1'`)[0]!.credentials_encrypted))).toBe('{"token":"credential"}');
  const org = (await sql`select sso_config from organizations where id='rotate-org'`)[0]!.sso_config as Record<string, unknown>;
  expect(org.clientSecret).toBeNull();
  expect(org.enabled).toBe(false);
  expect(openSecret(keys[0]!, String(org.clientSecretEncrypted))).toBe("plaintext sso secret");
  await expect(rotateStoredSecrets(sql, { apply: true, limit: 10001 })).rejects.toThrow(/limit/);
});


it("preserves a concurrent credential edit instead of overwriting it", async () => {
  for (const key of keys) {
    vi.stubEnv(key, oldKey);
    vi.stubEnv(`${key}_ID`, "old");
    vi.stubEnv(`${key}_PREVIOUS_KEYS`, "{}");
  }
  const old = sealSecret(keys[0]!, "before concurrent edit");
  await sql`insert into workspace_secrets (id,workspace_id,name,type,encrypted_value)
    values ('race','rotate-ws','race','token',${old})`;
  for (const key of keys) {
    vi.stubEnv(key, newKey);
    vi.stubEnv(`${key}_ID`, "new");
    vi.stubEnv(`${key}_PREVIOUS_KEYS`, JSON.stringify({ old: oldKey, a_b: newKey }));
  }
  const concurrent = sealSecret(keys[0]!, "concurrent edit");
  let intercepted = false;
  const racingSql = new Proxy(sql, {
    apply(target, thisArg, args) {
      const template = args[0];
      if (!intercepted && Array.isArray(template) && String(template[0]).startsWith("update ")) {
        intercepted = true;
        return sql`update workspace_secrets set encrypted_value=${concurrent} where id='race'`
          .then(() => Reflect.apply(target, thisArg, args));
      }
      return Reflect.apply(target, thisArg, args);
    }
  });
  const result = await rotateStoredSecrets(racingSql, { apply: true, limit: 1 });
  expect(result[0]!.conflicts).toBe(1);
  expect(result[0]!.updated).toBe(0);
  expect((await sql`select encrypted_value from workspace_secrets where id='race'`)[0]!.encrypted_value).toBe(concurrent);
});
