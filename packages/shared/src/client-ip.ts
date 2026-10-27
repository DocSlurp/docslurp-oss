import { isIP } from "node:net";

import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from "./cloudflare-ips.js";

/**
 * Trusted-proxy client-IP resolution, shared by the server and the dashboard.
 *
 * Trust chain: the immediate peer is whatever our own edge reports
 * (`Fly-Client-IP` on Fly; the right-most `X-Forwarded-For` entry elsewhere).
 * A forwarded client header is read only when that peer is inside the
 * configured trusted-proxy set, so a request that reaches the origin directly
 * (for example the platform origin hostname) can never choose its own address.
 *
 * - `CF-Connecting-IP` is honoured only when the peer is a Cloudflare address.
 * - `X-Forwarded-For` is walked from the right, skipping trusted proxies; the
 *   first untrusted entry is the client.
 * - `True-Client-IP` is deliberately ignored: Cloudflare only sets it on some
 *   plans and passes a client-supplied value through otherwise.
 */

/** Set by the dashboard on in-process calls to the mounted server; never read from a network request. */
export const INTERNAL_CLIENT_IP_HEADER = "x-docslurp-resolved-client-ip";

export type ParsedIp = { family: 4 | 6; value: bigint; text: string };

const V4_MAPPED_PREFIX = 0xffffn;

function v4ToBigInt(text: string): bigint {
  return text.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function bigIntToV4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

function v6ToBigInt(canonical: string): bigint {
  const [head = "", tail] = canonical.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}

/** Validates one address (optionally bracketed, with a port or zone) and normalises it. IPv4-mapped IPv6 becomes IPv4. */
export function parseIp(raw: string | null | undefined): ParsedIp | null {
  let text = raw?.trim();
  if (!text || text.length > 80) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  text = text.replace(/%.*$/, "");

  const family = isIP(text);
  if (family === 4) {
    if (text.split(".").some((part) => part.length > 1 && part.startsWith("0"))) return null;
    return { family: 4, value: v4ToBigInt(text), text };
  }
  if (family === 6) {
    let canonical: string;
    try {
      canonical = new URL(`http://[${text}]`).hostname.slice(1, -1);
    } catch {
      return null;
    }
    const value = v6ToBigInt(canonical);
    if (value >> 32n === V4_MAPPED_PREFIX) {
      const v4 = value & 0xffffffffn;
      return { family: 4, value: v4, text: bigIntToV4(v4) };
    }
    return { family: 6, value, text: canonical };
  }
  return null;
}

export type IpRange = { family: 4 | 6; network: bigint; bits: number };

export function parseCidr(raw: string): IpRange | null {
  const [address, prefix, ...rest] = raw.trim().split("/");
  if (rest.length) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  const bits = prefix === undefined ? max : /^\d{1,3}$/.test(prefix) ? Number(prefix) : -1;
  if (bits < 0 || bits > max) return null;
  const hostBits = BigInt(max - bits);
  return { family: ip.family, network: (ip.value >> hostBits) << hostBits, bits };
}

export function ipInRange(ip: ParsedIp, range: IpRange): boolean {
  if (ip.family !== range.family) return false;
  const hostBits = BigInt((ip.family === 4 ? 32 : 128) - range.bits);
  return (ip.value >> hostBits) << hostBits === range.network;
}

export type TrustedProxies = {
  /** Cloudflare's published ranges, trusted to supply `CF-Connecting-IP`. */
  cloudflare: IpRange[];
  /** Other trusted proxies (CIDRs), trusted for the `X-Forwarded-For` walk only. */
  other: IpRange[];
  /** Entries that were not understood (ignored, never trusted). */
  invalid: string[];
};

export const NO_TRUSTED_PROXIES: TrustedProxies = { cloudflare: [], other: [], invalid: [] };

let cloudflareRanges: IpRange[] | null = null;
export function cloudflareIpRanges(): IpRange[] {
  cloudflareRanges ??= [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES].map((cidr) => parseCidr(cidr)!);
  return cloudflareRanges;
}

/** Parses a `TRUSTED_PROXIES` value: comma or space separated `cloudflare` keyword, CIDRs and bare addresses. */
export function parseTrustedProxies(spec: string | null | undefined): TrustedProxies {
  const result: TrustedProxies = { cloudflare: [], other: [], invalid: [] };
  for (const token of (spec ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)) {
    if (token.toLowerCase() === "cloudflare") {
      result.cloudflare = cloudflareIpRanges();
      continue;
    }
    const range = parseCidr(token);
    if (range) result.other.push(range);
    else result.invalid.push(token);
  }
  return result;
}

const proxyCache = new Map<string, TrustedProxies>();
/** `TRUSTED_PROXIES` from the environment, parsed once per distinct value. */
export function trustedProxiesFromEnv(env: Record<string, string | undefined> = process.env): TrustedProxies {
  const spec = env.TRUSTED_PROXIES?.trim() ?? "";
  if (!spec) return NO_TRUSTED_PROXIES;
  let parsed = proxyCache.get(spec);
  if (!parsed) {
    parsed = parseTrustedProxies(spec);
    if (parsed.invalid.length) console.warn(`[client-ip] ignoring unrecognised TRUSTED_PROXIES entries: ${parsed.invalid.join(", ")}`);
    proxyCache.set(spec, parsed);
  }
  return parsed;
}

export function isCloudflarePeer(ip: ParsedIp, proxies: TrustedProxies): boolean {
  return proxies.cloudflare.some((range) => ipInRange(ip, range));
}

export function isTrustedProxy(ip: ParsedIp, proxies: TrustedProxies): boolean {
  return isCloudflarePeer(ip, proxies) || proxies.other.some((range) => ipInRange(ip, range));
}

export type HeaderReader = (name: string) => string | null | undefined;

export type ClientIpOptions = {
  proxies?: TrustedProxies;
  /** True on Fly, where `Fly-Client-IP` is the immediate peer. Defaults to `FLY_APP_NAME` being set. */
  fly?: boolean;
  /** Proxy hops to count from the right of `X-Forwarded-For` when no trusted proxies are configured and not on Fly. */
  fallbackHops?: number;
};

function forwardedChain(header: HeaderReader): ParsedIp[] {
  const entries = header("x-forwarded-for")?.split(",") ?? [];
  const chain: ParsedIp[] = [];
  for (const entry of entries) {
    const ip = parseIp(entry);
    // An unparseable entry breaks the chain: nothing to its left can be trusted.
    if (!ip) {
      chain.length = 0;
      continue;
    }
    chain.push(ip);
  }
  return chain;
}

/**
 * The immediate peer as our own edge reports it, or null when unknown.
 * Fly: `Fly-Client-IP`. Elsewhere: the right-most `X-Forwarded-For` entry.
 */
export function immediatePeer(header: HeaderReader, options: ClientIpOptions = {}): ParsedIp | null {
  const fly = options.fly ?? Boolean(process.env.FLY_APP_NAME);
  if (fly) return parseIp(header("fly-client-ip"));
  const chain = forwardedChain(header);
  return chain.at(-1) ?? null;
}

/** True when the request's immediate peer is a configured trusted proxy. */
export function arrivedViaTrustedProxy(header: HeaderReader, options: ClientIpOptions = {}): boolean {
  const proxies = options.proxies ?? trustedProxiesFromEnv();
  const peer = immediatePeer(header, options);
  return peer ? isTrustedProxy(peer, proxies) : false;
}

/** The client address to use for rate limits, audit logs and abuse checks, or null when unknown. */
export function resolveClientIp(header: HeaderReader, options: ClientIpOptions = {}): string | null {
  const proxies = options.proxies ?? trustedProxiesFromEnv();
  const fly = options.fly ?? Boolean(process.env.FLY_APP_NAME);
  const trusting = proxies.cloudflare.length > 0 || proxies.other.length > 0;

  if (!fly && !trusting) {
    // No proxy configured: today's behaviour. The left of X-Forwarded-For is
    // client-supplied, so count trusted hops from the right.
    const chain = forwardedChain(header);
    if (chain.length) {
      const hops = options.fallbackHops && options.fallbackHops > 0 ? options.fallbackHops : 1;
      return chain[Math.max(0, chain.length - hops)]!.text;
    }
    return parseIp(header("x-real-ip"))?.text ?? null;
  }

  const peer = immediatePeer(header, { ...options, fly });
  if (!peer) return null;
  if (!isTrustedProxy(peer, proxies)) return peer.text;

  if (isCloudflarePeer(peer, proxies)) {
    const cf = parseIp(header("cf-connecting-ip"));
    if (cf) return cf.text;
  }

  const chain = forwardedChain(header);
  // On Fly the peer is not part of the chain; elsewhere it is its right-most entry.
  const walk = fly ? chain : chain.slice(0, -1);
  for (let index = walk.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxy(walk[index]!, proxies)) return walk[index]!.text;
  }
  return peer.text;
}

/** `resolveClientIp` configured from the environment (`TRUSTED_PROXIES`, `API_TRUSTED_PROXY_HOPS`, `FLY_APP_NAME`). */
export function resolveClientIpFromEnv(header: HeaderReader, env: Record<string, string | undefined> = process.env): string | null {
  const hops = Number(env.API_TRUSTED_PROXY_HOPS);
  return resolveClientIp(header, {
    proxies: trustedProxiesFromEnv(env),
    fly: Boolean(env.FLY_APP_NAME),
    fallbackHops: Number.isInteger(hops) && hops > 0 ? hops : 1,
  });
}

/** `REQUIRE_TRUSTED_PROXY=true` (hardening, default off). */
export function requireTrustedProxy(env: Record<string, string | undefined> = process.env): boolean {
  return env.REQUIRE_TRUSTED_PROXY?.trim().toLowerCase() === "true";
}

const INFRA_PATHS = new Set(["/health", "/ready", "/metrics", "/fly-scaler-metrics"]);

/**
 * Whether `REQUIRE_TRUSTED_PROXY` should refuse a request: it reached us from
 * a peer outside the trusted-proxy set. Requests with no public-edge peer on
 * Fly (health checks, the Prometheus scraper, private-network calls) and the
 * infrastructure probe paths are never refused.
 */
export function shouldRejectUntrustedPeer(path: string, header: HeaderReader, env: Record<string, string | undefined> = process.env): boolean {
  if (!requireTrustedProxy(env) || INFRA_PATHS.has(path)) return false;
  const options: ClientIpOptions = { proxies: trustedProxiesFromEnv(env), fly: Boolean(env.FLY_APP_NAME) };
  const peer = immediatePeer(header, options);
  if (!peer) return false;
  return !isTrustedProxy(peer, options.proxies!);
}
