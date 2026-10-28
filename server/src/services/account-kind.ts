import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { configuredAdminEmails } from "../lib/admin-emails.js";

/**
 * Account kinds keep staff and fake/agent-created accounts out of customer
 * metrics in the admin directory. They label analytics only and grant
 * nothing. Precedence: an admin's manual choice (source `admin`) is never
 * overwritten; otherwise reserved test domains (the migration 0094 insert
 * trigger), then TEST_ACCOUNT_EMAIL_PATTERNS, then verified staff
 * (ADMIN_EMAILS or STAFF_EMAIL_DOMAINS, default docslurp.io).
 */
export const ACCOUNT_KINDS = ["customer", "staff", "test"] as const;
export type AccountKind = typeof ACCOUNT_KINDS[number];

type Query = Pick<Pool, "query">;

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
}

export function staffEmailDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.STAFF_EMAIL_DOMAINS === undefined ? ["docslurp.io"] : csv(env.STAFF_EMAIL_DOMAINS);
}

/** `*` matches within the address; everything else is literal (`qa+*@gmail.com`, `*@mailinator.com`). */
export function testEmailPatterns(env: NodeJS.ProcessEnv = process.env): RegExp[] {
  return csv(env.TEST_ACCOUNT_EMAIL_PATTERNS).slice(0, 100)
    .map(pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^\\s]*")}$`));
}

/** Matches `docslurp_reserved_test_email` in migration 0094. */
export function isReservedTestEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return /(^|\.)((test|example|invalid|localhost|local)|example\.(com|net|org))$/.test(domain);
}

export function classifyEmail(email: string, emailVerified: boolean, env: NodeJS.ProcessEnv = process.env): { kind: AccountKind; reason: string } | null {
  const address = email.trim().toLowerCase();
  if (isReservedTestEmail(address)) return { kind: "test", reason: "reserved test email domain" };
  if (testEmailPatterns(env).some(pattern => pattern.test(address))) return { kind: "test", reason: "TEST_ACCOUNT_EMAIL_PATTERNS" };
  // Only a verified address proves staff; anyone can type a docslurp.io email at sign-up.
  if (!emailVerified) return null;
  if (configuredAdminEmails(env.ADMIN_EMAILS ?? "").includes(address)) return { kind: "staff", reason: "ADMIN_EMAILS" };
  const domain = address.split("@")[1] ?? "";
  if (staffEmailDomains(env).includes(domain)) return { kind: "staff", reason: "STAFF_EMAIL_DOMAINS" };
  return null;
}

/** Applies the rules to accounts nobody has classified by hand. Returns how many changed. */
export async function applyAccountKindRules(db: Query, userIds?: readonly string[]): Promise<number> {
  const { rows } = await db.query<{ id: string; email: string; verified: boolean; kind: AccountKind; source: string }>(
    `select id, email, "emailVerified" as verified, account_kind as kind, account_kind_source as source from "user"
     where deleted_at is null and account_kind_source <> 'admin' and ($1::text[] is null or id = any($1::text[]))`,
    [userIds ? [...userIds] : null],
  );
  let changed = 0;
  for (const row of rows) {
    const rule = classifyEmail(row.email, row.verified);
    const next = rule ?? { kind: "customer" as const, reason: null };
    // A rule that no longer matches (pattern removed) returns the account to customer.
    if (next.kind === row.kind && (rule ? row.source === "rule" : row.source === "default")) continue;
    const result = await db.query(
      `update "user" set account_kind = $2, account_kind_source = $3, account_kind_reason = $4
       where id = $1 and account_kind_source <> 'admin'`,
      [row.id, next.kind, rule ? "rule" : "default", next.reason],
    );
    changed += result.rowCount ?? 0;
  }
  return changed;
}

/** A platform admin's manual classification, audit-logged; `null` hands the account back to the rules. */
export async function setAccountKindByAdmin(db: Query, args: { adminUserId: string; userId: string; kind: AccountKind | null; reason?: string | null }): Promise<boolean> {
  const reason = args.reason?.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 200) || null;
  const result = args.kind === null
    ? await db.query(`update "user" set account_kind = 'customer', account_kind_source = 'default', account_kind_reason = null where id = $1 and deleted_at is null`, [args.userId])
    : await db.query(`update "user" set account_kind = $2, account_kind_source = 'admin', account_kind_reason = $3 where id = $1 and deleted_at is null`, [args.userId, args.kind, reason]);
  if (!result.rowCount) return false;
  if (args.kind === null) await applyAccountKindRules(db, [args.userId]);
  await db.query(
    `insert into audit_log (id, user_id, action, resource_type, resource_id, metadata) values ($1, $2, 'admin.account_kind.set', 'user', $3, ($4::text)::jsonb)`,
    [randomUUID(), args.adminUserId, args.userId, JSON.stringify({ kind: args.kind ?? "rules", reason })],
  );
  return true;
}
