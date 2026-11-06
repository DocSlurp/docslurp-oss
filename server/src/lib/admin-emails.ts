import type { Pool } from "pg";

/** Exact, case-insensitive email addresses; no domains or wildcard patterns. */
export function configuredAdminEmails(csv = process.env.ADMIN_EMAILS ?? ""): string[] {
  return [...new Set(csv.split(",").map(email => email.trim().toLowerCase()).filter(email => !email.includes("*") && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)))];
}

/*
 * ADMIN_EMAILS names platform operators (DocSlurp staff), a role separate from
 * every organization and workspace role. It is read, never written back: being
 * an operator does not change, and must never imply, a role inside a customer
 * organization. Operator tools authorize through isConfiguredAdminUser; a
 * customer organization decides who administers it. (Sign-in used to promote an
 * operator's memberships to admin in every organization they belonged to; that
 * handed operators write access to customer data and was removed.)
 */

/** Whether this verified, live user is a platform operator. Read-only. */
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

/** The same lookup for code that holds a postgres.js client rather than a pg Pool. */
export async function isConfiguredAdminUserSql(sql: { unsafe: (text: string, values: string[][] | string[]) => PromiseLike<unknown[]> }, userId: string): Promise<boolean> {
  return await isConfiguredAdminUser({
    query: (async (text: string, values: unknown[]) => ({ rows: await sql.unsafe(text, values as string[]) })) as unknown as Pool["query"],
  }, userId);
}
