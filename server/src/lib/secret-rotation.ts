import type { SqlClient } from "../db.js";
import { openSecret, sealSecret, validateEncryptionConfiguration } from "./encryption.js";

/** Fixed inventory of AES-GCM stores; SQL identifiers never come from CLI input. */
export const secretStores = [
  { table: "workspace_secrets", column: "encrypted_value", key: "SECRETS_ENCRYPTION_KEY", plaintext: false },
  { table: "workspace_connectors", column: "credentials_encrypted", key: "CREDENTIALS_ENCRYPTION_KEY", plaintext: false },
  { table: "mcp_service_connections", column: "credentials_encrypted", key: "CREDENTIALS_ENCRYPTION_KEY", plaintext: false },
  { table: "webhooks", column: "secret", key: "SECRETS_ENCRYPTION_KEY", plaintext: true },
] as const;

export function rotationPlaintext(key: string, value: string, allowPlaintext: boolean): string {
  if (allowPlaintext && !/^v\d+:/.test(value) && !/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]*$/i.test(value)) return value;
  return openSecret(key, value);
}

/** Each store scans at most limit candidates. Re-run until candidates=0 before retiring keys. */
export async function rotateStoredSecrets(sql: SqlClient, options: { apply: boolean; limit: number }) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10_000) throw new Error("limit must be 1..10000");
  for (const key of ["SECRETS_ENCRYPTION_KEY", "CREDENTIALS_ENCRYPTION_KEY"]) validateEncryptionConfiguration(key);
  const results: { store: string; candidates: number; updated: number; conflicts: number }[] = [];
  for (const store of secretStores) {
    const prefix = sealSecret(store.key, "").split(":").slice(0, 2).join(":") + ":";
    const rows = await sql<{ id: string; value: string }[]>`
      select id, ${sql(store.column)} as value from ${sql(store.table)}
      where ${sql(store.column)} <> '' and not starts_with(${sql(store.column)}, ${prefix})
      order by id limit ${options.limit}`;
    const result = { store: store.table, candidates: rows.length, updated: 0, conflicts: 0 };
    for (const row of rows) {
      const plaintext = rotationPlaintext(store.key, row.value, store.plaintext);
      if (!options.apply) continue;
      const replacement = sealSecret(store.key, plaintext);
      const changed = await sql`update ${sql(store.table)} set ${sql(store.column)} = ${replacement}
        where id = ${row.id} and ${sql(store.column)} = ${row.value} returning id`;
      if (changed.length) result.updated++; else result.conflicts++;
    }
    results.push(result);
  }
  const key = "SECRETS_ENCRYPTION_KEY";
  const prefix = sealSecret(key, "").split(":").slice(0, 2).join(":") + ":";
  const orgs = await sql<{ id: string; sso_config: Record<string, unknown> }[]>`
    select id, sso_config from organizations where
      coalesce(sso_config->>'clientSecret', '') <> '' or
      (coalesce(sso_config->>'clientSecretEncrypted', '') <> '' and not starts_with(sso_config->>'clientSecretEncrypted', ${prefix}))
    order by id limit ${options.limit}`;
  const result = { store: "organizations.sso_config", candidates: orgs.length, updated: 0, conflicts: 0 };
  for (const org of orgs) {
    const old = org.sso_config;
    const plaintext = typeof old.clientSecret === "string" && old.clientSecret
      ? old.clientSecret : openSecret(key, String(old.clientSecretEncrypted));
    if (!options.apply) continue;
    const replacement = { ...old, clientSecret: null, clientSecretEncrypted: sealSecret(key, plaintext) };
    const changed = await sql`update organizations set sso_config = ${sql.json(replacement as Parameters<typeof sql.json>[0])}
      where id = ${org.id} and sso_config = ${sql.json(old as Parameters<typeof sql.json>[0])} returning id`;
    if (changed.length) result.updated++; else result.conflicts++;
  }
  results.push(result);
  return results;
}
