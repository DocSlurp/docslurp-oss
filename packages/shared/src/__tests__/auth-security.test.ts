import { describe, expect, it } from "vitest";

import { BETTER_AUTH_CLIENT_IP_HEADER, resolveBetterAuthBaseUrl, createBetterAuthSecurityOptions } from "../auth-security.js";

describe("email authentication policy", () => {
  it("uses the provider's verified email without requiring another local confirmation", () => {
    expect(createBetterAuthSecurityOptions({}).account.accountLinking).toEqual({
      enabled: true, disableImplicitLinking: false, allowDifferentEmails: false,
      requireLocalEmailVerified: false, trustedProviders: [],
    });
  });
  it.each([{}, { RESEND_API_KEY: "key" }, { EMAIL_FROM: "DocSlurp <auth@example.com>" }, { RESEND_API_KEY: " ", EMAIL_FROM: "sender@example.com" }])("disables registration without a complete sender configuration", env => {
    expect(createBetterAuthSecurityOptions(env).emailAndPassword).toEqual({ enabled: true, disableSignUp: true, requireEmailVerification: true });
  });
  it("requires verification when a sender is configured", () => {
    expect(createBetterAuthSecurityOptions({ RESEND_API_KEY: "key", EMAIL_FROM: "DocSlurp <auth@example.com>" }).emailAndPassword).toEqual({ enabled: true, disableSignUp: false, requireEmailVerification: true });
  });
});

describe("session revocation", () => {
  it("checks the session row on every request instead of trusting a cached session cookie", () => {
    expect(createBetterAuthSecurityOptions({}).session.cookieCache).toEqual({ enabled: false });
  });
});

describe("resolveBetterAuthBaseUrl", () => {
  it("prefers the explicit Better Auth URL", () => {
    expect(resolveBetterAuthBaseUrl({
      APP_URL: "https://app.example.com",
      BETTER_AUTH_URL: "https://auth.example.com",
    })).toBe("https://auth.example.com");
  });

  it("rejects localhost callback origins in production", () => {
    expect(() => resolveBetterAuthBaseUrl({
      NODE_ENV: "production",
      APP_URL: "http://localhost:4321",
    })).toThrow();
  });

  it("allows a plain loopback origin in production only with the explicit self-host opt-in", () => {
    const env = { NODE_ENV: "production", APP_URL: "http://localhost:8787" };
    expect(() => resolveBetterAuthBaseUrl(env)).toThrow();
    expect(resolveBetterAuthBaseUrl({ ...env, DOCSLURP_ALLOW_INSECURE_LOCAL_AUTH_ORIGIN: "true" })).toBe("http://localhost:8787");
    expect(() => resolveBetterAuthBaseUrl({ NODE_ENV: "production", APP_URL: "http://example.com", DOCSLURP_ALLOW_INSECURE_LOCAL_AUTH_ORIGIN: "true" })).toThrow();
  });

  it("accepts a public HTTPS app origin in production", () => {
    expect(resolveBetterAuthBaseUrl({
      NODE_ENV: "production",
      APP_URL: "https://docslurp.io",
    })).toBe("https://docslurp.io");
  });
});

describe("auth rate limits", () => {
  it("keys on the app-set client IP header only and stores counters in the database", () => {
    const options = createBetterAuthSecurityOptions({ NODE_ENV: "production", APP_URL: "https://docslurp.io" });
    expect(options.advanced.ipAddress.ipAddressHeaders).toEqual([BETTER_AUTH_CLIENT_IP_HEADER]);
    expect(options.rateLimit).toMatchObject({ enabled: true, storage: "database" });
  });
});
