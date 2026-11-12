/**
 * Reviewed route-tier options (provider-tiers.ts). Adding a host to a pool sends customer data to it: add one only
 * after its output is measured on the capability's eval and it is a disclosed subprocessor, and record the run.
 *
 * - page-ocr pools are the approved transcription pools of worker/src/tools/vision-model-profiles.ts (a worker test
 *   keeps them equal), so a tier never reaches a host the default route would not.
 * - chat pools: hosts serving the model at FP8 or better (or undisclosed, as the default chat routing allows), all
 *   from distinct providers.
 * - evalScore stays null until a recorded eval run measures the option; unmeasured options are never "best".
 * - Together is omitted from every pool (owner, 2026-11-12): its DeepSeek V4.1 Flash 1017 endpoint fabricated page
 *   bodies on the tier benchmark (quality 0.565 and 0.301 against Fireworks 0.786 and 0.784).
 */
import type { TierOption } from "./provider-tiers.js";

export const TIER_OPTIONS: readonly TierOption[] = Object.freeze([
  {
    id: "page-ocr/deepseek-v4.1-flash-1017",
    capability: "page-ocr",
    model: "deepseek/deepseek-v4.1-flash-1017",
    pool: { hosts: ["fireworks", "parasail"], sort: "latency" },
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "page-ocr/glm-5.3-flash",
    capability: "page-ocr",
    model: "z-ai/glm-5.3-flash",
    pool: { hosts: ["wafer/nvfp4", "friendli", "inference-net/fp4"], sort: "price" },
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "page-ocr/mimo-v2.6-flash",
    capability: "page-ocr",
    model: "xiaomi/mimo-v2.6-flash",
    pool: { hosts: ["relace", "deepinfra"], sort: "order", fallbackBeyondPool: true },
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/glm-5.3-flash",
    capability: "chat",
    model: "z-ai/glm-5.3-flash",
    pool: { hosts: ["fireworks", "friendli"], sort: "price" },
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/deepseek-v4.1-flash-1017",
    capability: "chat",
    model: "deepseek/deepseek-v4.1-flash-1017",
    pool: { hosts: ["deepinfra/fp8", "fireworks", "parasail/fp8"], sort: "price" },
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/claude-haiku-5.5",
    capability: "chat",
    model: "anthropic/claude-haiku-5.5",
    pool: { hosts: ["anthropic", "google-vertex", "amazon-bedrock"], sort: "latency" },
    tiers: ["fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/gpt-6-luna",
    capability: "chat",
    model: "openai/gpt-6-luna",
    pool: { hosts: ["openai", "azure"], sort: "latency" },
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
]);

/** Models any tier option can route to: what the observation poller tracks. */
export function tierOptionModels(options: readonly TierOption[] = TIER_OPTIONS): string[] {
  return [...new Set(options.map((option) => option.model))].sort();
}
