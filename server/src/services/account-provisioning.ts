import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

type SessionUser = { id: string; name: string };

const shortId = (value: string, length = 8) => value.slice(0, Math.max(1, length));
const slugify = (value: string) => value.trim().toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export async function ensureUserAndOrganization(appDbPool: Pick<Pool, "query" | "connect">, user: SessionUser) {
  // Repeated sign-ins should not open a transaction or repeat no-op writes.
  // Keep the original bootstrap/owner-membership repair for incomplete accounts.
  // A deleted account (docs/data-deletion.md) is never re-bootstrapped, even
  // while a cached session cookie is still valid.
  const ready = await appDbPool.query<{ ready: boolean }>(`
    select (exists(select 1 from org_memberships where user_id = $1)
      and not exists (
        select 1 from organizations o
        where o.personal_owner_user_id = $1
          and not exists (select 1 from org_memberships om where om.org_id = o.id and om.user_id = $1)
      ))
      or exists(select 1 from "user" where id = $1 and deleted_at is not null) as ready
  `, [user.id]);
  if (ready.rows[0]?.ready === true) return;

  const client = await appDbPool.connect();

  try {
    await client.query('begin');

    const existingOrg = await client.query<{ id: string }>(
      `
        select o.id
        from organizations o
        join org_memberships om on om.org_id = o.id
        where om.user_id = $1
        order by o.is_personal desc, o.created_at asc
        limit 1
      `,
      [user.id]
    );

    if (existingOrg.rowCount === 0) {
      const orgId = randomUUID();
      const ownerLabel = user.name.trim().split(/\s+/)[0] || shortId(user.id, 6);
      // A shared name or user-ID prefix must not make another account fail sign-in.
      const slugBase = `${slugify(ownerLabel) || "org"}-${orgId}`;

      await client.query(
        `
          insert into organizations (
            id,
            name,
            slug,
            is_personal,
            personal_owner_user_id,
            created_by_user_id,
            credit_balance_cents
          )
          values ($1, $2, $3, true, $4, $4, 0)
          on conflict (personal_owner_user_id) do nothing
        `,
        [orgId, `${ownerLabel}'s Org`, slugBase, user.id]
      );
    }

    await client.query(
      `
        insert into org_memberships (org_id, user_id, role)
        select id, $1, 'owner'
        from organizations
        where personal_owner_user_id = $1
        on conflict (org_id, user_id) do nothing
      `,
      [user.id]
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

