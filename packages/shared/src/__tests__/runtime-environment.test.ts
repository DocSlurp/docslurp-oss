import { describe, expect, it } from "vitest";
import { isDevelopmentEnvironment, isDevelopmentEnvSource, normalizeEnvSetting } from "../runtime-environment.js";

describe("runtime environment rule (#398)", () => {
  it("trims ASCII whitespace only and lower-cases ASCII letters only", () => {
    expect(normalizeEnvSetting(" \t Production\r\n")).toBe("production");
    expect(normalizeEnvSetting("\u00a0production")).toBe("\u00a0production");
    expect(normalizeEnvSetting("\ufeff")).toBe("\ufeff");
    expect(normalizeEnvSetting("dev elopment")).toBe("dev elopment");
    expect(normalizeEnvSetting(undefined)).toBe("");
  });

  it.each(["", " ", "\t", "development", "test", "Development", " TEST "])("NODE_ENV=%j is development", (value) => {
    expect(isDevelopmentEnvSource({ NODE_ENV: value })).toBe(true);
  });

  it.each(["production", " production", "Production", "staging", "preview", "\u00a0", "\ufeff", "\u00a0development", "dev elopment", "develop"])(
    "NODE_ENV=%j is not development",
    (value) => {
      expect(isDevelopmentEnvSource({ NODE_ENV: value })).toBe(false);
      expect(isDevelopmentEnvironment({ NODE_ENV: value })).toBe(false);
    },
  );

  it("a service profile is never development", () => {
    expect(isDevelopmentEnvSource({ NODE_ENV: "development", DOCSLURP_PROFILE: "service" })).toBe(false);
    expect(isDevelopmentEnvSource({ DOCSLURP_SERVICE_PROFILE: " Service " })).toBe(false);
    expect(isDevelopmentEnvSource({ NODE_ENV: "development", DOCSLURP_PROFILE: "selfhost" })).toBe(true);
  });
});
