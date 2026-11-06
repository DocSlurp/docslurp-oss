import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPricingProvider, pricingPluginSpecifier, resetPricingLoaderForTests, type PricingDurableState, type PricingPluginHost } from "../pricing-loader.js";
import { OPEN_PRICING } from "../pricing-open.js";
import { pricing, resetPricingProviderForTests } from "../pricing-provider.js";

afterEach(() => {
  resetPricingLoaderForTests();
  resetPricingProviderForTests();
  vi.restoreAllMocks();
});

const plugin = (provider: unknown) => async () => ({ register: () => provider });

describe("loadPricingProvider", () => {
  it("runs the open default without a plugin outside the service profile", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadPricingProvider({})).toBe("open");
    expect(pricing().id).toBe("open");
  });

  it("refuses to start the service profile without a pricing plugin", async () => {
    await expect(loadPricingProvider({ DOCSLURP_SERVICE_PROFILE: "service" })).rejects.toThrow(/needs a pricing provider/);
    await expect(loadPricingProvider({ DOCSLURP_PRICING_REQUIRED: "1" })).rejects.toThrow(/needs a pricing provider/);
  });

  it("installs the plugin's provider and uses it under the service profile", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { DOCSLURP_SERVICE_PROFILE: "service", DOCSLURP_PRICING_PLUGIN: "/opt/pricing/plugin.mjs" };
    const importModule = plugin({ ...OPEN_PRICING, id: "deployment", version: "d-1" });
    // Pricing required: no database handle means no identity check, so it refuses before importing (recheck Q #6).
    await expect(loadPricingProvider(env, { importModule })).rejects.toThrow(/no database connection.*refusing to start/);
    expect(pricing().id).toBe("open");
    const clean = { role: "docslurp_app", allowed_held: "docslurp_app", owned_objects: 0 };
    const sql = { unsafe: async () => [clean] };
    expect(await loadPricingProvider(env, { importModule, sql })).toBe("deployment");
    expect(pricing().version).toBe("d-1");
  });

  it("fails closed on a plugin that does not load, has no register() or returns an invalid provider", async () => {
    const env = { DOCSLURP_PRICING_PLUGIN: "/opt/pricing/plugin.mjs" };
    await expect(loadPricingProvider(env, { importModule: async () => { throw new Error("ENOENT"); } })).rejects.toThrow(/failed to load.*ENOENT/);
    await expect(loadPricingProvider(env, { importModule: async () => ({}) })).rejects.toThrow(/exports no register/);
    await expect(loadPricingProvider(env, { importModule: plugin({ ...OPEN_PRICING }) })).rejects.toThrow(/reserved id/);
    await expect(loadPricingProvider(env, { importModule: plugin({ id: "x" }) })).rejects.toThrow(/apiVersion/);
    expect(pricing().id).toBe("open");
  });

  it("accepts only one absolute path or file: URL", () => {
    expect(pricingPluginSpecifier({})).toBeNull();
    expect(pricingPluginSpecifier({ DOCSLURP_PRICING_PLUGIN: "/a/b.mjs" })).toBe("file:///a/b.mjs");
    expect(pricingPluginSpecifier({ DOCSLURP_PRICING_PLUGIN: "file:///a/b.mjs" })).toBe("file:///a/b.mjs");
    expect(() => pricingPluginSpecifier({ DOCSLURP_PRICING_PLUGIN: "relative.mjs" })).toThrow(/absolute/);
    expect(() => pricingPluginSpecifier({ DOCSLURP_PRICING_PLUGIN: "/a.mjs,/b.mjs" })).toThrow(/exactly one/);
  });

  it("refuses a second load from a different plugin", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await loadPricingProvider({ DOCSLURP_PRICING_PLUGIN: "/a.mjs" }, { importModule: plugin({ ...OPEN_PRICING, id: "a" }) });
    await expect(loadPricingProvider({ DOCSLURP_PRICING_PLUGIN: "/b.mjs" })).rejects.toThrow(/different/);
  });

  it("hands the plugin the entrypoint's durable state, or one that throws when the process has none", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let host: PricingPluginHost | null = null;
    const capture = async () => ({ register: (h: PricingPluginHost) => { host = h; return { ...OPEN_PRICING, id: "durable", version: "d-1" }; } });
    const state: PricingDurableState = { read: async () => 7n };
    await loadPricingProvider({ DOCSLURP_PRICING_PLUGIN: "/d.mjs" }, { importModule: capture, durableState: state });
    expect(host!.durableState).toBe(state);
    resetPricingLoaderForTests();
    resetPricingProviderForTests();
    await loadPricingProvider({ DOCSLURP_PRICING_PLUGIN: "/d.mjs" }, { importModule: capture });
    await expect(host!.durableState.read("card.sequence")).rejects.toThrow(/not available/);
    // Read-only (council J): the host offers no raise at all.
    expect((host!.durableState as unknown as { raise?: unknown }).raise).toBeUndefined();
  });
});

describe("pricing() fails closed when pricing is required (council E #2)", () => {
  it("refuses the open default under DOCSLURP_PRICING_REQUIRED=1 as under the service profile", () => {
    vi.stubEnv("DOCSLURP_PRICING_REQUIRED", "1");
    try {
      expect(() => pricing()).toThrow(/no pricing provider is installed/);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    try {
      expect(() => pricing()).toThrow(/no pricing provider is installed/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(pricing().id).toBe("open");
  });
});
