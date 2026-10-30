import { describe, expect, it } from "vitest";

import {
  CHINA_PROVIDER_SLUGS, NON_CHINA_PROVIDER_SLUGS, PROVIDER_REGIONS, isProviderAllowedByRegion, providerRegion,
  providerSlugFromName, withServedProviderRegion,
} from "../provider-regions.js";

describe("provider region table", () => {
  it("classifies every row from its recorded headquarters, never guessing an unlisted one", () => {
    for (const [slug, entry] of Object.entries(PROVIDER_REGIONS)) {
      if (entry.headquarters === "CN") expect(entry.region, slug).toBe("cn");
      if (entry.headquarters === null) expect(entry.region === "unknown" || entry.basis.startsWith("Chinese-owned"), slug).toBe(true);
      if (entry.region === "cn" && entry.headquarters !== "CN") expect(entry.basis, slug).toMatch(/^Chinese-owned: /);
      if (entry.region === "other") expect(entry.headquarters, slug).not.toBeNull();
    }
  });

  it("keeps every host the previous China list named, and the hosts DocSlurp routes to", () => {
    for (const slug of ["alibaba", "baidu", "deepseek", "minimax", "moonshotai", "nex-agi", "siliconflow", "stepfun", "streamlake", "tencent", "xiaomi", "z-ai"]) {
      expect(CHINA_PROVIDER_SLUGS, slug).toContain(slug);
    }
    for (const slug of ["together", "fireworks", "parasail", "deepinfra", "wafer", "friendli", "inference-net", "amazon-bedrock", "azure", "openai", "anthropic", "perplexity", "cloudflare"]) {
      expect(providerRegion(slug), slug).toBe("other");
    }
    expect(new Set([...CHINA_PROVIDER_SLUGS, ...NON_CHINA_PROVIDER_SLUGS]).size).toBe(CHINA_PROVIDER_SLUGS.length + NON_CHINA_PROVIDER_SLUGS.length);
  });

  it("resolves endpoint variants and display names, and fails closed on unknown providers", () => {
    expect(providerRegion("deepinfra/fp8/flex")).toBe("other");
    expect(providerRegion("Z-AI/FP8")).toBe("cn");
    expect(providerRegion(undefined)).toBe("unknown");
    expect(providerSlugFromName("StreamLake")).toBe("streamlake");
    expect(providerSlugFromName("Amazon Bedrock")).toBe("amazon-bedrock");
    expect(providerSlugFromName("Z.AI")).toBe("z-ai");
    expect(providerSlugFromName("Some New Host")).toBeNull();
    expect(isProviderAllowedByRegion("relace", false)).toBe(false);
    expect(isProviderAllowedByRegion("relace", true)).toBe(true);
    expect(isProviderAllowedByRegion("together", false)).toBe(true);
  });

  it("labels usage metadata with the served host and its region", () => {
    expect(withServedProviderRegion({ costSource: "provider" }, "StreamLake")).toEqual({ costSource: "provider", servedProvider: "StreamLake", servedProviderSlug: "streamlake", servedProviderRegion: "cn" });
    expect(withServedProviderRegion({}, "Together")).toMatchObject({ servedProviderSlug: "together", servedProviderRegion: "other" });
    expect(withServedProviderRegion({}, "Mystery")).toMatchObject({ servedProviderSlug: null, servedProviderRegion: "unknown" });
    const metadata = { a: 1 };
    expect(withServedProviderRegion(metadata, undefined)).toBe(metadata);
  });
});
