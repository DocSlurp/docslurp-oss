import { randomUUID } from "node:crypto";

import { organizationSchema, type OrganizationRecord } from "@docslurp/shared";

import { appDbPool } from "../lib/auth.js";

type SessionUser = { id: string; name: string };

const shortId = (value: string, length = 8) => value.slice(0, Math.max(1, length));
const slugify = (value: string) => value.trim().toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

interface OrganizationRow {
  id: string;
  name: string;
  slug: string | null;
  is_personal: boolean;
  personal_owner_user_id: string | null;
  created_by_user_id: string | null;
  credit_balance_cents: number | string;
  member_role: OrganizationRecord["memberRole"];
  created_at: string;
  updated_at: string;
}


export async function ensureUserAndOrganization(user: SessionUser) {
  // Ordinary page reads should not open a transaction or repeat no-op writes.
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
      const slugBase = slugify(`${ownerLabel}-${shortId(user.id, 6)}`) || `org-${shortId(user.id, 6)}`;

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

export async function listOrganizations(userId: string) {
  const result = await appDbPool.query<OrganizationRow>(
    `
      select
        o.id,
        o.name,
        o.slug,
        o.is_personal,
        o.personal_owner_user_id,
        o.created_by_user_id,
        o.credit_balance_cents,
        om.role as member_role,
        o.created_at::text,
        o.updated_at::text
      from organizations o
      join org_memberships om on om.org_id = o.id
      where om.user_id = $1
      order by o.is_personal desc, o.created_at asc
    `,
    [userId]
  );

  return result.rows.map((row) =>
    organizationSchema.parse({
      id: row.id,
      name: row.name,
      slug: row.slug,
      isPersonal: row.is_personal,
      personalOwnerUserId: row.personal_owner_user_id,
      createdByUserId: row.created_by_user_id,
      creditBalanceCents: Number(row.credit_balance_cents),
      memberRole: row.member_role,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })
  );
}

