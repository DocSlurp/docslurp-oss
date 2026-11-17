import { afterEach, describe, expect, it } from "vitest";

import {
  advertisedCapabilityPools, assertCapabilityPoolRegions, builtinLlmPoolMembers, capabilityPoolRegionProblems, capabilityPoolsLogLine,
  endpointTagRegion, localServiceMember, nextAutomaticPoolMember, parseAdvertisedCapabilityPools, poolHostRegion, poolMemberAdmission,
  poolMemberAutomaticRoute, poolMemberForModel, registerServicePoolMember, resolveCapabilityPools, type CapabilityPoolServiceRegistration,
  type LlmPoolMember,
} from "../capability-pools.js";
import { OCR_ESCALATION_ROUTES } from "../ocr-escalation-routes.js";
import { DISTINCT_TEST_PRICING, installTestPricing } from "../pricing-testing.js";
import { resetPricingProviderForTests } from "../pricing-provider.js";
import { PROVIDER_REGIONS } from "../provider-regions.js";
import { TIER_OPTIONS } from "../tier-options.js";

afterEach(() => resetPricingProviderForTests());

const US = { region: "US" as const, evidence: "provider-docs" as const, source: "https://example.com/privacy", checked: "2026-11-17" };
const service = (overrides: Partial<CapabilityPoolServiceRegistration> = {}): CapabilityPoolServiceRegistration => ({
  capability: "text", backend: "vm-pdf-a", engine: "vm-pdf", regions: [US], automaticFailover: true, ...overrides,
});

describe("capability pools: resolution and order", () => {
  it("has the three capabilities, each in order, with stable public-safe member ids", () => {
    const pools = resolveCapabilityPools({ env: {} });
    expect(pools.text).toEqual([]);
    expect(pools.ocr.map((member) => member.id)).toEqual([
      "ocr.llm.glm-5.3-flash+wafer.us", "ocr.llm.glm-5.3-flash+morph.us", "ocr.llm.qwen3-vl-30b-a3b+deepinfra.us",
    ]);
    expect(pools.vision.map((member) => member.id)).toEqual(["vision.llm.gpt-6-luna.us", "vision.llm.glm-5.3-flash.us"]);
    for (const member of [...pools.ocr, ...pools.vision]) {
      // A bounded telemetry label: no slash, no price, no private name.
      expect(member.id).toMatch(/^[a-z]+\.(llm|service)\.[a-z0-9.+-]+\.(us|eu|eu\+us|local|global)$/);
      expect(member.id.length).toBeLessThanOrEqual(48);
      expect(member.id).not.toMatch(/usd|margin|credit|price|\d\.\d{2}/i);
      // Provider price ceilings (escalationRoute, priceCeiling) are routing constraints, not pricing mechanics.
      const { escalationRoute: _route, priceCeiling: _ceiling, ...fields } = member as LlmPoolMember;
      // Names its admission check ("margin-gate") but carries no price, credit or multiplier.
      expect(JSON.stringify(fields)).not.toMatch(/usd|credit|price|multiplier/i);
    }
  });

  it("orders the ocr second read as the escalation routes, each with its own host and measurement", () => {
    const ocr = resolveCapabilityPools({ env: {} }).ocr as LlmPoolMember[];
    expect(ocr.map((member) => member.escalationRoute?.optionId)).toEqual(OCR_ESCALATION_ROUTES.map((route) => route.optionId));
    expect(ocr.map((member) => member.hosts)).toEqual([["wafer/us"], ["morph/fp8"], ["deepinfra"]]);
    expect(ocr.every((member) => member.stage === "second-read" && member.automaticFailover && member.admission === "margin-gate")).toBe(true);
    expect(ocr.every((member) => member.quality && member.quality.evalRef.startsWith("tier-benchmark-v1/"))).toBe(true);
  });

  it("puts registered services first (by priority), read before second read, and the vision default before its fallback", () => {
    const late = registerServicePoolMember(service({ backend: "vm-pdf-b", engine: "vm-pdf-b", priority: 2 }));
    const early = registerServicePoolMember(service({ priority: 1 }));
    const reader = registerServicePoolMember(service({ capability: "ocr", backend: "reader", engine: "gpu-reader" }));
    const pools = resolveCapabilityPools({ services: [late, early, reader], env: {} });
    expect(pools.text.map((member) => member.id)).toEqual(["text.service.vm-pdf.us", "text.service.vm-pdf-b.us"]);
    expect(pools.ocr[0]!.id).toBe("ocr.service.gpu-reader.us");
    expect(pools.ocr.slice(1).every((member) => member.stage === "second-read")).toBe(true);
    expect(nextAutomaticPoolMember("vision", "vision.llm.gpt-6-luna.us", pools)?.id).toBe("vision.llm.glm-5.3-flash.us");
    expect(nextAutomaticPoolMember("vision", "vision.llm.glm-5.3-flash.us", pools)).toBeNull();
    expect(nextAutomaticPoolMember("ocr", "ocr.llm.glm-5.3-flash+wafer.us", pools)?.id).toBe("ocr.llm.glm-5.3-flash+morph.us");
  });

  it("lets the operator set a pool's members and order, and refuses an id nobody defines", () => {
    const env = { DOCSLURP_CAPABILITY_POOL_OCR: "ocr.llm.qwen3-vl-30b-a3b+deepinfra.us,ocr.llm.glm-5.3-flash+wafer.us" };
    expect(resolveCapabilityPools({ env }).ocr.map((member) => member.id)).toEqual(["ocr.llm.qwen3-vl-30b-a3b+deepinfra.us", "ocr.llm.glm-5.3-flash+wafer.us"]);
    expect(() => resolveCapabilityPools({ env: { DOCSLURP_CAPABILITY_POOL_VISION: "vision.llm.made-up.us" } })).toThrow(/no core definition or plugin registers/);
    expect(() => resolveCapabilityPools({ env: { DOCSLURP_CAPABILITY_POOL_VISION: "ocr.llm.glm-5.3-flash+wafer.us" } })).toThrow(/a ocr member/);
  });

  it("finds members by model and refuses a member defined twice", () => {
    expect(poolMemberForModel("vision", "openai/gpt-6-luna")?.id).toBe("vision.llm.gpt-6-luna.us");
    expect(poolMemberForModel("ocr", "llm://openrouter/z-ai/glm-5.3-flash", "second-read")?.id).toBe("ocr.llm.glm-5.3-flash+wafer.us");
    const member = registerServicePoolMember(service());
    expect(() => resolveCapabilityPools({ services: [member, member], env: {} })).toThrow(/defined twice/);
  });

  it("advertises the pools compactly and parses an advertisement defensively", () => {
    const advertised = advertisedCapabilityPools(resolveCapabilityPools({ env: {} }));
    expect(parseAdvertisedCapabilityPools(JSON.parse(JSON.stringify(advertised)))).toEqual(advertised);
    expect(parseAdvertisedCapabilityPools({ ocr: [{ id: "x/../y" }, { id: "ocr.llm.a.us", stage: "second-read", region: "US", failover: true, quality: 0.9 }] }))
      .toEqual({ ocr: [{ id: "ocr.llm.a.us", stage: "second-read", region: "US", failover: true, quality: 0.9 }] });
    expect(parseAdvertisedCapabilityPools("nope")).toBeNull();
    expect(capabilityPoolsLogLine(resolveCapabilityPools({ env: {} }))).toBe(
      "[capability-pools] text=none ocr=ocr.llm.glm-5.3-flash+wafer.us*>ocr.llm.glm-5.3-flash+morph.us*>ocr.llm.qwen3-vl-30b-a3b+deepinfra.us* "
      + "vision=vision.llm.gpt-6-luna.us>vision.llm.glm-5.3-flash.us*",
    );
  });
});

describe("capability pools: regions from stated evidence only", () => {
  it("reads a region from an endpoint tag and from a provider's own statement, never from its headquarters", () => {
    expect(endpointTagRegion("wafer/us")).toBe("US");
    expect(endpointTagRegion("amazon-bedrock/us-east-1")).toBe("US");
    expect(endpointTagRegion("google-vertex/europe")).toBe("EU");
    expect(endpointTagRegion("amazon-bedrock/eu-west-1")).toBe("EU");
    expect(endpointTagRegion("wafer/nvfp4")).toBeNull();
    expect(poolHostRegion("friendli")).toMatchObject({ region: "US", evidence: "provider-docs" });
    // Headquartered in the US (provider-regions.ts), but no stated hosting region: unknown.
    for (const host of ["wafer/nvfp4", "inference-net/fp4", "openai", "anthropic", "relace", "amazon-bedrock/global"]) {
      expect(poolHostRegion(host), host).toBeNull();
    }
    expect(PROVIDER_REGIONS.wafer!.headquarters).toBe("US");
  });

  it("every built-in member and every hosted page-ocr tier pool sends pages only to stated US or EU hosts", () => {
    expect(capabilityPoolRegionProblems(resolveCapabilityPools({ env: {} }))).toEqual([]);
    for (const option of TIER_OPTIONS.filter((entry) => entry.capability === "page-ocr")) {
      for (const host of option.pool.hosts) expect(poolHostRegion(host), `${option.id} ${host}`).not.toBeNull();
    }
  });

  it("refuses a member whose region is unknown, and a plugin that claims to be local; admits an unpinned (global) plugin service", () => {
    expect(() => registerServicePoolMember(service({ regions: [{ ...US, region: "SG" as never }] }))).toThrow(/not US, EU or global/);
    expect(() => registerServicePoolMember(service({ regions: [{ ...US, region: "local" as never, evidence: "deployment" as never }] }))).toThrow(/not US, EU or global/);
    const unpinned = registerServicePoolMember(service({ engine: "cloud-sandbox", regions: [{ ...US, region: "global", evidence: "deployment" }] }));
    expect(unpinned.id).toMatch(/\.global$/);
    expect(capabilityPoolRegionProblems({ ...resolveCapabilityPools({ env: {} }), text: [unpinned] })).toEqual([]);
    expect(() => registerServicePoolMember(service({ regions: [{ ...US, evidence: "headquarters" as never }] }))).toThrow(/not stated evidence/);
    expect(() => registerServicePoolMember(service({ regions: [] }))).toThrow(/regions must state/);
    expect(() => registerServicePoolMember(service({ engine: "Private Fork!" }))).toThrow(/engine/);
    // A pool that somehow holds an unproven host refuses to start.
    const pools = resolveCapabilityPools({ env: {} });
    const unproven = { ...(pools.vision[1] as LlmPoolMember), id: "vision.llm.unproven.us", hosts: ["wafer/nvfp4"] };
    expect(() => assertCapabilityPoolRegions({ ...pools, vision: [pools.vision[0]!, unproven] })).toThrow(/wafer\/nvfp4 has no stated US or EU region/);
    // Built-in local services are allowed (customer-owned execution), and only they.
    expect(capabilityPoolRegionProblems({ ...pools, text: [localServiceMember("text", "local-pdf", "local-pdf")] })).toEqual([]);
    const forged = { ...localServiceMember("text", "x", "x"), builtin: false };
    expect(capabilityPoolRegionProblems({ ...pools, text: [forged] })).toHaveLength(1);
  });
});

describe("capability pools: admission per member", () => {
  it("checks each LLM member through the margin gate at its own route, and leaves a project-chosen member unchecked", () => {
    const pools = resolveCapabilityPools({ env: {} });
    const [wafer, morph, qwen] = pools.ocr as LlmPoolMember[];
    expect(poolMemberAutomaticRoute(wafer!).hosts).toEqual(["wafer/us"]);
    expect(poolMemberAutomaticRoute(morph!).hosts).toEqual(["morph/fp8"]);
    // The vision fallback is priced on its own ceiling and hosts (the second read's GLM hosts), not GLM's widest profile.
    expect(poolMemberAutomaticRoute(pools.vision[1] as LlmPoolMember)).toMatchObject({ hosts: ["wafer/us", "morph/fp8"], capImageUsd: 0 });
    // A member whose hosts fall outside its model's catalog route is refused, never widened.
    expect(() => poolMemberAutomaticRoute({ ...(pools.vision[1] as LlmPoolMember), priceCeiling: null, hosts: ["somewhere/us"] })).toThrow(/outside the model's catalog route/);
    installTestPricing({ ...DISTINCT_TEST_PRICING, automaticCallValueUsd: () => 0.002 });
    const now = Date.parse("2026-11-17T12:00:00Z");
    const decisions = [wafer!, morph!, qwen!].map((member) => poolMemberAdmission(member, "escalation", { env: {}, now })!);
    expect(decisions.every((decision) => decision.kind === "page-transcription")).toBe(true);
    // Each member is priced on its own ceiling or list price: different worst cases, decided one by one.
    expect(new Set(decisions.map((decision) => decision.worstCostUsd)).size).toBe(3);
    for (const decision of decisions) expect(decision.allowed).toBe(decision.ratio! >= 1.3);
    installTestPricing({ ...DISTINCT_TEST_PRICING, automaticCallValueUsd: () => 0.000_001 });
    expect([wafer!, morph!, qwen!].every((member) => poolMemberAdmission(member, "escalation", { env: {}, now })!.allowed === false)).toBe(true);
    expect(poolMemberAdmission(pools.vision[0] as LlmPoolMember, "pick")).toBeNull();
  });
});

describe("capability pools: organization isolation", () => {
  it("resolving or admitting a member keeps no per-organization state and reuses nothing between callers", () => {
    // Members are frozen, tenant-free configuration: nothing in them can carry one organization's data to another.
    const first = builtinLlmPoolMembers();
    const second = builtinLlmPoolMembers();
    expect(first.every((member) => Object.isFrozen(member))).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toMatch(/org|tenant|document/i);
    // Admission is decided per call from the route and the pricing provider only; it takes no organization input.
    installTestPricing({ ...DISTINCT_TEST_PRICING, automaticCallValueUsd: () => 0.002 });
    const member = first[0]!;
    const a = poolMemberAdmission(member, "escalation", { env: {}, now: 1 });
    const b = poolMemberAdmission(member, "escalation", { env: {}, now: 1 });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
