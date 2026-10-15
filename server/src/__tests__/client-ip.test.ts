import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_CLIENT_IP_HEADER, withTrustedAuthClientIp } from "../lib/client-ip.js";

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
