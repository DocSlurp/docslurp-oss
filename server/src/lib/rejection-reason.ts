import { createHash } from "node:crypto";

/** Longest reason telemetry keeps, applied after redaction so a cut never exposes half a secret. */
export const MAX_REJECTION_REASON_CHARS = 300;

/** Any scheme://… run up to whitespace, quotes or angle/curly brackets (parentheses can sit inside a path). */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>{}]+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const AUTHORIZATION_PATTERN = /\b(?:Bearer|Basic|Token)\s+[^\s,;"']+/gi;
/** Provider and DocSlurp key shapes: sk-…, sk_live_…, rk_…, pk_…, dslp_priv_…, ghp_…, xox…-… */
const KEY_PATTERN = /\b(?:sk|rk|pk|sk-or-v1|sk_live|sk_test|rk_live|rk_test|dslp_pub|dslp_priv|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{6,}/g;
/** name=value or name: value where the name says it is a credential or a signed-URL parameter. */
const SECRET_PAIR_PATTERN = /\b((?:[a-z0-9]+[_-])*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|auth|credential|credentials|session|cookie|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|se|sp|sv|skoid|sktid)\s*["']?\s*[:=]\s*["']?)[^\s,&;"'}]+/gi;
/** A long unbroken token is a grant, key or signature far more often than prose. */
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
/** Resource ids stay readable so a refusal can be correlated with its document, run or session. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `https://user:pw@files.example.com/grant/abc?sig=x` → `https://files.example.com`. */
function urlOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return url.host ? `${url.protocol}//${url.hostname}` : "[url]";
  } catch {
    return "[url]";
  }
}

/**
 * The reason telemetry may keep for an error response. Error text is
 * server-authored but often embeds request data: a fetched URL with an access
 * grant in its path, a signed URL, an email, a token. URLs keep only scheme
 * and host; credentials and signed-URL parameters are replaced. Redaction
 * runs first, then the cap.
 */
export function sanitizeRejectionReason(text: string): string {
  const redacted = text
    .replace(URL_PATTERN, urlOrigin)
    .replace(AUTHORIZATION_PATTERN, "[authorization redacted]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(KEY_PATTERN, "[key redacted]")
    .replace(SECRET_PAIR_PATTERN, "$1[redacted]")
    .replace(OPAQUE_TOKEN_PATTERN, token => (UUID_PATTERN.test(token) ? token : "[token redacted]"))
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > MAX_REJECTION_REASON_CHARS ? `${redacted.slice(0, MAX_REJECTION_REASON_CHARS - 1)}…` : redacted;
}

/**
 * A stable id for a refusal's reason: the code plus its sanitized text with
 * ids, numbers and hosts folded away, so the same refusal groups under one id
 * whatever document, session or size it named. Never derived from raw text.
 */
export function rejectionReasonId(code: string, sanitized: string): string {
  const template = sanitized
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "<n>");
  return createHash("sha256").update(`${code}\n${template}`).digest("hex").slice(0, 12);
}
