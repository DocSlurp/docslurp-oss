import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOSTED_EQUIVALENT_REFERENCES } from "../billing.js";
import { CHAT_MODEL_PRICES_USD_PER_MTOK } from "../chat-model-prices.js";
import {
  DEFAULT_OPENROUTER_VISION_MODEL,
  embeddingProfileCatalog,
  visionModelCatalog,
  visionProfileCatalog,
} from "../embedding.js";
import { DEFAULT_PIPELINE_TEXT_MODEL } from "../pipeline.js";
import {
  MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE,
  buildDecisionModelCatalog,
  buildRoutingTargetCatalog,
  isProhibitedRoutingModelId,
  type RoutingModelPriceMap,
} from "../routing-targets.js";
import { defaultAiUsagePricingCatalog } from "../usage.js";
import { DEFAULT_WORKSPACE_CHAT_MODEL, WORKSPACE_CHAT_MODELS } from "../workspace-chat-models.js";

// scripts/lib/model-prices.json keeps prohibited models (OpenAI Pro/Ultra, output >= $50 per 1M tokens) only as
// historical evidence for old traces and tests. This suite fails if any selectable catalog, default or preset can
// reach one, or if a prohibited entry is left unmarked.
const registry = JSON.parse(readFileSync(new URL("../../../../scripts/lib/model-prices.json", import.meta.url), "utf8")) as RoutingModelPriceMap & {
  models: Record<string, { input: number; output: number; prohibited?: string }>;
};

const modelIdOfUri = (uri: string) => uri.replace(/^llm:\/\/[^/]+\//, "");
const everyEnv = new Proxy({}, { get: () => true }) as Readonly<Record<string, boolean>>;

/** Every model id a customer, preset, default or the page router can select today. */
function selectableModelIds(): Map<string, string> {
  const ids = new Map<string, string>();
  const add = (id: string, where: string) => ids.set(id, ids.has(id) ? `${ids.get(id)}, ${where}` : where);
  for (const { id } of WORKSPACE_CHAT_MODELS) add(id, "WORKSPACE_CHAT_MODELS");
  add(DEFAULT_WORKSPACE_CHAT_MODEL, "DEFAULT_WORKSPACE_CHAT_MODEL");
  add(DEFAULT_PIPELINE_TEXT_MODEL, "DEFAULT_PIPELINE_TEXT_MODEL");
  add(DEFAULT_OPENROUTER_VISION_MODEL, "DEFAULT_OPENROUTER_VISION_MODEL");
  for (const model of Object.keys(CHAT_MODEL_PRICES_USD_PER_MTOK)) add(model, "CHAT_MODEL_PRICES_USD_PER_MTOK");
  for (const entry of visionModelCatalog) add(modelIdOfUri(entry.uri), "visionModelCatalog");
  for (const [key, profile] of Object.entries(visionProfileCatalog)) {
    if (profile.config.modelUri) add(modelIdOfUri(profile.config.modelUri), `visionProfileCatalog.${key}`);
  }
  for (const [key, profile] of Object.entries(embeddingProfileCatalog)) add(modelIdOfUri(profile.config.modelUri), `embeddingProfileCatalog.${key}`);
  for (const reference of Object.values(HOSTED_EQUIVALENT_REFERENCES)) add(reference.model, "HOSTED_EQUIVALENT_REFERENCES");
  for (const entry of defaultAiUsagePricingCatalog) add(entry.model, "defaultAiUsagePricingCatalog");
  const routing = buildRoutingTargetCatalog({ prices: registry, visionCatalog: visionModelCatalog, env: everyEnv });
  for (const target of routing.targets) if (target.ref.modelUri) add(modelIdOfUri(target.ref.modelUri), `page router ${target.id}`);
  for (const model of buildDecisionModelCatalog({ env: everyEnv }).models) add(model.id, "decision models");
  return ids;
}

describe("prohibited models", () => {
  it("marks every Pro/Ultra or >= $50 output entry in model-prices.json as prohibited", () => {
    for (const [id, price] of Object.entries(registry.models)) {
      const shouldBe = isProhibitedRoutingModelId(id) || price.output >= MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE;
      expect(Boolean(price.prohibited), id).toBe(shouldBe);
    }
    // The audit's list stays as evidence, marked rather than deleted.
    for (const id of ["openai/gpt-5.6-luna-pro", "openai/gpt-6-luna-pro", "openai/gpt-6-sol-pro", "openai/gpt-6-astra-pro", "openai/gpt-6-astra", "anthropic/claude-fable-5.1"]) {
      expect(registry.models[id]?.prohibited, id).toBeTruthy();
    }
  });

  it("is never selectable from a catalog, default, preset or the page router", () => {
    const selectable = selectableModelIds();
    expect(selectable.size).toBeGreaterThan(10);
    for (const [id, where] of selectable) {
      const label = `${id} (${where})`;
      expect(isProhibitedRoutingModelId(id), label).toBe(false);
      const price = registry.models[id] ?? registry.models[`openai/${id}`];
      expect(price?.prohibited, label).toBeUndefined();
      if (price) expect(price.output, label).toBeLessThan(MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE);
    }
  });

  it("makes the page router reject a marked price entry even when its id and price look allowed", () => {
    const prices: RoutingModelPriceMap = { models: { "acme/plain-vl": { input: 0.1, output: 0.4, vision: true, prohibited: "output-price>=50" } } };
    const { targets, rejected } = buildRoutingTargetCatalog({
      prices,
      visionCatalog: [{ id: "acme/plain-vl", uri: "llm://openrouter/acme/plain-vl", target: "hosted" }],
      env: everyEnv,
    });
    expect(targets.some((target) => target.ref.modelUri === "llm://openrouter/acme/plain-vl")).toBe(false);
    expect(rejected).toContainEqual(expect.objectContaining({ reason: "prohibited-model", detail: expect.stringContaining("output-price>=50") }));
  });
});
