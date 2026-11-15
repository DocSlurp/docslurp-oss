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
import { defineTierOptions, type RouteTier, type TierOption } from "./provider-tiers.js";

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

/**
 * Scanned-page OCR route (worker/src/ocr): which reader reads a scanned page at each tier. Same vocabulary (fastest /
 * balanced / smart), same rule: "smart" ranks measured options by eval composite on the page-OCR tier benchmark
 * (tier-benchmark-v1, development, 67 items; tolerant-markdown@v1 `content`), and an unmeasured option is never "smart".
 *
 * - recogniser: the OCR VM's recogniser read alone. Pages it doubts still go to hosted escalation when it is on, as
 *   today.
 * - hosted-escalation: the hosted escalation reader (DOCSLURP_OCR_ESCALATION_MODEL; never a model that is not selected
 *   automatically) reads the pages the recogniser doubts.
 * - page-reader: the registered page image reader plugin (extractors/plugins.ts pageImageReader) reads pages in its
 *   own isolated VM. Its score is the provider's own measurement (`PageImageReaderProvider.evalScore`), because which
 *   reader is registered is a deployment's choice; without one the option is unmeasured. The hosted escalation reader
 *   stays the fallback for every page the page reader does not return.
 *
 * These are the OCR route's options only. The hosted page transcription options above (capability "page-ocr", vision
 * reads) are a different route and are not ranked against them.
 */
export const OCR_ROUTE_READERS = ["recogniser", "hosted-escalation", "page-reader"] as const;
export type OcrRouteReader = (typeof OCR_ROUTE_READERS)[number];

export interface OcrRouteOption {
  readonly id: string;
  readonly reader: OcrRouteReader;
  /** The model the score was measured on (hosted escalation): another configured model is unmeasured. */
  readonly model?: string;
  readonly tiers: readonly RouteTier[];
  readonly evalScore: number | null;
  readonly evalRef: string | null;
}

export const OCR_ROUTE_OPTIONS: readonly OcrRouteOption[] = Object.freeze([
  {
    id: "scan-ocr/recogniser",
    reader: "recogniser",
    tiers: ["fastest"],
    // Composite 0.477 (tolerant text 0.814, tables 0.000, math 0.000): no tables or math.
    evalScore: 0.477,
    evalRef: "tier-benchmark-v1/page-ocr/development/dev-page-ocr-20261113-runpod",
  },
  {
    id: "scan-ocr/hosted-escalation",
    reader: "hosted-escalation",
    model: "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct",
    tiers: ["balanced", "smart"],
    // Production route and prompt: composite 0.913 (tolerant text 0.922, tables 0.874, math 0.989).
    evalScore: 0.913,
    evalRef: "tier-benchmark-v1/page-ocr/development/dev-page-ocr-20261114-gpu-tier",
  },
  {
    id: "scan-ocr/page-reader",
    reader: "page-reader",
    tiers: ["balanced", "smart"],
    evalScore: null,
    evalRef: null,
  },
] satisfies OcrRouteOption[]);

/** What a tier's OCR route does: the page reader's mode (DOCSLURP_OCR_PAGE_READER values) and hosted escalation. */
export interface OcrRoute {
  readonly optionId: string;
  readonly pageReader: "off" | "escalation" | "all";
  readonly hostedEscalation: boolean;
}

export interface OcrRouteAvailability {
  /** The registered page reader and its measured composite (null: unmeasured), or null when none is registered. */
  readonly pageReader: { readonly evalScore: number | null } | null;
  /** Whether hosted escalation is enabled for this deployment. */
  readonly hostedEscalation: boolean;
  /** The configured escalation model (DOCSLURP_OCR_ESCALATION_MODEL); unset means the default the score was measured on. */
  readonly hostedEscalationModel?: string | null;
}

/**
 * The OCR route of a tier. fastest: the recogniser alone (doubted pages still escalate when escalation is on).
 * smart: the best-scored available reader of every scanned page, the hosted escalation reader as the fallback.
 * balanced: the page reader on the pages the recogniser doubts when one is registered and measured, else hosted
 * escalation of those pages. A reader without a score, or scoring at or under the recogniser alone, is never chosen; a
 * hosted escalation model other than the one measured is unmeasured.
 */
export function selectOcrRoute(tier: RouteTier, available: OcrRouteAvailability, options: readonly OcrRouteOption[] = OCR_ROUTE_OPTIONS): OcrRoute {
  const escalation = available.hostedEscalation;
  const score = (option: OcrRouteOption): number | null => {
    if (option.reader === "page-reader") {
      const measured = available.pageReader?.evalScore;
      return typeof measured === "number" && Number.isFinite(measured) && measured >= 0 && measured <= 1 ? measured : null;
    }
    if (option.reader === "hosted-escalation") {
      if (!escalation) return null;
      const configured = available.hostedEscalationModel?.trim();
      if (configured && option.model && configured !== option.model) return null;
    }
    return option.evalScore;
  };
  const recogniser = options.find((option) => option.reader === "recogniser")!;
  const floor = recogniser.evalScore ?? 0;
  const eligible = options.filter((option) => option.tiers.includes(tier) && (score(option) ?? -1) > floor);
  const fallback: OcrRoute = { optionId: recogniser.id, pageReader: "off", hostedEscalation: escalation };
  if (tier === "fastest" || !eligible.length) return fallback;
  if (tier === "smart") {
    const best = [...eligible].sort((a, b) => score(b)! - score(a)!)[0]!;
    return best.reader === "page-reader"
      ? { optionId: best.id, pageReader: "all", hostedEscalation: escalation }
      : { optionId: best.id, pageReader: "off", hostedEscalation: escalation };
  }
  const reader = eligible.find((option) => option.reader === "page-reader");
  if (reader) return { optionId: reader.id, pageReader: "escalation", hostedEscalation: escalation };
  const hosted = eligible.find((option) => option.reader === "hosted-escalation");
  return hosted ? { optionId: hosted.id, pageReader: "off", hostedEscalation: true } : fallback;
}
