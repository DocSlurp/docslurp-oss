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
  it.each(["bubblewrap", "landlock", "none"])("refuses local %s even with the unisolated override", (providerId) => {
    const env = { ...PROD, DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: "true" };
    expect(() => assertSandboxPolicy({ providerId, isolation: iso(true, "full"), env })).toThrow(/VM boundary/);
  });

  it("accepts the remote Modal VM boundary", () => {
    expect(assertSandboxPolicy({ providerId: "modal", isolation: { ...iso(true, "full"), location: "remote" }, env: PROD }))
      .toEqual({ warnings: [] });
  });

  it.each([
    ["unknown remote provider", "custom", { ...iso(true, "full"), location: "remote" as const }],
    ["Modal claiming local execution", "modal", iso(true, "full")],
    ["remote without filesystem isolation", "modal", { ...iso(false, "full"), location: "remote" as const }],
    ["remote with only TCP isolation", "modal", { ...iso(true, "tcp-only"), location: "remote" as const }],
    ["remote without network isolation", "modal", { ...iso(true, "none"), location: "remote" as const }],
  ])("refuses %s", (_name, providerId, isolation) => {
    expect(() => assertSandboxPolicy({ providerId, isolation, env: PROD })).toThrow(SandboxPolicyError);
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
