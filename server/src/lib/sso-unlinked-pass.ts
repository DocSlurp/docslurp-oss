import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * "Unlinked SSO pass": lets one browser skip the enforce-SSO redirect for one
 * email after the IdP has proven that email has no DocSlurp link.
 *
 * `GET /api/sso-lookup` answers from the email's domain alone, so every
 * address at an enforce-SSO domain is sent to the IdP, linked or not (an
 * anonymous caller must not learn which mailboxes have linked accounts). A
 * password user who has not linked SSO yet is refused at the SSO callback; the
 * callback then sets this cookie, bound by HMAC to the IdP-asserted email, so
 * that user's next password sign-in from this browser is not bounced back to
 * the IdP. The per-user answer is only ever given to someone who has just
 * authenticated as that email at the IdP.
 */
export const SSO_UNLINKED_PASS_COOKIE = "docslurp.sso_unlinked";
export const SSO_UNLINKED_PASS_TTL_SECONDS = 15 * 60;

function passSignature(secret: string, email: string, expiresAt: number): string {
  return createHmac("sha256", secret)
    .update(`sso-unlinked-pass\n${email.trim().toLowerCase()}\n${expiresAt}`)
    .digest("base64url");
}

/** Cookie value `<expiresAtSeconds>.<hmac>`; the email itself is not stored. */
export function createSsoUnlinkedPass(secret: string, email: string, nowMs = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + SSO_UNLINKED_PASS_TTL_SECONDS;
  return `${expiresAt}.${passSignature(secret, email, expiresAt)}`;
}

/** True when `value` is an unexpired pass minted for `email`. */
export function hasValidSsoUnlinkedPass(secret: string, value: string | null | undefined, email: string, nowMs = Date.now()): boolean {
  if (!value) return false;
  const [expiresRaw, signature, ...rest] = value.split(".");
  if (rest.length || !expiresRaw || !signature || !/^\d+$/.test(expiresRaw)) return false;
  const expiresAt = Number(expiresRaw);
  if (expiresAt * 1000 <= nowMs) return false;
  const provided = Buffer.from(signature);
  const expected = Buffer.from(passSignature(secret, email, expiresAt));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Reads the pass from a raw `Cookie` header. */
export function ssoUnlinkedPassFromCookieHeader(header: string | null | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === SSO_UNLINKED_PASS_COOKIE) return part.slice(index + 1).trim();
  }
  return null;
}
