import { sql } from "../db.js";
import type { ValidatedKey } from "./api-keys.js";

/** Recheck a long-lived stream without recording another HTTP request. */
export async function isApiKeyLive(key: ValidatedKey, scopes: string[]): Promise<boolean> {
  const [row] = await sql<{ allowed: boolean }[]>`
    select scopes && ${sql.array(scopes)}::text[] as allowed
    from api_keys
    where id = ${key.keyId} and user_id = ${key.userId}
      and org_id = ${key.orgId} and revoked_at is null
      and key_type = ${key.keyType}
      and exists (select 1 from org_memberships om
        where om.org_id = api_keys.org_id and om.user_id = api_keys.user_id)
  `;
  return row?.allowed === true;
}
