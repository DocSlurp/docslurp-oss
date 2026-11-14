import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertNoUnsafeOverrides,
  requestedUnsafeOverrides,
  UNSAFE_OVERRIDES,
  unsafeOverrideEnabled,
  unsafeOverridesAllowed,
  UnsafeOverrideError,
} from "./unsafe-overrides.js";

// #398: development-only settings that weaken untrusted-file protection.
const REFUSED_ENVIRONMENTS: Array<[string, NodeJS.ProcessEnv]> = [
  ["production", { NODE_ENV: "production" }],
  ["production (padded, upper case)", { NODE_ENV: " Production " }],
  ["staging", { NODE_ENV: "staging" }],
  ["preview", { NODE_ENV: "preview" }],
  ["the service profile without NODE_ENV", { DOCSLURP_SERVICE_PROFILE: "service" }],
  ["the service profile in development", { NODE_ENV: "development", DOCSLURP_SERVICE_PROFILE: "service" }],
];
const ALLOWED_ENVIRONMENTS: Array<[string, NodeJS.ProcessEnv]> = [
  ["development", { NODE_ENV: "development" }],
  ["test", { NODE_ENV: "test" }],
  ["unset NODE_ENV", {}],
  ["the self-hosted profile in development", { NODE_ENV: "development", DOCSLURP_SERVICE_PROFILE: "self-hosted" }],
];

describe("unsafe overrides", () => {
  afterEach(() => vi.restoreAllMocks());

  describe.each(UNSAFE_OVERRIDES)("%s", (name) => {
    it.each(REFUSED_ENVIRONMENTS)("refuses startup in %s, naming the setting", (_label, base) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const value of ["true", "1", "yes", "on", " TRUE ", "ture"]) {
        const env = { ...base, [name]: value };
        expect(() => assertNoUnsafeOverrides(env)).toThrow(UnsafeOverrideError);
        expect(() => assertNoUnsafeOverrides(env)).toThrow(new RegExp(`${name}.*refusing to start`));
        // Never in effect there, even for a path that skipped the startup check.
        expect(unsafeOverrideEnabled(name, env)).toBe(false);
        expect(unsafeOverrideEnabled(name, env, true)).toBe(false);
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`reason=unsafe-override names=${name}`));
    });

    it.each(REFUSED_ENVIRONMENTS)("unset or explicitly off keeps the safe behaviour in %s", (_label, base) => {
      for (const value of [undefined, "", "false", "0", "no", "off", " FALSE "]) {
        const env = { ...base, [name]: value };
        expect(() => assertNoUnsafeOverrides(env)).not.toThrow();
        expect(unsafeOverrideEnabled(name, env)).toBe(false);
        expect(unsafeOverrideEnabled(name, env, true)).toBe(false);
      }
    });

    it.each(ALLOWED_ENVIRONMENTS)("is allowed and in effect in %s", (_label, base) => {
      const env = { ...base, [name]: "true" };
      expect(() => assertNoUnsafeOverrides(env)).not.toThrow();
      expect(unsafeOverrideEnabled(name, env)).toBe(true);
      expect(unsafeOverrideEnabled(name, { ...base, [name]: "1" })).toBe(true);
      expect(unsafeOverrideEnabled(name, { ...base, [name]: "false" }, true)).toBe(false);
      expect(unsafeOverrideEnabled(name, { ...base, [name]: "ture" })).toBe(false);
      expect(unsafeOverrideEnabled(name, base)).toBe(false);
      expect(unsafeOverrideEnabled(name, base, true)).toBe(true);
    });
  });

  it("names every refused setting at once", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = Object.fromEntries([["NODE_ENV", "production"], ...UNSAFE_OVERRIDES.map((name) => [name, "true"])]);
    expect(requestedUnsafeOverrides(env)).toEqual([...UNSAFE_OVERRIDES]);
    try {
      assertNoUnsafeOverrides(env);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeOverrideError);
      expect((error as UnsafeOverrideError).names).toEqual([...UNSAFE_OVERRIDES]);
    }
  });

  it("follows the process environment too, so a production process cannot be relabelled by a caller's env", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(unsafeOverridesAllowed({ NODE_ENV: "development" })).toBe(false);
      expect(unsafeOverrideEnabled("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", { NODE_ENV: "development", DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS: "1" })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
