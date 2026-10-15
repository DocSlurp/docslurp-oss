import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_CLIENT_IP_HEADER, IN_PROCESS_ENV_KEY, clientIpFromHeaders, withTrustedAuthClientIp } from "../lib/client-ip.js";

function authRequest(headers: Record<string, string>) {
  return new Request("https://docslurp.io/api/auth/sign-in/email", { method: "POST", headers, body: "{}" });
}

describe("withTrustedAuthClientIp", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses Fly-Client-IP on Fly and ignores spoofable client headers", async () => {
    vi.stubEnv("FLY_APP_NAME", "docslurp");
    const request = withTrustedAuthClientIp(authRequest({
      "fly-client-ip": "198.51.100.7",
      "cf-connecting-ip": "203.0.113.1",
      "x-real-ip": "203.0.113.2",
      "x-forwarded-for": "203.0.113.3, 198.51.100.7",
      [AUTH_CLIENT_IP_HEADER]: "203.0.113.4",
    }));
    expect(request.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("198.51.100.7");
    expect(await request.text()).toBe("{}");
  });

  it("takes the right-hand forwarded hop off Fly", () => {
    vi.stubEnv("FLY_APP_NAME", "");
    const request = withTrustedAuthClientIp(authRequest({ "x-forwarded-for": "203.0.113.3, 192.0.2.10" }));
    expect(request.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("192.0.2.10");
  });

  it("drops a client-supplied header when no trusted address exists", () => {
    vi.stubEnv("FLY_APP_NAME", "");
    const request = withTrustedAuthClientIp(authRequest({ [AUTH_CLIENT_IP_HEADER]: "203.0.113.4" }));
    expect(request.headers.get(AUTH_CLIENT_IP_HEADER)).toBeNull();
  });
});

describe("trusted proxies (Cloudflare in front of Fly)", () => {
  afterEach(() => vi.unstubAllEnvs());

  function behindCloudflare() {
    vi.stubEnv("FLY_APP_NAME", "docslurp");
    vi.stubEnv("TRUSTED_PROXIES", "cloudflare");
  }

  it("hands Better Auth the Cloudflare-reported visitor, not the edge", () => {
    behindCloudflare();
    const request = withTrustedAuthClientIp(authRequest({
      "fly-client-ip": "172.69.10.1",
      "cf-connecting-ip": "203.0.113.50",
      [AUTH_CLIENT_IP_HEADER]: "6.6.6.6",
    }));
    expect(request.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("203.0.113.50");
  });

  it("ignores a spoofed CF-Connecting-IP sent straight to the origin", () => {
    behindCloudflare();
    const request = withTrustedAuthClientIp(authRequest({ "fly-client-ip": "198.51.100.7", "cf-connecting-ip": "203.0.113.50" }));
    expect(request.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("198.51.100.7");
  });

  it("honours the internal resolved-IP header only for trusted in-process calls", () => {
    behindCloudflare();
    const headers: Record<string, string> = { "x-docslurp-resolved-client-ip": "203.0.113.50", "fly-client-ip": "198.51.100.7" };
    const read = (name: string) => headers[name];
    expect(clientIpFromHeaders(read)).toBe("198.51.100.7");
    expect(clientIpFromHeaders(read, { trustedInternal: true })).toBe("203.0.113.50");
    expect(IN_PROCESS_ENV_KEY).toBe("docslurpInProcess");
  });

  it("with no TRUSTED_PROXIES on Fly keeps today's behaviour (the peer)", () => {
    vi.stubEnv("FLY_APP_NAME", "docslurp");
    vi.stubEnv("TRUSTED_PROXIES", "");
    expect(clientIpFromHeaders((name) => ({ "fly-client-ip": "104.16.1.1", "cf-connecting-ip": "203.0.113.50" } as Record<string, string>)[name])).toBe("104.16.1.1");
  });

  it("requestIp trusts the internal header only when the mount sets the in-process env flag", async () => {
    behindCloudflare();
    const { requestIp } = await import("../lib/request-context.js");
    const app = new Hono().get("/", (c) => c.text(requestIp(c) ?? "none"));
    const headers = { "fly-client-ip": "198.51.100.7", "x-docslurp-resolved-client-ip": "203.0.113.50" };
    expect(await (await app.request("/", { headers })).text()).toBe("198.51.100.7");
    expect(await (await app.fetch(new Request("https://x/", { headers }), { [IN_PROCESS_ENV_KEY]: true })).text()).toBe("203.0.113.50");
  });
});
