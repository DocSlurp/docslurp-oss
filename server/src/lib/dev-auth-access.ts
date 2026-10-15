import { isIP } from "node:net";

/** Development credentials are available only through local/private app origins. */
export function isDevSeedRequestAllowed(request: Request): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  let privateHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".ts.net");
  if (isIP(hostname) === 4) {
    const [a, b] = hostname.split(".").map(Number);
    privateHost = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  } else if (isIP(hostname) === 6) {
    privateHost = hostname === "::1" || /^(fc|fd)/.test(hostname);
  }
  if (!privateHost || request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  // Normal browser POSTs supply Origin; non-browser local requests can omit it.
  return origin === null || origin === url.origin;
}

export function developmentTrustedOrigins(configured: string[], request?: Request): string[] {
  if (!request || !isDevSeedRequestAllowed(request)) return configured;
  return [...new Set([...configured, new URL(request.url).origin])];
}
