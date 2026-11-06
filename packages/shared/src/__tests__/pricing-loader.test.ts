import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPricingProvider, pricingPluginSpecifier, resetPricingLoaderForTests } from "../pricing-loader.js";
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
    expect(await loadPricingProvider(env, plugin({ ...OPEN_PRICING, id: "deployment", version: "d-1" }))).toBe("deployment");
    expect(pricing().version).toBe("d-1");
  });

  it("fails closed on a plugin that does not load, has no register() or returns an invalid provider", async () => {
    const env = { DOCSLURP_PRICING_PLUGIN: "/opt/pricing/plugin.mjs" };
    await expect(loadPricingProvider(env, async () => { throw new Error("ENOENT"); })).rejects.toThrow(/failed to load.*ENOENT/);
    await expect(loadPricingProvider(env, async () => ({}))).rejects.toThrow(/exports no register/);
    await expect(loadPricingProvider(env, plugin({ ...OPEN_PRICING }))).rejects.toThrow(/reserved id/);
    await expect(loadPricingProvider(env, plugin({ id: "x" }))).rejects.toThrow(/apiVersion/);
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
    await loadPricingProvider({ DOCSLURP_PRICING_PLUGIN: "/a.mjs" }, plugin({ ...OPEN_PRICING, id: "a" }));
    await expect(loadPricingProvider({ DOCSLURP_PRICING_PLUGIN: "/b.mjs" })).rejects.toThrow(/different/);
  });
});
