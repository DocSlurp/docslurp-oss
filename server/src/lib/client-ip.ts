import { BETTER_AUTH_CLIENT_IP_HEADER } from "@docslurp/shared/auth-security";

/**
 * The client address as seen by our own edge, for rate limits and audit logs.
 * On Fly, `Fly-Client-IP` is set by the proxy and cannot be supplied by the
 * client. Elsewhere, the left end of `X-Forwarded-For` is whatever the client
 * sent, so we count `API_TRUSTED_PROXY_HOPS` (default 1) entries from the right.
 */
export function clientIpFromHeaders(header: (name: string) => string | null | undefined): string | null {
  if (process.env.FLY_APP_NAME) {
    const flyClientIp = header("fly-client-ip")?.trim();
    if (flyClientIp) return flyClientIp;
  }

  const forwarded = header("x-forwarded-for")?.split(",").map((hop) => hop.trim()).filter(Boolean);
  if (forwarded?.length) {
    const hops = Number(process.env.API_TRUSTED_PROXY_HOPS);
    const trustedHops = Number.isInteger(hops) && hops > 0 ? hops : 1;
    return forwarded[Math.max(0, forwarded.length - trustedHops)] ?? null;
  }

  return header("x-real-ip")?.trim() || null;
}

/**
 * Better Auth reads the client IP from this header only (see
 * `createBetterAuthSecurityOptions`). Clients can send it too, so every
 * request handed to Better Auth goes through `withTrustedAuthClientIp`, which
 * drops any supplied value and sets the edge-derived address instead.
 */
export const AUTH_CLIENT_IP_HEADER = BETTER_AUTH_CLIENT_IP_HEADER;

export function withTrustedAuthClientIp(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(AUTH_CLIENT_IP_HEADER);
  const ip = clientIpFromHeaders((name) => request.headers.get(name));
  if (ip) headers.set(AUTH_CLIENT_IP_HEADER, ip);
  return new Request(request, { headers });
}
