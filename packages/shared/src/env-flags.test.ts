import { describe, expect, it } from "vitest";

import { envFlags, formatEnvFlags } from "./env-flags.js";

describe("envFlags", () => {
  it("keeps boolean-valued variables, sorted by name", () => {
    expect(envFlags({
      WORKER_PAGE_FACTS: "true",
      MEDIA_REMOTE_ENABLED: "false",
      PAGE_ROUTER_MODE: "off",
      TEMPORAL_WORKER_VERSIONING: "ON",
      DOCSLURP_X: " yes ",
    })).toEqual({
      DOCSLURP_X: "yes",
      MEDIA_REMOTE_ENABLED: "false",
      PAGE_ROUTER_MODE: "off",
      TEMPORAL_WORKER_VERSIONING: "on",
      WORKER_PAGE_FACTS: "true",
    });
  });

  it("skips non-boolean values, so URLs, keys and numbers never reach the log", () => {
    const flags = envFlags({
      DATABASE_URL: "postgres://user:hunter2@db/app",
      OPENROUTER_API_KEY: "sk-or-v1-abc123",
      MEDIA_MAX_CONCURRENT: "4",
      MEDIA_PROVIDER: "deepinfra",
      EMPTY: "",
      UNSET: undefined,
    });
    expect(flags).toEqual({});
  });

  it("skips secret-named variables even when the value looks boolean", () => {
    expect(envFlags({ STRIPE_SECRET_KEY: "true", API_TOKEN: "false", ADMIN_PASSWORD: "yes", AUTH_COOKIE_SECURE: "true" })).toEqual({});
  });

  it("skips package-manager and lowercase variables", () => {
    expect(envFlags({ npm_config_frozen_lockfile: "true", PNPM_SCRIPT_SRC_DIR: "true", lower_flag: "true" })).toEqual({});
  });
});

describe("formatEnvFlags", () => {
  it("renders name=value pairs on one line", () => {
    expect(formatEnvFlags({ A_ENABLED: "true", B_MODE: "off" })).toBe("A_ENABLED=true B_MODE=off");
  });

  it("says none when nothing is set", () => {
    expect(formatEnvFlags({})).toBe("none");
  });
});
