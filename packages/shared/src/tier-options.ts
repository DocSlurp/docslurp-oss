/**
 * Reviewed route-tier options (provider-tiers.ts). Adding a host to a pool sends customer data to it: add one only
 * after its output is measured on the capability's eval and it is a disclosed subprocessor, and record the run.
 *
 * - page-ocr pools are the approved transcription pools of worker/src/tools/vision-model-profiles.ts (a worker test
 *   keeps them equal), so a tier never reaches a host the default route would not.
 * - chat pools: hosts serving the model at FP8 or better (or undisclosed, as the default chat routing allows), all
 *   from distinct providers. They are host candidates only: which model answers a chat tier is CHAT_TIER_MODELS
 *   (project-chat-models.ts) plus a project's admin overrides, and nothing routes chat through these options yet.
 * - Every option passes the call-time policy (model-call-policy.ts) at load and again at selection: no Pro/Ultra, no
 *   denied model, no known output price at or above $50 per 1M tokens; a host observed at or above that cap is skipped.
 * - Pools are `llm://` entries, one per host (`?_provider=`); pool options (`_sort`, `_fallbacks`, `_timeout`,
 *   `_minUptime`, `_maxAge`, `_preferredMargin`) are written once, on the first entry. See provider-pools.ts.
 * - evalScore is the option's composite on its capability's tier benchmark: for page-ocr, the mean tolerant-markdown@v1
 *   `content` (mean of the applicable tolerant text, tables and math components) over the development page-OCR items,
 *   with the per-component scores kept in the run (evalRef). "smart" ranks by it (owner, 2026-11-13). It stays null
 *   until a recorded run measures the option on that scale; unmeasured options are never "smart". Chat has no
 *   composite on a shared scale yet.
 * - Together is omitted from every pool (owner, 2026-11-12): its DeepSeek V4.1 Flash 1017 endpoint fabricated page
 *   bodies on the tier benchmark (composite 0.673 and 0.333 against Fireworks 0.938 and 0.938).
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
    tiers: ["fastest", "balanced", "smart"],
    // Tier benchmark v1, development page OCR (67 items), production pool: composite 0.934 (tolerant text 0.919,
    // tables 0.930, math 1.000).
    evalScore: 0.934,
    evalRef: "tier-benchmark-v1/page-ocr/development/dev-page-ocr-20261112-r2",
  },
  {
    id: "page-ocr/mimo-v2.6-flash",
    capability: "page-ocr",
    pool: [`${MIMO}?_provider=relace&_sort=order&_fallbacks=true`, `${MIMO}?_provider=deepinfra`],
    tiers: ["fastest", "balanced", "smart"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/glm-5.3-flash",
    capability: "chat",
    pool: [`${GLM}?_provider=fireworks&_sort=price`, `${GLM}?_provider=friendli`],
    tiers: ["fastest", "balanced", "smart"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/claude-haiku-5.5",
    capability: "chat",
    pool: [`${HAIKU}?_provider=anthropic&_sort=latency`, `${HAIKU}?_provider=google-vertex`, `${HAIKU}?_provider=amazon-bedrock`],
    tiers: ["fastest", "smart"],
    evalScore: null,
    evalRef: null,
  },
  {
    id: "chat/gpt-6-luna",
    capability: "chat",
    pool: [`${LUNA}?_provider=openai&_sort=latency`, `${LUNA}?_provider=azure`],
    tiers: ["fastest", "balanced", "smart"],
    evalScore: null,
    evalRef: null,
  },
]);

/** Models any tier option can route to: what the observation poller tracks. */
export function tierOptionModels(options: readonly TierOption[] = TIER_OPTIONS): string[] {
  return [...new Set(options.map((option) => option.model))].sort();
}
