/** Dependency-free pieces of the API rate limiter, shared with the chat concurrency cap. */

export type RateLimitCategory = "upload" | "search" | "chat-ai" | "read" | "write" | "webhook";

/**
 * The address a per-IP limit counts. IPv6 clients usually control a whole /64,
 * so an IPv6 address counts as its /64 prefix; rotating addresses inside it
 * does not escape the limit. IPv4 counts as the address, and an IPv4-mapped
 * IPv6 address (`::ffff:192.0.2.1`) as that same IPv4 address.
 */
export function rateLimitAddress(ip: string): string {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1]!;
  if (!value.includes(":") || value.includes(".")) return value;
  const [head = "", tail] = value.split("::", 2);
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function classifyRateLimitCategory(method: string, path: string): RateLimitCategory {
  const normalizedPath = path.replace(/\/+$/, "") || "/";
  const normalizedMethod = method.toUpperCase();

  if (normalizedPath.startsWith("/webhooks/")) return "webhook";
  if ((normalizedPath.startsWith("/v1/ingest") || normalizedPath === "/v1/uploads" || normalizedPath.startsWith("/v1/uploads/"))) return "upload";
  if (
    normalizedPath.startsWith("/v1/search/chat")
    || normalizedPath === "/v1/chat"
    || normalizedPath === "/v1/chat/completions"
    || /^\/v1\/workspaces\/[^/]+\/chat(?:\/|$)/.test(normalizedPath)
  ) {
    return "chat-ai";
  }
  if (
    normalizedPath.startsWith("/v1/search")
    || normalizedPath.startsWith("/v1/web/")
    || normalizedPath.startsWith("/v1/suggest")
    // Every search-compat adapter (Algolia, Meilisearch, Typesense, Pagefind) is a search.
    || normalizedPath === "/compat" || normalizedPath.startsWith("/compat/")
    || normalizedPath.startsWith("/v1/mcp")
    || /^\/v1\/workspaces\/[^/]+\/search(?:\/|$)/.test(normalizedPath)
  ) {
    return "search";
  }
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return "read";
  return "write";
}
