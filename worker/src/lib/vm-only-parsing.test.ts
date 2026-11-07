import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectQuarantine } from "./quarantine.js";
import { assertServiceProfileRuntime, vmOnlyParsing } from "./vm-only-parsing.js";
import { detectHtmlEmbeds } from "../routing/html-embeds.js";
import { structuredJsonToMarkdown } from "../extractors/structured-json.js";
import { initializeParserSandbox } from "../sandbox/startup.js";
import { resolveSandboxProviderId } from "../sandbox/registry.js";

// Council G L3: the VM-only gates key on the service profile too, and the service profile refuses to start without
// NODE_ENV=production, so a deployment that forgot NODE_ENV never parses customer bytes in process.
afterEach(() => vi.unstubAllEnvs());

describe("vmOnlyParsing", () => {
  it("is true under NODE_ENV=production or DOCSLURP_SERVICE_PROFILE=service, from the given or the process environment", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "");
    expect(vmOnlyParsing({})).toBe(false);
    expect(vmOnlyParsing({ NODE_ENV: "production" })).toBe(true);
    expect(vmOnlyParsing({ DOCSLURP_SERVICE_PROFILE: "service" })).toBe(true);
    expect(vmOnlyParsing({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBe(false);
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    expect(vmOnlyParsing({})).toBe(true);
  });

  it("refuses in-process parsing under the service profile without NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    expect(() => detectHtmlEmbeds("<p>x</p>")).toThrow(/requires the parser VM/);
    expect(() => structuredJsonToMarkdown("{}")).toThrow(/requires the parser VM/);
    expect(resolveSandboxProviderId({ DOCSLURP_SERVICE_PROFILE: "service" }, "linux")).toBe("modal");
    // Quarantine inspection goes to the VM runner, never the in-process inspector.
    const run = vi.fn(async () => { throw new Error("vm runner reached"); });
    await expect(inspectQuarantine({ bytes: Buffer.from("PK\u0003\u0004"), filename: "a.zip", tempFile: "/nonexistent", runner: { run } as never, policy: {} as never })).rejects.toThrow();
    expect(run).toHaveBeenCalled();
  });
});

describe("assertServiceProfileRuntime", () => {
  it("refuses the service profile unless NODE_ENV=production", async () => {
    expect(() => assertServiceProfileRuntime({ DOCSLURP_SERVICE_PROFILE: "service" })).toThrow(/requires NODE_ENV=production \(got unset\)/);
    expect(() => assertServiceProfileRuntime({ DOCSLURP_SERVICE_PROFILE: "service", NODE_ENV: "development" })).toThrow(/got 'development'/);
    expect(() => assertServiceProfileRuntime({ DOCSLURP_SERVICE_PROFILE: "service", NODE_ENV: "production" })).not.toThrow();
    expect(() => assertServiceProfileRuntime({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).not.toThrow();
    expect(() => assertServiceProfileRuntime({})).not.toThrow();
    await expect(initializeParserSandbox({ DOCSLURP_SERVICE_PROFILE: "service", DOCSLURP_PARSER_SANDBOX: "none" }, "linux")).rejects.toThrow(/refusing to start/);
  });
});
