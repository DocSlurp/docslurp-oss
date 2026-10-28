import type { Pool } from "pg";

/**
 * First-touch signup attribution. The app sets the `ds_attr` cookie on a
 * visitor's first page view (external referrer, landing path, UTM tags); the
 * account-creation hook copies it onto `user_signup_attribution` once. The
 * cookie is visitor-controlled, so every field is treated as untrusted text:
 * parsed strictly, length-capped and only ever displayed to platform admins.
 */
export const ATTRIBUTION_COOKIE = "ds_attr";
/** The app's analytics consent cookie; attribution is analytics, so it needs `granted`. */
export const ANALYTICS_CONSENT_COOKIE = "docslurp_analytics";

export interface SignupAttribution {
  referrerHost: string | null;
  referrerUrl: string | null;
  landingPath: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  firstSeenAt: string | null;
}

const MAX_COOKIE_BYTES = 2048;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Strip control and format characters (bidi overrides, zero-width); keep printable text.
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function httpUrl(value: unknown): URL | null {
  const raw = text(value, 1024);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch { return null; }
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return null;
}

/**
 * Path only, never the query (tokens, emails). Signed-in surfaces collapse to
 * their first segment (`/app/invites/<token>` → `/app`), and long opaque
 * segments elsewhere become `:id`.
 */
export function landingPath(value: unknown): string | null {
  const raw = text(value, 1024);
  if (!raw?.startsWith("/") || raw.startsWith("//")) return null;
  const path = raw.split(/[?#]/)[0]!;
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "app" || segments[0] === "api" || segments[0] === "oauth") return `/${segments[0]}`;
  return `/${segments.slice(0, 4).map(segment => (segment.length >= 24 || /\d{6,}/.test(segment) ? ":id" : segment)).join("/")}`.slice(0, 256);
}

/** Decodes the `ds_attr` cookie value (URI-encoded JSON); null when absent or malformed. */
export function parseAttributionCookie(value: string | null | undefined): SignupAttribution | null {
  if (!value || value.length > MAX_COOKIE_BYTES) return null;
  let data: unknown;
  try { data = JSON.parse(decodeURIComponent(value)); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const referrer = httpUrl(record.r);
  // Keep only origin + path: query strings on referrers can carry tokens or PII.
  const referrerUrl = referrer ? `${referrer.origin}${referrer.pathname}`.slice(0, 512) : null;
  const landing = landingPath(record.l);
  const seen = typeof record.t === "number" && Number.isFinite(record.t) ? new Date(record.t) : null;
  const firstSeenAt = seen && seen.getTime() > Date.UTC(2024, 0, 1) && seen.getTime() <= Date.now() + 86_400_000 ? seen.toISOString() : null;
  const attribution: SignupAttribution = {
    referrerHost: referrer ? referrer.hostname.toLowerCase().slice(0, 253) : null,
    referrerUrl,
    landingPath: landing,
    utmSource: text(record.us, 128),
    utmMedium: text(record.um, 128),
    utmCampaign: text(record.uc, 128),
    utmTerm: text(record.ut, 128),
    utmContent: text(record.ux, 128),
    firstSeenAt,
  };
  const { firstSeenAt: _seen, ...fields } = attribution;
  return Object.values(fields).some(Boolean) ? attribution : null;
}

/** The request cookie header from a Better Auth endpoint context, if any. */
export function cookieHeaderFromAuthContext(ctx: unknown): string | null {
  const value = ctx as { headers?: Headers; request?: Request } | null | undefined;
  try {
    return value?.headers?.get?.("cookie") ?? value?.request?.headers?.get?.("cookie") ?? null;
  } catch { return null; }
}

/** Stores the first attribution for a new user; later calls never overwrite it. */
export async function recordSignupAttribution(pool: Pick<Pool, "query">, userId: string, cookieHeader: string | null): Promise<boolean> {
  // A cookie without analytics consent (planted, or left after withdrawal) is ignored.
  if (readCookie(cookieHeader, ANALYTICS_CONSENT_COOKIE) !== "granted") return false;
  const attribution = parseAttributionCookie(readCookie(cookieHeader, ATTRIBUTION_COOKIE));
  if (!attribution) return false;
  const result = await pool.query(
    `insert into user_signup_attribution
       (user_id, referrer_host, referrer_url, landing_path, utm_source, utm_medium, utm_campaign, utm_term, utm_content, first_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (user_id) do nothing`,
    [userId, attribution.referrerHost, attribution.referrerUrl, attribution.landingPath, attribution.utmSource,
      attribution.utmMedium, attribution.utmCampaign, attribution.utmTerm, attribution.utmContent, attribution.firstSeenAt],
  );
  return (result.rowCount ?? 0) > 0;
}
