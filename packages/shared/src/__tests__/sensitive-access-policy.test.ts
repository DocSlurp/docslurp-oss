import { describe, expect, it } from "vitest";
import { sensitiveAccessWindowSeconds } from "../auth-security.js";

describe("sensitive account verification window", () => {
  it("defaults to ten minutes and reuses the bounded MFA reauth setting", () => {
    expect(sensitiveAccessWindowSeconds({})).toBe(600);
    expect(sensitiveAccessWindowSeconds({ MFA_REAUTH_MAX_AGE_SECONDS: "60" })).toBe(60);
    expect(sensitiveAccessWindowSeconds({ MFA_REAUTH_MAX_AGE_SECONDS: "3600" })).toBe(3600);
    for (const value of ["0", "59", "3601", "Infinity", "secret", "60.5"]) {
      expect(() => sensitiveAccessWindowSeconds({ MFA_REAUTH_MAX_AGE_SECONDS: value })).toThrow();
    }
  });
});
