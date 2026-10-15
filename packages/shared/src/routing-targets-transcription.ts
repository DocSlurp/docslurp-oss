import type { AssignmentRole, RoutingTarget } from "./page-routing.js";
import { ROUTING_TARGET_SCHEMA_VERSION } from "./page-routing.js";

// Page-transcription targets added after the seed catalog (E2, 2026-10-12; EV1 added Ling-3.0-flash-VL). They are plain candidates
// for the catalog's `extraTargets` input, so they pass the same admission as every seed target
// (Pro/Ultra ban, output price < $50/M, image input, live price present). Reasoning effort for each
// hosted model is pinned in openrouter-usage.ts (OPENROUTER_LOWEST_REASONING), not here.

const TABLE_CAPABLE_ROLES: AssignmentRole[] = ["extract-text", "ocr", "table", "image-label"];
const MATH_CAPABLE_ROLES: AssignmentRole[] = [...TABLE_CAPABLE_ROLES, "math"];
const STRONG_ROLES: AssignmentRole[] = [...TABLE_CAPABLE_ROLES, "chart-data", "math", "diagram"];
const PRIVATE_ROLES: AssignmentRole[] = ["ocr", "extract-text", "table"];

/** Hosted OpenRouter models. `Sonnet` is the quality comparator and selective-review/escalation target. */
export const TRANSCRIPTION_HOSTED_MODELS = [
  { model: "anthropic/claude-haiku-5.5", roles: TABLE_CAPABLE_ROLES, escalationOnly: false },
  // EV1 (internal research notes): open weights (MIT), effort none, eval-suite tolerant
  // content 0.900 / pass 0.811 / math 0.826 at $0.14 per 1k pages via OpenRouter, ahead of GLM-5.3-Flash at ~1/6 of its cost.
  // Pure OCR specialists (LightOnOCR) skipped image insets in the routing suite; this general VLM transcribes them.
  { model: "inclusionai/ling-3.0-flash-vl", roles: MATH_CAPABLE_ROLES, escalationOnly: false },
  // Escalation-only: never a primary candidate, only a cascade leg (the planner honours RoutingTarget.escalationOnly).
  { model: "anthropic/claude-sonnet-5.5", roles: STRONG_ROLES, escalationOnly: true },
] as const;

/**
 * Open OCR/VLM models served from an operator-run private endpoint. Env-gated: absent
 * unless `<env>` is set, and never provisioned by DocSlurp (no GPU rentals).
 */
export const TRANSCRIPTION_PRIVATE_MODELS = [
  { id: "dots-ocr", env: "DOTS_OCR_ENDPOINT_URL", latex: false },
  { id: "olmocr-2", env: "OLMOCR_2_ENDPOINT_URL", latex: false },
  { id: "nanonets-ocr2", env: "NANONETS_OCR2_ENDPOINT_URL", latex: true },
  { id: "deepseek-ocr-2", env: "DEEPSEEK_OCR_2_ENDPOINT_URL", latex: false },
] as const;

function target(
  id: string,
  kind: RoutingTarget["kind"],
  modelUri: string,
  roles: AssignmentRole[],
  capabilities: Partial<RoutingTarget["capabilities"]>,
  privacyClass: RoutingTarget["availability"]["privacyClass"],
  requiresEnv: string[],
  escalationOnly = false,
): RoutingTarget {
  return {
    schemaVersion: ROUTING_TARGET_SCHEMA_VERSION,
    id,
    kind,
    ref: { modelUri },
    roles: [...roles],
    ...(escalationOnly ? { escalationOnly: true } : {}),
    capabilities: {
      imageInput: true,
      multiImagePerRequest: false,
      maxImagesPerRequest: 1,
      maxImageLongEdgePx: null,
      emitsLatex: false,
      emitsHtmlTables: false,
      usesNativeTextLayer: false,
      ...capabilities,
    },
    // Hosted prices are filled from the live price map during admission; private ones from the endpoint.
    pricing: { source: "local-compute", checkedAt: "unpriced" },
    latency: { p50Ms: 0, p95Ms: 0, source: "unmeasured", n: 0 },
    availability: { requiresEnv, privacyClass },
  };
}

export function transcriptionTargets(): RoutingTarget[] {
  return [
    ...TRANSCRIPTION_HOSTED_MODELS.map((m) =>
      target(
        `vlm:openrouter/${m.model}`,
        "hosted-vlm",
        `llm://openrouter/${m.model}`,
        [...m.roles],
        { multiImagePerRequest: true, maxImagesPerRequest: 16 },
        "hosted",
        ["OPENROUTER_API_KEY"],
        m.escalationOnly,
      ),
    ),
    ...TRANSCRIPTION_PRIVATE_MODELS.map((p) =>
      target(
        `vlm:private/${p.id}`,
        "private-vlm",
        `llm://private/${p.id}`,
        p.latex ? [...PRIVATE_ROLES, "math"] : PRIVATE_ROLES,
        { emitsLatex: p.latex, emitsHtmlTables: true },
        "private",
        [p.env],
      ),
    ),
  ];
}
