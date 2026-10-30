import { describe, expect, it } from "vitest";

import { assertSandboxPolicy } from "../policy.js";
import { SandboxPolicyError, type SandboxIsolation } from "../types.js";

const iso = (filesystem: boolean, network: SandboxIsolation["network"], processes = true): SandboxIsolation => ({
  filesystem,
  network,
  processes,
  location: "local",
});
const NONE_ISOLATION = iso(false, "none");
const NONE_NO_PID_NAMESPACE = iso(false, "none", false);
const PROD = { NODE_ENV: "production" };

describe("assertSandboxPolicy in production", () => {
  it.each([
    ["fs + full network isolation", "bubblewrap", iso(true, "full")],
    ["fs + tcp-only network isolation", "landlock", iso(true, "tcp-only")],
  ])("accepts %s", (_name, providerId, isolation) => {
    expect(assertSandboxPolicy({ providerId, isolation, env: PROD })).toEqual({ warnings: [] });
  });

  it.each([
    ["no network isolation", iso(true, "none")],
    ["no filesystem isolation", iso(false, "full")],
  ])("rejects %s", (_name, isolation) => {
    expect(() => assertSandboxPolicy({ providerId: "bubblewrap", isolation, env: PROD })).toThrow(SandboxPolicyError);
  });

  it("rejects none without the override and names it", () => {
    expect(() => assertSandboxPolicy({ providerId: "none", isolation: NONE_ISOLATION, env: PROD })).toThrow(
      /DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED/,
    );
  });

  it("allows none with the override and warns", () => {
    const env = { ...PROD, DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: "true" };
    expect(assertSandboxPolicy({ providerId: "none", isolation: NONE_ISOLATION, env })).toEqual({
      warnings: ["[parser-sandbox] status=unisolated"],
    });
  });
});

describe("assertSandboxPolicy outside production", () => {
  it.each([iso(false, "none"), iso(true, "none"), iso(true, "full")])("accepts any isolation (%o)", (isolation) => {
    expect(assertSandboxPolicy({ providerId: "bubblewrap", isolation, env: { NODE_ENV: "development" } })).toEqual({
      warnings: [],
    });
  });

  it("accepts none with no warnings when unset", () => {
    expect(assertSandboxPolicy({ providerId: "none", isolation: NONE_ISOLATION, env: {} })).toEqual({ warnings: [] });
  });

  it("rejects none without a PID namespace unless the unisolated override is set", () => {
    expect(() => assertSandboxPolicy({ providerId: "none", isolation: NONE_NO_PID_NAMESPACE, env: {} })).toThrow(
      /DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED/,
    );
    const env = { DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: "true" };
    expect(assertSandboxPolicy({ providerId: "none", isolation: NONE_NO_PID_NAMESPACE, env }).warnings).toEqual([
      "[parser-sandbox] status=unisolated",
    ]);
  });

  it("still warns for none when the override is explicitly set", () => {
    const env = { DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: "true" };
    expect(assertSandboxPolicy({ providerId: "none", isolation: NONE_ISOLATION, env }).warnings).toEqual([
      "[parser-sandbox] status=unisolated",
    ]);
  });
});

describe("assertSandboxPolicy process teardown", () => {
  it.each([
    ["development", { NODE_ENV: "development" }],
    ["production", PROD],
    ["production with the unisolated override", { ...PROD, DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: "true" }],
  ])("refuses a filesystem-isolating provider without a PID namespace in %s", (_name, env) => {
    expect(() =>
      assertSandboxPolicy({ providerId: "landlock", isolation: iso(true, "tcp-only", false), env }),
    ).toThrow(/cannot guarantee that a parser's processes die with it/);
  });
});
