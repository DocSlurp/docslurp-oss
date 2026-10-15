import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";

import { sql } from "../db.js";

/**
 * SSO domain ownership verification.
 *
 * An org may only route sign-ins for, or accept SSO assertions from, an email
 * domain it has proven it controls by publishing a DNS TXT record:
 *
 *   _docslurp-verify.<domain>  TXT  "docslurp-verify=<token>"
 *
 * Policy:
 * - A domain can be verified by at most one org (partial unique index
 *   `sso_domains_verified_domain_key`). Other orgs may hold pending claims,
 *   which never grant anything.
 * - Public mailbox providers (see `publicEmailDomains`) and their subdomains
 *   can never be claimed.
 * - Verification does not expire. Changing the org's SSO domain starts a new
 *   claim; re-running verification refreshes `last_checked_at`, and a failed
 *   re-check is recorded in `last_error` without revoking the verification.
 */

export const domainVerificationRecordPrefix = "_docslurp-verify";
export const domainVerificationValuePrefix = "docslurp-verify=";

/** Shared/free mailbox providers: no single org can own these addresses. */
export const publicEmailDomains: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "google.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com",
  "hotmail.co.uk", "outlook.co.uk", "live.co.uk",
  "yahoo.com", "yahoo.co.uk", "yahoo.co.jp", "yahoo.fr", "yahoo.de", "ymail.com", "rocketmail.com",
  "aol.com", "aim.com",
  "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  "tutanota.com", "tutanota.de", "tuta.io", "tuta.com",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com", "email.com",
  "zoho.com", "zohomail.com",
  "yandex.com", "yandex.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
  "qq.com", "163.com", "126.com", "sina.com", "foxmail.com",
  "naver.com", "daum.net", "hanmail.net",
  "fastmail.com", "fastmail.fm", "hey.com", "duck.com", "mailbox.org", "posteo.de",
  "hushmail.com", "rediffmail.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net",
  "btinternet.com", "orange.fr", "free.fr", "laposte.net", "libero.it", "t-online.de",
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "temp-mail.org",
  "example.com", "example.org", "example.net", "localhost"
]);

const domainPattern = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function normalizeSsoDomain(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase().replace(/^@+/, "").replace(/\.$/, "");
  return trimmed ? trimmed : null;
}

export function isPublicEmailDomain(domain: string): boolean {
  const normalized = normalizeSsoDomain(domain) ?? "";
  for (const blocked of publicEmailDomains) {
    if (normalized === blocked || normalized.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

/** Returns an error message when the domain can never be claimed, else null. */
export function validateClaimableDomain(domain: string): string | null {
  if (!domainPattern.test(domain)) {
    return "emailDomain must be a valid domain name such as acme.com";
  }
  if (isPublicEmailDomain(domain)) {
    return "Public email providers can't be used as an SSO domain";
  }
  return null;
}

export function domainVerificationRecordName(domain: string): string {
  return `${domainVerificationRecordPrefix}.${domain}`;
}

export function domainVerificationRecordValue(token: string): string {
  return `${domainVerificationValuePrefix}${token}`;
}

export type TxtResolver = (hostname: string) => Promise<string[][]>;

let txtResolver: TxtResolver = resolveTxt;
const dnsTimeoutMs = Number.parseInt(process.env.SSO_DOMAIN_DNS_TIMEOUT_MS ?? "5000", 10);

/** Swap the DNS TXT resolver (tests). Pass null to restore node:dns. */
export function setTxtResolverForTests(resolver: TxtResolver | null): void {
  txtResolver = resolver ?? resolveTxt;
}

export async function lookupVerificationTxt(domain: string): Promise<{ found: boolean; values: string[]; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      txtResolver(domainVerificationRecordName(domain)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" })), dnsTimeoutMs);
      })
    ]);
    const values = records.map((chunks) => chunks.join("").trim());
    return { found: values.length > 0, values };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") {
      return { found: false, values: [], error: "TXT record not found" };
    }
    if (code === "ETIMEOUT") {
      return { found: false, values: [], error: "DNS lookup timed out" };
    }
    return { found: false, values: [], error: "DNS lookup failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SsoDomainRow {
  org_id: string;
  domain: string;
  verification_token: string;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}

export interface SsoDomainStatus {
  domain: string;
  status: "verified" | "pending";
  recordType: "TXT";
  recordName: string;
  recordValue: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export function toDomainStatus(row: SsoDomainRow): SsoDomainStatus {
  return {
    domain: row.domain,
    status: row.verified_at ? "verified" : "pending",
    recordType: "TXT",
    recordName: domainVerificationRecordName(row.domain),
    recordValue: domainVerificationRecordValue(row.verification_token),
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error
  };
}

export class SsoDomainConflictError extends Error {
  constructor() {
    super("This domain is already verified by another organization");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

export async function loadOrgSsoDomain(orgId: string, domain: string): Promise<SsoDomainRow | null> {
  const [row] = await sql<SsoDomainRow[]>`
    select org_id, domain, verification_token, verified_at::text, last_checked_at::text, last_error
    from sso_domains
    where org_id = ${orgId} and domain = ${domain}
    limit 1
  `;
  return row ?? null;
}

export async function isDomainVerifiedByOtherOrg(orgId: string, domain: string): Promise<boolean> {
  const [row] = await sql<{ org_id: string }[]>`
    select org_id
    from sso_domains
    where domain = ${domain} and verified_at is not null and org_id <> ${orgId}
    limit 1
  `;
  return Boolean(row);
}

/** Starts (or returns) this org's claim on a domain. */
export async function claimSsoDomain(orgId: string, domain: string, userId: string): Promise<SsoDomainRow> {
  if (await isDomainVerifiedByOtherOrg(orgId, domain)) {
    throw new SsoDomainConflictError();
  }
  const token = randomBytes(24).toString("base64url");
  const [row] = await sql<SsoDomainRow[]>`
    insert into sso_domains (org_id, domain, verification_token, created_by_user_id)
    values (${orgId}, ${domain}, ${token}, ${userId})
    on conflict (org_id, domain) do update set domain = excluded.domain
    returning org_id, domain, verification_token, verified_at::text, last_checked_at::text, last_error
  `;
  return row!;
}

/** Checks DNS for the org's pending claim and marks it verified on a match. */
export async function verifySsoDomain(orgId: string, domain: string): Promise<SsoDomainRow> {
  const claim = await loadOrgSsoDomain(orgId, domain);
  if (!claim) {
    throw new Error("Request verification for this domain first");
  }
  if (await isDomainVerifiedByOtherOrg(orgId, domain)) {
    throw new SsoDomainConflictError();
  }

  const expected = domainVerificationRecordValue(claim.verification_token);
  const lookup = await lookupVerificationTxt(domain);
  const matched = lookup.values.includes(expected);
  const lastError = matched
    ? null
    : (lookup.error ?? `TXT record found, but none equal ${expected}`);

  try {
    const [row] = await sql<SsoDomainRow[]>`
      update sso_domains
      set verified_at = case when ${matched} then coalesce(verified_at, now()) else verified_at end,
          last_checked_at = now(),
          last_error = ${lastError}
      where org_id = ${orgId} and domain = ${domain}
      returning org_id, domain, verification_token, verified_at::text, last_checked_at::text, last_error
    `;
    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new SsoDomainConflictError();
    throw error;
  }
}
