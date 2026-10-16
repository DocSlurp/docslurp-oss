import type { Pool } from "pg";

/** Exact, case-insensitive email addresses; no domains or wildcard patterns. */
export function configuredAdminEmails(csv = process.env.ADMIN_EMAILS ?? ""): string[] {
  return [...new Set(csv.split(",").map(email => email.trim().toLowerCase()).filter(email => !email.includes("*") && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)))];
}

/** Admit verified identities and promote existing memberships, preserving owners. */
export async function admitConfiguredAdminUser(pool: Pick<Pool, "query">, userId: string): Promise<boolean> {
  const emails = configuredAdminEmails();
  if (!emails.length) return false;
  const result = await pool.query<{ is_admin: boolean }>(`
    with eligible as (
      select id from "user"
      where id = $1 and "emailVerified" = true and deleted_at is null
        and lower(trim(email)) = any($2::text[])
    ), promoted_orgs as (
      update org_memberships set role = 'admin'
      where user_id in (select id from eligible) and role not in ('owner', 'admin')
    ), promoted_workspaces as (
      update workspace_members set role = 'admin'
      where user_id in (select id from eligible) and role <> 'admin'
    )
    select exists(select 1 from eligible) as is_admin
  `, [userId, emails]);
  return result.rows[0]?.is_admin === true;
}

/** Read current admin eligibility without promoting memberships during requests. */
export async function isConfiguredAdminUser(pool: Pick<Pool, "query">, userId: string): Promise<boolean> {
  const emails = configuredAdminEmails();
  if (!emails.length) return false;
  const result = await pool.query<{ is_admin: boolean }>(`
    select exists (
      select 1 from "user"
      where id = $1 and "emailVerified" = true and deleted_at is null
        and lower(trim(email)) = any($2::text[])
    ) as is_admin
  `, [userId, emails]);
  return result.rows[0]?.is_admin === true;
}
