import { BETTER_AUTH_CLIENT_IP_HEADER } from "@docslurp/shared/auth-security";
import { INTERNAL_CLIENT_IP_HEADER, parseIp, resolveClientIpFromEnv } from "@docslurp/shared/client-ip";

/**
 * Hono `c.env` flag that only an in-process caller (the dashboard's
 * `apiApp.fetch(request, { [IN_PROCESS_ENV_KEY]: true })`) can set. A network
 * request cannot, so the internal client-IP header is honoured only for it.
 */
export const IN_PROCESS_ENV_KEY = "docslurpInProcess";

export function isInProcessEnv(env: unknown): boolean {
  return Boolean(env && typeof env === "object" && (env as Record<string, unknown>)[IN_PROCESS_ENV_KEY] === true);
}

/**
 * The client address for rate limits, audit logs and abuse checks. See
 * `@docslurp/shared/client-ip` for the trust chain: forwarded client headers
 * (`CF-Connecting-IP`, `X-Forwarded-For`) count only when the immediate peer
 * is in `TRUSTED_PROXIES`. `trustedInternal` is true for in-process calls from
 * the dashboard, which pass its already-resolved address in
 * `x-docslurp-resolved-client-ip`.
 */
export function clientIpFromHeaders(
  header: (name: string) => string | null | undefined,
  options: { trustedInternal?: boolean } = {},
): string | null {
  if (options.trustedInternal) {
    const internal = parseIp(header(INTERNAL_CLIENT_IP_HEADER));
    if (internal) return internal.text;
  }
  return resolveClientIpFromEnv(header);
}

/**
 * Better Auth reads the client IP from this header only (see
 * `createBetterAuthSecurityOptions`). Clients can send it too, so every
 * request handed to Better Auth goes through `withTrustedAuthClientIp`, which
 * drops any supplied value and sets the edge-derived address instead.
 */
export const AUTH_CLIENT_IP_HEADER = BETTER_AUTH_CLIENT_IP_HEADER;

export function withTrustedAuthClientIp(request: Request, options: { trustedInternal?: boolean } = {}): Request {
  const headers = new Headers(request.headers);
  headers.delete(AUTH_CLIENT_IP_HEADER);
  const ip = clientIpFromHeaders((name) => request.headers.get(name), options);
  if (ip) headers.set(AUTH_CLIENT_IP_HEADER, ip);
  return new Request(request, { headers });
}
