// Load the project .env first: a host application checks these origins at startup, and a value
// that only arrived later (from .env) would not be the one it checked.
import "../env.js";

/** Canonical public URLs never derive their origin from untrusted Host headers. */
export function mcpOrigin(_requestUrl: string): string {
  const configured = process.env.MCP_PUBLIC_URL || process.env.API_URL || process.env.APP_URL || process.env.BETTER_AUTH_URL;
  const origin = new URL(configured || (process.env.NODE_ENV === 'production' ? 'https://docslurp.io' : 'http://localhost:4321')).origin;
  if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) {
    throw new Error('MCP requires HTTPS');
  }
  return origin;
}

export const mcpResource = (url: string) => `${mcpOrigin(url)}/v1/mcp`;

/**
 * Origin the signed-in browser forms of the OAuth flow are posted from: the consent decision,
 * device approval and grant revocation. It is the issuer unless MCP_BROWSER_URL names another
 * origin, for deployments whose issuer host does not accept session cookies. A form post that
 * carries the session must come from exactly this origin; the issuer origin is then refused.
 *
 * Discovery metadata and `verification_uri` keep naming the issuer (released clients require every
 * endpoint on it); `mcpBrowserRedirect` sends page loads that arrive there to this origin.
 */
export function mcpBrowserOrigin(requestUrl: string): string {
  const configured = process.env.MCP_BROWSER_URL?.trim();
  if (!configured) return mcpOrigin(requestUrl);
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('MCP_BROWSER_URL must be an origin such as https://app.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('MCP_BROWSER_URL must be an http(s) origin');
  // One exact origin and nothing else: a list, credentials or a path would be read as some other origin.
  if (configured.replace(/\/$/, '') !== url.origin) throw new Error('MCP_BROWSER_URL must be a bare origin with no path, query or credentials');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('MCP requires HTTPS');
  return url.origin;
}

/** Startup check: a broken MCP_BROWSER_URL stops the server instead of failing each consent request. */
export function assertMcpBrowserOrigin(): void {
  if (process.env.MCP_BROWSER_URL?.trim()) mcpBrowserOrigin('');
}

/**
 * Where a page load for a signed-in OAuth page must go instead, or null to serve it here.
 * Discovery names the issuer, so clients open `/oauth/mcp/authorize` and `/oauth/mcp/device`
 * there; when the browser origin is another host, a request that arrived on the issuer host is
 * sent to the same path on the browser origin. The target origin is configuration, never the request.
 */
export function mcpBrowserRedirect(requestUrl: string): string | null {
  const browser = mcpBrowserOrigin(requestUrl);
  const issuer = mcpOrigin(requestUrl);
  if (browser === issuer) return null;
  const url = new URL(requestUrl);
  if (url.host !== new URL(issuer).host) return null;
  return `${browser}${url.pathname}${url.search}`;
}
