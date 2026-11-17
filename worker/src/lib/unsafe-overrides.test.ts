import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isDevelopmentEnvironment, quarantineRequired } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertNoUnsafeOverrides,
  requestedUnsafeOverrides,
  UNSAFE_OVERRIDES,
  UNSAFE_VALUE_SETTINGS,
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
  ["NODE_ENV padded with a no-break space", { NODE_ENV: "\u00a0development" }],
  ["NODE_ENV of a byte-order mark", { NODE_ENV: "\ufeff" }],
  ["NODE_ENV with an inner space", { NODE_ENV: "dev elopment" }],
  ["the service profile without NODE_ENV", { DOCSLURP_SERVICE_PROFILE: "service" }],
  ["the service profile in development", { NODE_ENV: "development", DOCSLURP_SERVICE_PROFILE: "service" }],
];
const ALLOWED_ENVIRONMENTS: Array<[string, NodeJS.ProcessEnv]> = [
  ["development", { NODE_ENV: "development" }],
  ["test", { NODE_ENV: "test" }],
  ["development, padded with ASCII whitespace and upper case", { NODE_ENV: " \tDevelopment\n" }],
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

  // #398 council: settings whose value weakens protection rather than an on/off fail-open flag.
  const UNSAFE_VALUES: Record<(typeof UNSAFE_VALUE_SETTINGS)[number], { unsafe: string[]; safe: Array<string | undefined> }> = {
    DOCSLURP_CLAMAV_ENABLED: { unsafe: ["false", "0", "no", "off", "typo"], safe: [undefined, "", "true", "1", "yes", "on"] },
    DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS: { unsafe: ["73", "100", "999999", "0", "-1", "NaN", "1+999", "072", "7.2"], safe: [undefined, "", "1", "12", "24", "25", "48", "69", "72"] },
    QUARANTINE_ENABLED: { unsafe: ["false", "0", "no", "off", " OFF ", "flase"], safe: [undefined, "", "true", "1", "yes", "on", " TRUE "] },
    DOCSLURP_PARSER_SANDBOX: { unsafe: ["none", " None "], safe: [undefined, "", "bubblewrap", "landlock", "modal"] },
  };

  describe.each(UNSAFE_VALUE_SETTINGS)("%s", (name) => {
    it.each(REFUSED_ENVIRONMENTS)("refuses the unsafe value at startup in %s", (_label, base) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      for (const value of UNSAFE_VALUES[name].unsafe) {
        const env = { ...base, [name]: value };
        expect(() => assertNoUnsafeOverrides(env)).toThrow(new RegExp(`${name}.*refusing to start`));
        if (name === "QUARANTINE_ENABLED") expect(quarantineRequired(env)).toBe(true);
      }
    });

    it.each(REFUSED_ENVIRONMENTS)("accepts the safe values in %s", (_label, base) => {
      for (const value of UNSAFE_VALUES[name].safe) expect(() => assertNoUnsafeOverrides({ ...base, [name]: value })).not.toThrow();
    });

    it.each(ALLOWED_ENVIRONMENTS)("is allowed in %s", (_label, base) => {
      for (const value of UNSAFE_VALUES[name].unsafe) expect(() => assertNoUnsafeOverrides({ ...base, [name]: value })).not.toThrow();
      if (name === "QUARANTINE_ENABLED") expect(quarantineRequired({ ...base, QUARANTINE_ENABLED: "false" })).toBe(false);
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

// #398 council: scripts/start-worker.sh and the worker classify NODE_ENV with one rule (trim ASCII whitespace only,
// lower-case ASCII only; anything non-empty outside development/test is deployed). JavaScript's trim() strips Unicode
// spaces a shell keeps, so a value like "<NBSP>development" once meant development in node and not in bash.
describe("start-worker.sh and the worker agree on what development is", () => {
  const script = fileURLToPath(new URL("../../../scripts/start-worker.sh", import.meta.url));
  const shell = (env: Record<string, string>) => {
    const result = spawnSync("bash", [script, "--environment-class"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...env },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };

  it.each([" ", "\u00a0", "\ufeff", "Production", " production", "dev elopment", "", "development", "test", " TEST\t", "\u00a0development", "development\u00a0", "staging", "\u212aest"])(
    "NODE_ENV=%j",
    (value) => {
      const node = isDevelopmentEnvironment({ NODE_ENV: value }) ? "development" : "deployed";
      expect(shell({ NODE_ENV: value })).toBe(node);
    },
  );

  it.each(["service", " Service ", "\u00a0service", "self-hosted", ""])("DOCSLURP_SERVICE_PROFILE=%j", (value) => {
    const node = isDevelopmentEnvironment({ NODE_ENV: "development", DOCSLURP_SERVICE_PROFILE: value }) ? "development" : "deployed";
    expect(shell({ NODE_ENV: "development", DOCSLURP_SERVICE_PROFILE: value })).toBe(node);
  });

  it.each(["service", " Service ", "\u00a0service", "selfhost", "dev", "DEV", "services", ""])("DOCSLURP_PROFILE=%j", (value) => {
    for (const nodeEnv of ["development", "test", "", "production", "staging"]) {
      const env = { NODE_ENV: nodeEnv, DOCSLURP_PROFILE: value };
      const node = isDevelopmentEnvironment(env) ? "development" : "deployed";
      expect(shell(env), JSON.stringify(env)).toBe(node);
    }
  });

  it("never classifies DOCSLURP_PROFILE=service as development, nor dev/selfhost under a deployed NODE_ENV", () => {
    expect(shell({ NODE_ENV: "development", DOCSLURP_PROFILE: "service" })).toBe("deployed");
    expect(shell({ NODE_ENV: "test", DOCSLURP_PROFILE: "service", DOCSLURP_SERVICE_PROFILE: "" })).toBe("deployed");
    expect(shell({ NODE_ENV: "production", DOCSLURP_PROFILE: "dev" })).toBe("deployed");
    expect(shell({ NODE_ENV: "staging", DOCSLURP_PROFILE: "selfhost" })).toBe("deployed");
    expect(shell({ NODE_ENV: "development", DOCSLURP_PROFILE: "selfhost", DOCSLURP_SERVICE_PROFILE: "service" })).toBe("deployed");
  });

  it("matches the expected classification for the council's odd values", () => {
    expect(shell({ NODE_ENV: " " })).toBe("development");
    for (const value of ["\u00a0", "\ufeff", "Production", " production", "dev elopment"]) expect(shell({ NODE_ENV: value })).toBe("deployed");
    expect(shell({ NODE_ENV: "" })).toBe("development");
  });
});
