import { nitroBaseModel } from "../workspace-chat-models.js";
import { openRouterProviderPreferences } from "../openrouter-routing.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_MODEL_PRICES_USD_PER_MTOK, chatModelPricePerToken } from "../chat-model-prices.js";
import { MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE, isProhibitedRoutingModelId } from "../routing-targets.js";
import { WORKSPACE_CHAT_MODELS } from "../workspace-chat-models.js";

const table = JSON.parse(readFileSync(new URL("../../../../scripts/lib/model-prices.json", import.meta.url), "utf8")) as {
  models: Record<string, { input: number; output: number }>;
};

describe("chat model prices", () => {
  it("mirrors scripts/lib/model-prices.json exactly", () => {
    for (const [model, price] of Object.entries(CHAT_MODEL_PRICES_USD_PER_MTOK)) {
      expect(table.models[model], model).toBeDefined();
      expect({ input: table.models[model]!.input, output: table.models[model]!.output }, model).toEqual(price);
    }
  });
  it("prices every catalog chat model and admits no prohibited or over-priced model", () => {
    for (const { id } of WORKSPACE_CHAT_MODELS) {
      if (nitroBaseModel(id)) {
        // Dynamic Nitro endpoints have no static base price: enforce an explicit low ceiling instead.
        expect(openRouterProviderPreferences(id)?.max_price, id).toEqual({ prompt: 1, completion: 5 });
        expect(chatModelPricePerToken(id), id).toBeUndefined();
      } else expect(CHAT_MODEL_PRICES_USD_PER_MTOK[id], id).toBeDefined();
    }
    for (const [model, price] of Object.entries(CHAT_MODEL_PRICES_USD_PER_MTOK)) {
      expect(isProhibitedRoutingModelId(model), model).toBe(false);
      expect(price.output, model).toBeLessThan(MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE);
    }
  });
  it("converts to USD per token", () => {
    expect(chatModelPricePerToken("z-ai/glm-5.3-flash")).toEqual({ input: 0.15 / 1e6, output: 0.5 / 1e6 });
    expect(chatModelPricePerToken("unknown/model")).toBeUndefined();
  });
});
