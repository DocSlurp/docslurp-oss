/**
 * RFC 2606/6761 reserved names (`*.local`, `*.test`, `*.invalid`, `*.example`,
 * `localhost`, `example.com/net/org`). No mailbox there can receive mail, so
 * seed, e2e and agent accounts use them. Matches `docslurp_reserved_test_email`
 * in migration 0094.
 */
export function isReservedTestEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return /(^|\.)((test|example|invalid|localhost|local)|example\.(com|net|org))$/.test(domain);
}
