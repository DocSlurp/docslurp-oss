import { describe, expect, it } from "vitest";

import { loadSandboxProvider, resolveSandboxProviderId } from "../registry.js";

describe("resolveSandboxProviderId", () => {
  it("defaults to bubblewrap on linux", () => {
    expect(resolveSandboxProviderId({}, "linux")).toBe("bubblewrap");
  });

  it("treats an empty value as unset", () => {
    expect(resolveSandboxProviderId({ DOCSLURP_PARSER_SANDBOX: "  " }, "linux")).toBe("bubblewrap");
  });

  it("defaults to bubblewrap on linux in production", () => {
    expect(resolveSandboxProviderId({ NODE_ENV: "production" }, "linux")).toBe("bubblewrap");
  });

  it("defaults to none on non-linux outside production", () => {
    expect(resolveSandboxProviderId({}, "darwin")).toBe("none");
  });

  it("defaults to bubblewrap on non-linux in production", () => {
    expect(resolveSandboxProviderId({ NODE_ENV: "production" }, "darwin")).toBe("bubblewrap");
  });

  it("honors an explicit provider, trimmed and lowercased", () => {
    expect(resolveSandboxProviderId({ DOCSLURP_PARSER_SANDBOX: " Landlock " }, "linux")).toBe("landlock");
  });

  it("rejects unknown providers and lists the valid ids", () => {
    expect(() => resolveSandboxProviderId({ DOCSLURP_PARSER_SANDBOX: "bogus" }, "linux")).toThrow(
      /bubblewrap, landlock, modal, none/,
    );
  });
});

describe("loadSandboxProvider", () => {
  it("loads the none provider", async () => {
    const provider = await loadSandboxProvider("none");
    expect(provider.id).toBe("none");
  });
});
