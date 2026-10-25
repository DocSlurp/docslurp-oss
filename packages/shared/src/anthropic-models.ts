// Anthropic (Claude) model policy.
//
// Only the 5.5 generation is supported. Any older Claude model id — native
// (`claude-sonnet-4-5-20250929`) or OpenRouter (`anthropic/claude-sonnet-4.5`)
// — is deprecated and resolves to its family's 5.5 replacement at call time,
// so stored settings, saved workspaces and API callers keep working. Fable and
// Mythos map to Opus 5.5 (their $50/MTok output price is also outside the
// internal cost policy). Prices verified 2026-10-25 against
// platform.claude.com pricing and the OpenRouter models API.

export type AnthropicModelFamily = "opus" | "sonnet" | "haiku";

export type AnthropicModel = {
  id: string;
  openRouterId: string;
  label: string;
  family: AnthropicModelFamily;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Prompts above the threshold are billed at the long-context rates. */
  longContext?: {
    thresholdInputTokens: number;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
  };
};

export const MIN_SUPPORTED_ANTHROPIC_VERSION = 5.5;

export const ANTHROPIC_MODELS: readonly AnthropicModel[] = [
  {
    id: "claude-opus-5-5",
    openRouterId: "anthropic/claude-opus-5.5",
    label: "Claude Opus 5.5",
    family: "opus",
    inputUsdPerMTok: 4,
    outputUsdPerMTok: 20,
  },
  {
    id: "claude-sonnet-5-5",
    openRouterId: "anthropic/claude-sonnet-5.5",
    label: "Claude Sonnet 5.5",
    family: "sonnet",
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
  },
  {
    id: "claude-haiku-5-5",
    openRouterId: "anthropic/claude-haiku-5.5",
    label: "Claude Haiku 5.5",
    family: "haiku",
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    longContext: { thresholdInputTokens: 100_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
  },
];

const FAMILY_REPLACEMENT: Record<string, AnthropicModelFamily> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  fable: "opus",
  mythos: "opus",
};

export type ParsedAnthropicModel = {
  family: string;
  version: number;
  openRouter: boolean;
};

/**
 * Parse a Claude model id in any of the forms we see in settings and logs:
 * `claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-0`,
 * `claude-3-5-sonnet-20241022`, `anthropic/claude-opus-4.8`, `...:batch`.
 * Returns null for anything that is not a Claude model.
 */
export function parseAnthropicModelId(modelId: string | null | undefined): ParsedAnthropicModel | null {
  const raw = (modelId ?? "").trim().toLowerCase();
  const openRouter = raw.startsWith("anthropic/");
  const bare = raw.replace(/^anthropic\//, "").replace(/:[a-z-]+$/, "").replace(/-\d{8}$/, "").replace(/@\d{8}$/, "");
  if (!bare.startsWith("claude-")) return null;

  // Current naming: claude-<family>-<major>[-.<minor>]
  const modern = /^claude-([a-z]+)-(\d+)(?:[-.](\d+))?$/.exec(bare);
  if (modern) {
    return { family: modern[1]!, version: Number(`${modern[2]}.${modern[3] ?? 0}`), openRouter };
  }
  // Legacy naming: claude-<major>[-<minor>]-<family>
  const legacy = /^claude-(\d+)(?:[-.](\d+))?-([a-z]+)$/.exec(bare);
  if (legacy) {
    return { family: legacy[3]!, version: Number(`${legacy[1]}.${legacy[2] ?? 0}`), openRouter };
  }
  return null;
}

export function isDeprecatedAnthropicModel(modelId: string | null | undefined): boolean {
  const parsed = parseAnthropicModelId(modelId);
  return parsed !== null && parsed.version < MIN_SUPPORTED_ANTHROPIC_VERSION;
}

export type ResolvedModel = {
  /** The id to send to the provider. */
  model: string;
  requested: string;
  deprecated: boolean;
};

/**
 * Map deprecated Claude ids to their supported replacement, keeping the id
 * format (native vs OpenRouter). Non-Claude ids pass through unchanged.
 */
export function resolveSupportedModelId(modelId: string): ResolvedModel {
  const parsed = parseAnthropicModelId(modelId);
  if (!parsed || parsed.version >= MIN_SUPPORTED_ANTHROPIC_VERSION) {
    return { model: modelId, requested: modelId, deprecated: false };
  }
  const family = FAMILY_REPLACEMENT[parsed.family] ?? "sonnet";
  const replacement = ANTHROPIC_MODELS.find((model) => model.family === family)!;
  return {
    model: parsed.openRouter ? replacement.openRouterId : replacement.id,
    requested: modelId,
    deprecated: true,
  };
}

const warned = new Set<string>();

/** Resolve and log once per process when a deprecated id is substituted. */
export function resolveSupportedModelIdWithWarning(modelId: string): string {
  const resolved = resolveSupportedModelId(modelId);
  if (resolved.deprecated && !warned.has(resolved.requested)) {
    warned.add(resolved.requested);
    console.warn(`[ai-models] deprecated model=${resolved.requested} replaced_by=${resolved.model}`);
  }
  return resolved.model;
}
