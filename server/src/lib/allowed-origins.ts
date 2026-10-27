import { PUBLIC_SUFFIX_RULES } from "./public-suffix-data.js";

/**
 * Browser (client) API key origin allowlist entries.
 *
 * Entry forms, stored canonically:
 * - `example.com`                exactly that host, http or https, any port
 * - `*.example.com`              any subdomain of example.com (not the apex)
 * - `https://example.com`        that scheme only
 * - `example.com:8443`, `https://*.example.com:8443`  that port only
 *
 * Subdomains are admitted only by an explicit `*.` (a legacy leading `.` means
 * the same). A bare public suffix from the Public Suffix List, private
 * section included (`github.io`, `vercel.app`, `co.uk`, `com`)
 * would admit every tenant site on it, so it is refused when a key is saved
 * and never matches at request time.
 *
 * Origin and Referer can be forged by non-browser clients: this check stops
 * other sites from using a key in a visitor's browser, not a determined caller.
 */

export interface AllowedOriginEntry {
  scheme: "http" | "https" | null;
  wildcard: boolean;
  host: string;
  port: string | null;
}

const LOCAL_HOSTS = new Set(["localhost"]);

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

let rules: { normal: Set<string>; wildcard: Set<string>; exception: Set<string> } | null = null;

/** The vendored Public Suffix List (lib/public-suffix-data.ts, refreshed by scripts/update-public-suffix-list.mjs). */
function suffixRules() {
  if (rules) return rules;
  const parsed = { normal: new Set<string>(), wildcard: new Set<string>(), exception: new Set<string>() };
  for (const rule of PUBLIC_SUFFIX_RULES.split("\n")) {
    if (rule.startsWith("!")) parsed.exception.add(rule.slice(1));
    else if (rule.startsWith("*.")) parsed.wildcard.add(rule.slice(2));
    else parsed.normal.add(rule);
  }
  rules = parsed;
  return parsed;
}

/**
 * The public suffix of an ASCII host under the PSL algorithm (ICANN and
 * private rules, so `github.io`, `vercel.app`, `s3.us-east-1.amazonaws.com`
 * and `blob.core.windows.net` are suffixes). An unlisted TLD is its own suffix.
 */
export function publicSuffixOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const { normal, wildcard, exception } = suffixRules();
  let best = labels.at(-1) ?? "";
  for (let i = labels.length - 1; i >= 0; i--) {
    const candidate = labels.slice(i).join(".");
    if (exception.has(candidate)) return labels.slice(i + 1).join(".");
    if (normal.has(candidate)) best = candidate;
    const parent = labels.slice(i + 1).join(".");
    if (i < labels.length - 1 && wildcard.has(parent)) best = candidate;
  }
  return best;
}

/** True when the host is a public suffix (or a single label), so it names no single owner. */
export function isPublicSuffixHost(host: string): boolean {
  const value = host.toLowerCase().replace(/\.$/, "");
  if (LOCAL_HOSTS.has(value) || isIpLiteral(value)) return false;
  if (!value.includes(".")) return true;
  return publicSuffixOf(value) === value;
}

export class AllowedOriginError extends Error {}

/** Parses one entry as typed or stored; throws AllowedOriginError when malformed. Does not check public suffixes. */
export function parseAllowedOriginEntry(value: string): AllowedOriginEntry {
  let rest = value.trim().toLowerCase();
  if (!rest) throw new AllowedOriginError("Allowed domains cannot be empty");
  let scheme: AllowedOriginEntry["scheme"] = null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//.exec(rest);
  if (schemeMatch) {
    if (schemeMatch[1] !== "http" && schemeMatch[1] !== "https") throw new AllowedOriginError(`Allowed domains must use http or https: ${value}`);
    scheme = schemeMatch[1];
    rest = rest.slice(schemeMatch[0].length);
  }
  let wildcard = false;
  if (rest.startsWith("*.")) { wildcard = true; rest = rest.slice(2); }
  else if (rest.startsWith(".")) { wildcard = true; rest = rest.slice(1); }
  // A single trailing slash (an origin copied from the address bar) is harmless.
  if (rest.endsWith("/") && !rest.endsWith("//")) rest = rest.slice(0, -1);
  if (rest.includes("*")) throw new AllowedOriginError(`Only a leading "*." wildcard is supported: ${value}`);
  let parsed: URL;
  try {
    parsed = new URL(`${scheme ?? "https"}://${rest}`);
  } catch {
    throw new AllowedOriginError(`Invalid allowed domain: ${value}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/") || rest.includes("/")) {
    throw new AllowedOriginError(`Allowed domains must be hostnames only: ${value}`);
  }
  const host = parsed.hostname;
  if (!host) throw new AllowedOriginError(`Invalid allowed domain: ${value}`);
  // URL drops a port equal to the scheme default; an explicit default port is kept as typed.
  const typedPort = /:(\d{1,5})$/.exec(rest)?.[1] ?? null;
  const port = typedPort !== null ? String(Number(typedPort)) : null;
  if (port !== null && (Number(port) < 1 || Number(port) > 65535)) throw new AllowedOriginError(`Invalid port: ${value}`);
  if (wildcard && isIpLiteral(host)) throw new AllowedOriginError(`Wildcards need a domain name: ${value}`);
  return { scheme, wildcard, host, port };
}

export function formatAllowedOriginEntry(entry: AllowedOriginEntry): string {
  return `${entry.scheme ? `${entry.scheme}://` : ""}${entry.wildcard ? "*." : ""}${entry.host}${entry.port ? `:${entry.port}` : ""}`;
}

/** Validates and canonicalizes an entry for storage; refuses public suffixes. */
export function normalizeAllowedOriginEntry(value: string): string {
  const entry = parseAllowedOriginEntry(value);
  if (isPublicSuffixHost(entry.host)) {
    throw new AllowedOriginError(`"${value}" is a shared public suffix: every site on it would be allowed. Enter your own domain (for example docs.${entry.host === "com" ? "example.com" : `yourname.${entry.host}`}).`);
  }
  return formatAllowedOriginEntry(entry);
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "http:" ? "80" : url.protocol === "https:" ? "443" : "");
}

/**
 * Whether a request's Origin (or Referer) is admitted by stored entries.
 * Missing, `null`, unparsable and non-http(s) origins never match; nor does
 * an empty allowlist or an entry that is a public suffix.
 */
export function originMatchesAllowlist(requestValue: string | null | undefined, entries: readonly string[]): boolean {
  const trimmed = requestValue?.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || entries.length === 0) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!host) return false;
  const scheme = url.protocol.slice(0, -1);
  const port = effectivePort(url);
  return entries.some((raw) => {
    let entry: AllowedOriginEntry;
    try {
      entry = parseAllowedOriginEntry(raw);
    } catch {
      return false;
    }
    if (isPublicSuffixHost(entry.host)) return false;
    if (entry.scheme && entry.scheme !== scheme) return false;
    if (entry.port && entry.port !== port) return false;
    return entry.wildcard ? host.endsWith(`.${entry.host}`) : host === entry.host;
  });
}
