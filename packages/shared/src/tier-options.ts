/**
 * Reviewed route-tier options (provider-tiers.ts). Adding a host to a pool sends customer data to it: add one only
 * after its output is measured on the capability's eval and it is a disclosed subprocessor, and record the run.
 *
 * - page-ocr pools are the approved transcription pools of worker/src/tools/vision-model-profiles.ts (a worker test
 *   keeps them equal), so a tier never reaches a host the default route would not.
 * - chat pools: hosts serving the model at FP8 or better (or undisclosed, as the default chat routing allows), all
 *   from distinct providers.
 * - Pools are `llm://` entries, one per host (`?_provider=`); pool options (`_sort`, `_fallbacks`, `_timeout`,
 *   `_minUptime`, `_maxAge`, `_preferredMargin`) are written once, on the first entry. See provider-pools.ts.
 * - evalScore stays null until a recorded eval run measures the option; unmeasured options are never "best".
 * - Together is omitted from every pool (owner, 2026-11-12): its DeepSeek V4.1 Flash 1017 endpoint fabricated page
 *   bodies on the tier benchmark (quality 0.565 and 0.301 against Fireworks 0.786 and 0.784).
 * - DeepSeek V4.1 Flash is never an option (owner, 2026-11-13): it is never selected automatically
 *   (automatic-model-selection.ts), and assertTierOptions refuses it.
 */
import { defineTierOptions, type TierOption } from "./provider-tiers.js";

const GLM = "llm://openrouter/z-ai/glm-5.3-flash";
const MIMO = "llm://openrouter/xiaomi/mimo-v2.6-flash";
const HAIKU = "llm://openrouter/anthropic/claude-haiku-5.5";
const LUNA = "llm://openrouter/openai/gpt-6-luna";

export const TIER_OPTIONS: readonly TierOption[] = defineTierOptions([
  {
    id: "page-ocr/glm-5.3-flash",
    capability: "page-ocr",
    pool: [`${GLM}?_provider=wafer/nvfp4&_sort=price`, `${GLM}?_provider=friendli`, `${GLM}?_provider=inference-net/fp4`],
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "page-ocr/mimo-v2.6-flash",
    capability: "page-ocr",
    pool: [`${MIMO}?_provider=relace&_sort=order&_fallbacks=true`, `${MIMO}?_provider=deepinfra`],
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/glm-5.3-flash",
    capability: "chat",
    pool: [`${GLM}?_provider=fireworks&_sort=price`, `${GLM}?_provider=friendli`],
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/claude-haiku-5.5",
    capability: "chat",
    pool: [`${HAIKU}?_provider=anthropic&_sort=latency`, `${HAIKU}?_provider=google-vertex`, `${HAIKU}?_provider=amazon-bedrock`],
    tiers: ["fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/gpt-6-luna",
    capability: "chat",
    pool: [`${LUNA}?_provider=openai&_sort=latency`, `${LUNA}?_provider=azure`],
    tiers: ["cheapest", "fastest", "best"],
    evalScore: null,
    evalRef: null,
  },
]);

/** Models any tier option can route to: what the observation poller tracks. */
export function tierOptionModels(options: readonly TierOption[] = TIER_OPTIONS): string[] {
  return [...new Set(options.map((option) => option.model))].sort();
}
