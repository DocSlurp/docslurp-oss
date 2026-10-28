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

/**
 * `*` matches any run of characters; everything else is literal (`qa+*@gmail.com`,
 * `*@mailinator.com`). Matched by ordered substring search, not a regex, so a
 * pattern full of stars stays linear against any address.
 */
export function testEmailPatterns(env: NodeJS.ProcessEnv = process.env): string[][] {
  return csv(env.TEST_ACCOUNT_EMAIL_PATTERNS).slice(0, 100).map(pattern => pattern.split("*"));
}

export function globMatches(parts: readonly string[], value: string): boolean {
  if (parts.length === 1) return value === parts[0];
  const first = parts[0]!, last = parts[parts.length - 1]!;
  if (value.length < first.length + last.length || !value.startsWith(first) || !value.endsWith(last)) return false;
  let at = first.length;
  const end = value.length - last.length;
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const found = value.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/** Matches `docslurp_reserved_test_email` in migration 0094. */
export function isReservedTestEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return /(^|\.)((test|example|invalid|localhost|local)|example\.(com|net|org))$/.test(domain);
}

export interface AccountKindRules { patterns: string[][]; staffDomains: string[]; adminEmails: string[] }

/** Read the env once per batch, not once per address. */
export function accountKindRules(env: NodeJS.ProcessEnv = process.env): AccountKindRules {
  return { patterns: testEmailPatterns(env), staffDomains: staffEmailDomains(env), adminEmails: configuredAdminEmails(env.ADMIN_EMAILS ?? "") };
}

export function classifyEmail(email: string, emailVerified: boolean, rules: AccountKindRules | NodeJS.ProcessEnv = process.env): { kind: AccountKind; reason: string } | null {
  const compiled = "patterns" in rules && Array.isArray(rules.patterns) ? rules as AccountKindRules : accountKindRules(rules as NodeJS.ProcessEnv);
  const address = email.trim().toLowerCase();
  if (isReservedTestEmail(address)) return { kind: "test", reason: "reserved test email domain" };
  if (compiled.patterns.some(parts => globMatches(parts, address))) return { kind: "test", reason: "TEST_ACCOUNT_EMAIL_PATTERNS" };
  // Only a verified address proves staff; anyone can type a docslurp.io email at sign-up.
  if (!emailVerified) return null;
  if (compiled.adminEmails.includes(address)) return { kind: "staff", reason: "ADMIN_EMAILS" };
  if (compiled.staffDomains.includes(address.split("@")[1] ?? "")) return { kind: "staff", reason: "STAFF_EMAIL_DOMAINS" };
  return null;
}

type Change = { id: string; kind: AccountKind; source: "default" | "rule" | "admin"; reason: string | null };

/**
 * Writes classification changes in one statement (all or nothing). Rules never
 * overwrite a manual choice, even one made after they read the row; only an
 * admin's own single-user change (`overrideManual`) may. When an admin acted,
 * the audit row is written in the same statement.
 */
async function writeChanges(db: Query, changes: Change[], audit: { adminUserId: string; action: string; resourceId: string | null; metadata: Record<string, unknown> } | null, overrideManual = false): Promise<number> {
  if (changes.length === 0 && !audit) return 0;
  const { rows } = await db.query<{ changed: number }>(
    `with changes as (
       select * from jsonb_to_recordset(($1::text)::jsonb) as c(id text, kind text, source text, reason text)
     ), updated as (
       update "user" u set account_kind = c.kind, account_kind_source = c.source, account_kind_reason = c.reason
       from changes c
       where u.id = c.id and u.deleted_at is null and (u.account_kind_source <> 'admin' or $2::boolean)
       returning u.id
     ), audited as (
       insert into audit_log (id, user_id, action, resource_type, resource_id, metadata)
       select $3, $4, $5, 'user', $6, ($7::text)::jsonb || jsonb_build_object('changed', (select count(*) from updated))
       where $4::text is not null
     )
     select count(*)::int as changed from updated`,
    [JSON.stringify(changes), overrideManual, randomUUID(), audit?.adminUserId ?? null, audit?.action ?? null, audit?.resourceId ?? null, JSON.stringify(audit?.metadata ?? {})],
  );
  return rows[0]?.changed ?? 0;
}

function ruleChange(row: { id: string; email: string; verified: boolean; kind: AccountKind; source: string }, rules: AccountKindRules): Change | null {
  const rule = classifyEmail(row.email, row.verified, rules);
  const next: Change = rule ? { id: row.id, kind: rule.kind, source: "rule", reason: rule.reason } : { id: row.id, kind: "customer", source: "default", reason: null };
  // A rule that no longer matches (pattern removed) returns the account to customer.
  return next.kind === row.kind && next.source === row.source ? null : next;
}

/**
 * Applies the rules to accounts nobody classified by hand, in one write.
 * Returns how many changed; `adminUserId` records a bulk re-run in the audit log.
 */
export async function applyAccountKindRules(db: Query, userIds?: readonly string[], adminUserId?: string): Promise<number> {
  const { rows } = await db.query<{ id: string; email: string; verified: boolean; kind: AccountKind; source: string }>(
    `select id, email, "emailVerified" as verified, account_kind as kind, account_kind_source as source from "user"
     where deleted_at is null and account_kind_source <> 'admin' and ($1::text[] is null or id = any($1::text[]))`,
    [userIds ? [...userIds] : null],
  );
  const rules = accountKindRules();
  const changes = rows.flatMap(row => ruleChange(row, rules) ?? []);
  return writeChanges(db, changes, adminUserId ? { adminUserId, action: "admin.account_kind.reclassify", resourceId: null, metadata: {} } : null);
}

/** A platform admin's manual classification, audit-logged atomically; `null` hands the account back to the rules. */
export async function setAccountKindByAdmin(db: Query, args: { adminUserId: string; userId: string; kind: AccountKind | null; reason?: string | null }): Promise<boolean> {
  const reason = args.reason?.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 200) || null;
  const { rows } = await db.query<{ id: string; email: string; verified: boolean }>(
    `select id, email, "emailVerified" as verified from "user" where id = $1 and deleted_at is null`, [args.userId]);
  const user = rows[0];
  if (!user) return false;
  const change: Change = args.kind === null
    ? (() => { const rule = classifyEmail(user.email, user.verified, accountKindRules());
        return rule ? { id: user.id, kind: rule.kind, source: "rule" as const, reason: rule.reason } : { id: user.id, kind: "customer" as const, source: "default" as const, reason: null }; })()
    : { id: user.id, kind: args.kind, source: "admin", reason };
  const changed = await writeChanges(db, [change], { adminUserId: args.adminUserId, action: "admin.account_kind.set", resourceId: user.id, metadata: { kind: args.kind ?? "rules", reason } }, true);
  return changed > 0;
}
