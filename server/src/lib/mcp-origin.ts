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
