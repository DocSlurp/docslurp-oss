import { describe, expect, it } from "vitest";
import { routingTargetSchema } from "./page-routing.js";
import { buildRoutingTargetCatalog } from "./routing-targets.js";
import { TRANSCRIPTION_PRIVATE_MODELS, transcriptionTargets } from "./routing-targets-transcription.js";
import { lowestOpenRouterReasoning } from "./openrouter-usage.js";

const prices = {
  asOf: "2026-10-12",
  models: {
    "anthropic/claude-haiku-5.5": { input: 0.1, output: 0.5, vision: true },
    "anthropic/claude-sonnet-5.5": { input: 2, output: 10, vision: true },
    "inclusionai/ling-3.0-flash-vl": { input: 0.021, output: 0.0616, vision: true },
  },
};

describe("transcription targets", () => {
  it("are schema-valid and carry unique ids", () => {
    const targets = transcriptionTargets();
    for (const t of targets) routingTargetSchema.parse(t);
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
  });

  it("admit Haiku and Sonnet with live prices and reject them without a price", () => {
    const withPrices = buildRoutingTargetCatalog({ prices, env: {} });
    const ids = withPrices.targets.map((t) => t.id);
    expect(ids).toContain("vlm:openrouter/anthropic/claude-haiku-5.5");
    expect(ids).toContain("vlm:openrouter/anthropic/claude-sonnet-5.5");
    const haiku = withPrices.targets.find((t) => t.id.endsWith("claude-haiku-5.5"))!;
    expect(haiku.pricing).toMatchObject({ inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 });
    const missing = buildRoutingTargetCatalog({ env: {} });
    expect(missing.rejected.filter((r) => r.targetId.includes("claude-")).map((r) => r.reason)).toEqual(["missing-price", "missing-price"]);
    expect(missing.rejected.find((r) => r.targetId.includes("ling-3.0-flash-vl"))?.reason).toBe("missing-price");
  });

  it("admit the open Ling-3.0-flash-VL target with the live price, floor reasoning and the math role", () => {
    const catalog = buildRoutingTargetCatalog({ prices, env: {} });
    const ling = catalog.targets.find((t) => t.id === "vlm:openrouter/inclusionai/ling-3.0-flash-vl");
    expect(ling?.pricing).toMatchObject({ inputUsdPerMTok: 0.021, outputUsdPerMTok: 0.0616 });
    expect(ling?.roles).toEqual(expect.arrayContaining(["extract-text", "ocr", "table", "math"]));
    expect(ling?.escalationOnly).toBeUndefined();
    expect(lowestOpenRouterReasoning("inclusionai/ling-3.0-flash-vl")).toEqual({ effort: "none" });
  });

  it("keep open GPU models out unless their private endpoint env is set", () => {
    const off = buildRoutingTargetCatalog({ prices, env: {} });
    for (const p of TRANSCRIPTION_PRIVATE_MODELS) {
      expect(off.targets.some((t) => t.id === `vlm:private/${p.id}`)).toBe(false);
      expect(off.rejected.find((r) => r.targetId === `vlm:private/${p.id}`)?.reason).toBe("unavailable");
    }
    const on = buildRoutingTargetCatalog({ prices, env: { DOTS_OCR_ENDPOINT_URL: true } });
    const dots = on.targets.find((t) => t.id === "vlm:private/dots-ocr");
    expect(dots?.availability.privacyClass).toBe("private");
    expect(on.targets.some((t) => t.id === "vlm:private/olmocr-2")).toBe(false);
  });

  it("never include Pro/Ultra models", () => {
    for (const t of transcriptionTargets()) expect(t.id).not.toMatch(/(?:^|[/_:-])(pro|ultra)(?:$|[/_:-])/i);
  });

  it("have a verified lowest reasoning setting for every hosted model", () => {
    for (const t of transcriptionTargets().filter((x) => x.kind === "hosted-vlm")) {
      const model = t.ref.modelUri!.replace("llm://openrouter/", "");
      expect(lowestOpenRouterReasoning(model)).toBeDefined();
    }
  });
});
