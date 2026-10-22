/** Browser/embed (client) keys: search-only and domain-restricted, safe to ship in page HTML. */
export const PUBLIC_API_KEY_PREFIX = "dslp_pub_";
/** Server keys: secrets for backends, CI and agents. Never send one to a browser. */
export const PRIVATE_API_KEY_PREFIX = "dslp_priv_";

export type ApiKeyKind = "public" | "private" | "legacy";

/** Classify a key by prefix. Keys issued before typed prefixes (`dslp_<hex>`) report "legacy". */
export function apiKeyKind(key: string): ApiKeyKind {
  if (key.startsWith(PUBLIC_API_KEY_PREFIX)) return "public";
  if (key.startsWith(PRIVATE_API_KEY_PREFIX)) return "private";
  return "legacy";
}

export class UnsafeApiKeyError extends Error {
  readonly name = "UnsafeApiKeyError";
  readonly code = "SERVER_KEY_IN_BROWSER";
}

const inBrowser = () => typeof window !== "undefined" && typeof document !== "undefined";

/**
 * Throw before a server key leaves a browser. Called by every SDK surface that can run
 * client-side, so a `dslp_priv_` key in a bundle fails loudly in development instead of
 * leaking in production.
 */
export function assertBrowserSafeApiKey(key: string | null | undefined, browser = inBrowser()): void {
  if (key && browser && apiKeyKind(key) !== "public") {
    throw new UnsafeApiKeyError(
      "DocSlurp server and legacy keys must never be used in browser code. Use a search-only, domain-restricted client key (dslp_pub_…), or call DocSlurp from your server.",
    );
  }
}

/** Refuse bearer transport over cleartext except explicit loopback development. */
export function assertSecureApiOrigin(value: string): void {
  // Empty origin is a relative same-origin client; Node fetch rejects relative URLs itself.
  if (!value) return;
  const url = new URL(value, typeof location !== "undefined" ? location.href : undefined);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("DocSlurp API URLs require HTTPS (HTTP is allowed only on localhost for development).");
  }
}
