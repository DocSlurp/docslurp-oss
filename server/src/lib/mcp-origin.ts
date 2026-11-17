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
 * endpoint on it), so such a deployment redirects GET /oauth/mcp/authorize and /oauth/mcp/device
 * from the issuer host to this one.
 */
export function mcpBrowserOrigin(requestUrl: string): string {
  const configured = process.env.MCP_BROWSER_URL?.trim();
  if (!configured) return mcpOrigin(requestUrl);
  const url = new URL(configured);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('MCP_BROWSER_URL must be an http(s) origin');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('MCP requires HTTPS');
  return url.origin;
}
