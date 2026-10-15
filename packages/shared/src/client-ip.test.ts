import { describe, expect, it } from "vitest";

import { CLOUDFLARE_IPS_FETCHED_ON, CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from "./cloudflare-ips.js";
import {
  parseCidr,
  parseIp,
  parseTrustedProxies,
  resolveClientIp,
  shouldRejectUntrustedPeer,
} from "./client-ip.js";

const reader = (headers: Record<string, string>) => (name: string) => headers[name.toLowerCase()] ?? null;
const cloudflare = parseTrustedProxies("cloudflare");
const CF_EDGE = "104.16.1.1";
const CF_EDGE_V6 = "2606:4700::1111";

describe("pinned Cloudflare ranges", () => {
  it("are well-formed, dated and parse as CIDRs", () => {
    expect(CLOUDFLARE_IPS_FETCHED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CLOUDFLARE_IPV4_RANGES.length).toBeGreaterThanOrEqual(10);
    expect(CLOUDFLARE_IPV6_RANGES.length).toBeGreaterThanOrEqual(5);
    for (const cidr of CLOUDFLARE_IPV4_RANGES) expect(parseCidr(cidr)?.family, cidr).toBe(4);
    for (const cidr of CLOUDFLARE_IPV6_RANGES) expect(parseCidr(cidr)?.family, cidr).toBe(6);
    expect(new Set([...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]).size).toBe(CLOUDFLARE_IPV4_RANGES.length + CLOUDFLARE_IPV6_RANGES.length);
  });
});

describe("parseIp", () => {
  it("validates and normalises v4, v6 and mapped addresses", () => {
    expect(parseIp("203.0.113.9")?.text).toBe("203.0.113.9");
    expect(parseIp(" 203.0.113.9:4433 ")?.text).toBe("203.0.113.9");
    expect(parseIp("[2001:DB8::1]:443")?.text).toBe("2001:db8::1");
    expect(parseIp("2001:0db8:0000:0000:0000:0000:0000:0001")?.text).toBe("2001:db8::1");
    expect(parseIp("::ffff:203.0.113.9")?.text).toBe("203.0.113.9");
    expect(parseIp("::ffff:cb00:7109")?.family).toBe(4);
    for (const bad of ["", "unknown", "999.1.1.1", "1.2.3", "01.2.3.4", "<script>", "1.2.3.4, 5.6.7.8"]) expect(parseIp(bad), bad).toBeNull();
  });
});

describe("resolveClientIp on Fly", () => {
  const fly = { fly: true, proxies: cloudflare };

  it("ignores CF-Connecting-IP and X-Forwarded-For from an untrusted peer (direct fly.dev access)", () => {
    const ip = resolveClientIp(reader({ "fly-client-ip": "198.51.100.7", "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }), fly);
    expect(ip).toBe("198.51.100.7");
  });

  it("uses CF-Connecting-IP when the peer is Cloudflare (v4 and v6 edges)", () => {
    expect(resolveClientIp(reader({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": "203.0.113.50" }), fly)).toBe("203.0.113.50");
    expect(resolveClientIp(reader({ "fly-client-ip": CF_EDGE_V6, "cf-connecting-ip": "2001:db8::5" }), fly)).toBe("2001:db8::5");
    expect(resolveClientIp(reader({ "fly-client-ip": `::ffff:${CF_EDGE}`, "cf-connecting-ip": "::ffff:203.0.113.50" }), fly)).toBe("203.0.113.50");
  });

  it("falls back to the peer when Cloudflare sends a missing or malformed header, and ignores True-Client-IP", () => {
    expect(resolveClientIp(reader({ "fly-client-ip": CF_EDGE }), fly)).toBe(CF_EDGE);
    expect(resolveClientIp(reader({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": "nope", "true-client-ip": "9.9.9.9" }), fly)).toBe(CF_EDGE);
  });

  it("walks X-Forwarded-For from the right for non-Cloudflare trusted CIDRs, never trusting CF-Connecting-IP from them", () => {
    const proxies = parseTrustedProxies("cloudflare, 10.0.0.0/8, fd00::/8");
    const headers = { "fly-client-ip": "10.1.2.3", "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "6.6.6.6, 203.0.113.77, 10.9.9.9" };
    expect(resolveClientIp(reader(headers), { fly: true, proxies })).toBe("203.0.113.77");
    expect(resolveClientIp(reader({ "fly-client-ip": "10.1.2.3" }), { fly: true, proxies })).toBe("10.1.2.3");
    expect(resolveClientIp(reader({ "fly-client-ip": "fd00::9", "x-forwarded-for": "2001:db8::2" }), { fly: true, proxies })).toBe("2001:db8::2");
  });

  it("returns null without a Fly peer rather than trusting forwarded headers", () => {
    expect(resolveClientIp(reader({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "1.1.1.1" }), fly)).toBeNull();
  });

  it("with no trusted proxies behaves as before: the peer", () => {
    expect(resolveClientIp(reader({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": "203.0.113.50" }), { fly: true })).toBe(CF_EDGE);
  });
});

describe("resolveClientIp off Fly", () => {
  it("self-host default: right-most X-Forwarded-For hop, hop count honoured, x-real-ip last", () => {
    expect(resolveClientIp(reader({ "x-forwarded-for": "6.6.6.6, 192.0.2.10" }), { fly: false })).toBe("192.0.2.10");
    expect(resolveClientIp(reader({ "x-forwarded-for": "6.6.6.6, 203.0.113.4, 192.0.2.10" }), { fly: false, fallbackHops: 2 })).toBe("203.0.113.4");
    expect(resolveClientIp(reader({ "x-real-ip": "192.0.2.1", "cf-connecting-ip": "6.6.6.6" }), { fly: false })).toBe("192.0.2.1");
    expect(resolveClientIp(reader({ "cf-connecting-ip": "6.6.6.6" }), { fly: false })).toBeNull();
  });

  it("Cloudflare then a local proxy: skips trusted hops to the first untrusted entry", () => {
    const proxies = parseTrustedProxies("cloudflare,127.0.0.1");
    expect(resolveClientIp(reader({ "x-forwarded-for": `6.6.6.6, 203.0.113.4, ${CF_EDGE}, 127.0.0.1` }), { fly: false, proxies })).toBe("203.0.113.4");
    // The proxy's immediate peer is the right-most entry; an untrusted one is the client itself.
    expect(resolveClientIp(reader({ "x-forwarded-for": "6.6.6.6, 198.51.100.8" }), { fly: false, proxies })).toBe("198.51.100.8");
  });

  it("a Cloudflare peer at the right of X-Forwarded-For makes CF-Connecting-IP trusted", () => {
    const proxies = parseTrustedProxies("cloudflare");
    expect(resolveClientIp(reader({ "x-forwarded-for": CF_EDGE, "cf-connecting-ip": "203.0.113.50" }), { fly: false, proxies })).toBe("203.0.113.50");
    expect(resolveClientIp(reader({ "x-forwarded-for": "198.51.100.8", "cf-connecting-ip": "203.0.113.50" }), { fly: false, proxies })).toBe("198.51.100.8");
  });
});

describe("TRUSTED_PROXIES parsing", () => {
  it("accepts keyword, CIDRs and bare addresses; flags junk without trusting it", () => {
    const parsed = parseTrustedProxies("cloudflare 10.0.0.0/8,192.0.2.1, bogus, 1.2.3.4/99");
    expect(parsed.cloudflare.length).toBeGreaterThan(10);
    expect(parsed.other).toHaveLength(2);
    expect(parsed.invalid).toEqual(["bogus", "1.2.3.4/99"]);
  });
});

describe("REQUIRE_TRUSTED_PROXY gate", () => {
  const env = { FLY_APP_NAME: "docslurp-app", TRUSTED_PROXIES: "cloudflare", REQUIRE_TRUSTED_PROXY: "true" };
  it("is off by default", () => {
    expect(shouldRejectUntrustedPeer("/", reader({ "fly-client-ip": "198.51.100.7" }), { ...env, REQUIRE_TRUSTED_PROXY: undefined })).toBe(false);
  });
  it("rejects direct hits, allows Cloudflare, health paths and private-network requests", () => {
    expect(shouldRejectUntrustedPeer("/", reader({ "fly-client-ip": "198.51.100.7" }), env)).toBe(true);
    expect(shouldRejectUntrustedPeer("/", reader({ "fly-client-ip": CF_EDGE }), env)).toBe(false);
    expect(shouldRejectUntrustedPeer("/health", reader({ "fly-client-ip": "198.51.100.7" }), env)).toBe(false);
    expect(shouldRejectUntrustedPeer("/fly-scaler-metrics", reader({}), env)).toBe(false);
    expect(shouldRejectUntrustedPeer("/", reader({}), env)).toBe(false);
  });
});
