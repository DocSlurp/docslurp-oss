import { describe, expect, it } from "vitest";
import { magicLinkCallback, magicLinkLandingUrl } from "../lib/auth-magic-link.js";

describe("magic-link destinations", () => {
  it("defaults to the app and preserves safe app queries and anchors", () => {
    expect(magicLinkCallback(undefined)).toBe("/app");
    expect(magicLinkCallback("/app#sources")).toBe("/app#sources");
    expect(magicLinkCallback("/app/workspace?tab=files#page-2")).toBe("/app/workspace?tab=files#page-2");
    const landing = new URL(magicLinkLandingUrl("https://docslurp.example/api/auth/magic-link/verify?token=private&callbackURL=%2Fapp%23sources"));
    expect(landing.pathname).toBe("/auth/magic-link"); expect(landing.search).toBe("");
    expect(new URLSearchParams(landing.hash.slice(1)).get("callbackURL")).toBe("/app#sources");
  });
  it.each(["https://evil.invalid/app", "//evil.invalid/app", "/api/auth/sign-out", "/app/../api/auth/sign-out", "/app\\evil", "/application"])("rejects %s", value => {
    expect(() => magicLinkCallback(value)).toThrow();
  });
});
