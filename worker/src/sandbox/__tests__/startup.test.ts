import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeParserSandbox } from "../startup.js";
import { SandboxPolicyError } from "../types.js";

describe("initializeParserSandbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses provider none in production without the override", async () => {
    await expect(
      initializeParserSandbox({ DOCSLURP_PARSER_SANDBOX: "none", NODE_ENV: "production" }, "linux"),
    ).rejects.toBeInstanceOf(SandboxPolicyError);
  });

  it("warns and logs the startup line for an explicitly unisolated production run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await initializeParserSandbox(
      { DOCSLURP_PARSER_SANDBOX: "none", NODE_ENV: "production", DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: "true" },
      "linux",
    );
    expect(result.provider.id).toBe("none");
    expect(warn).toHaveBeenCalledWith("[parser-sandbox] status=unisolated");
    expect(log).toHaveBeenCalledWith(
      "[parser-sandbox] provider=none filesystem=false network=none processes=false location=local",
    );
  });

  it("fails with the probe detail when isolation is unavailable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { default: bubblewrap } = await import("../providers/bubblewrap/index.js");
    vi.spyOn(bubblewrap, "probe").mockResolvedValue({
      ok: false,
      isolation: { filesystem: true, network: "full", processes: true, location: "local" },
      detail: "bwrap: no user namespaces",
    });
    await expect(initializeParserSandbox({ DOCSLURP_PARSER_SANDBOX: "bubblewrap" }, "linux")).rejects.toThrow(
      "parser isolation unavailable: bwrap: no user namespaces",
    );
  });
});
