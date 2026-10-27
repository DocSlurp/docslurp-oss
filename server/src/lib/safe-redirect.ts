const sentinelOrigin = "https://redirect-origin.invalid";

/**
 * A same-origin path (`/path?query#hash`) from untrusted input, or `fallback`.
 *
 * `startsWith("/")` alone is not enough: WHATWG URL parsing treats `\` as `/`
 * and strips tabs/newlines, so `/\evil.example` or `/\t/evil.example` resolve
 * to another origin (SEC-2026-10-PROD-16). Backslashes and control characters
 * are rejected outright, and the resolved URL must stay on the base origin.
 */
export function safeRedirectPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(trimmed)) return fallback;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, sentinelOrigin);
  } catch {
    return fallback;
  }
  if (resolved.origin !== sentinelOrigin) return fallback;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
