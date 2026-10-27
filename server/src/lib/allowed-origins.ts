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
 * the same). A bare public suffix (`github.io`, `vercel.app`, `co.uk`, `com`)
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

/**
 * Public suffixes (ICANN second-level registries and private hosting suffixes)
 * where unrelated parties own the sites below, curated from the Public Suffix
 * List. Single-label hosts (`com`, `io`, `app`) are refused separately.
 */
const PUBLIC_SUFFIXES = new Set([
  // ICANN second-level registries
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "com.br", "net.br", "org.br",
  "com.cn", "net.cn", "org.cn", "com.mx", "org.mx", "co.in", "net.in", "org.in", "firm.in",
  "co.za", "org.za", "com.tr", "com.sg", "com.hk", "com.tw", "com.ar", "com.co", "com.pe",
  "co.il", "org.il", "co.id", "or.id", "com.my", "com.ph", "com.vn", "com.ua", "com.pl", "co.th",
  "com.es", "com.pt", "co.at", "or.at", "com.ru", "com.sa", "com.eg", "com.ng", "co.ke",
  // Private hosting suffixes
  "github.io", "githubusercontent.com", "gitlab.io", "bitbucket.io", "vercel.app", "now.sh",
  "netlify.app", "netlify.com", "pages.dev", "workers.dev", "r2.dev", "trycloudflare.com",
  "herokuapp.com", "herokussl.com", "web.app", "firebaseapp.com", "appspot.com", "run.app",
  "cloudfunctions.net", "azurewebsites.net", "azurestaticapps.net", "cloudapp.net", "windows.net",
  "cloudfront.net", "amplifyapp.com", "elasticbeanstalk.com", "s3.amazonaws.com", "amazonaws.com",
  "onrender.com", "fly.dev", "railway.app", "up.railway.app", "deno.dev", "deno.net",
  "glitch.me", "repl.co", "replit.app", "replit.dev", "surge.sh", "ngrok.io", "ngrok.app",
  "ngrok-free.app", "ngrok.dev", "loca.lt", "blogspot.com", "wordpress.com", "wpcomstaging.com",
  "myshopify.com", "webflow.io", "framer.app", "framer.website", "wixsite.com", "squarespace.com",
  "codesandbox.io", "csb.app", "stackblitz.io", "webcontainer.io", "gitpod.io", "github.dev",
  "app.github.dev", "preview.app.github.dev", "readthedocs.io", "pythonanywhere.com",
  "digitaloceanspaces.com", "ondigitalocean.app", "supabase.co", "lovable.app",
  "carrd.co", "notion.site", "hashnode.dev", "substack.com", "medium.com",
]);

const LOCAL_HOSTS = new Set(["localhost"]);

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/** True when the host is a public suffix (or a single label), so it names no single owner. */
export function isPublicSuffixHost(host: string): boolean {
  const value = host.toLowerCase().replace(/\.$/, "");
  if (LOCAL_HOSTS.has(value) || isIpLiteral(value)) return false;
  if (!value.includes(".")) return true;
  return PUBLIC_SUFFIXES.has(value);
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
