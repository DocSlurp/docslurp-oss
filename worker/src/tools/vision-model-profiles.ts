/**
 * Per-model overrides for hosted page transcription, keyed by the exact
 * OpenRouter model id. Models without an entry keep the generic defaults.
 */

/** Markdown transcription that asks for LaTeX math and forbids layout padding or paraphrase. */
export const MARKDOWN_LATEX_VISION_PROMPT =
  "Transcribe this document page into GitHub-flavored Markdown, exactly as written. Copy every word verbatim in reading order; do not paraphrase, summarize, translate, correct or describe the page. Use Markdown headings for headings, GFM tables for tables and lists for lists. Write every mathematical formula in LaTeX: inline math as $...$ and display equations as $$...$$ on their own lines. Do not reproduce column alignment, padding spaces or the page's line wrapping. Output only the Markdown.";

export interface OpenRouterProviderPreferences {
  order: string[];
  allow_fallbacks: boolean;
}

export interface VisionModelProfile {
  /** Prompt template key used in place of the generic `<OCR>` default. Explicit other keys are kept. */
  defaultPrompt?: "markdown-latex";
  /** Output cap used when VISION_MAX_OUTPUT_TOKENS is not set. */
  maxOutputTokens?: number;
  /** OpenRouter routing for this model. */
  openRouterProvider?: OpenRouterProviderPreferences;
}

export const VISION_MODEL_PROFILES: Readonly<Record<string, VisionModelProfile>> = {
  // 2026-10-21 tune split (68 pages): with `<OCR>` this snapshot writes plain-text math
  // (`softmax(QK^T / √d_k) V`); the Markdown/LaTeX prompt lifts math partial 0.44 -> 0.86.
  // BaseTen served runaway repetition loops ("| | | …" to the cap) and word substitutions;
  // DeepSeek native and Together had none, so routing is restricted to them.
  // The longest legitimate page was ~3k output tokens, so 8k bounds a runaway's cost.
  "deepseek/deepseek-v4.1-flash-1017": {
    defaultPrompt: "markdown-latex",
    maxOutputTokens: 8_192,
    openRouterProvider: { order: ["deepseek", "together"], allow_fallbacks: false },
  },
};

export function visionModelProfile(model: string | undefined): VisionModelProfile | undefined {
  return model ? VISION_MODEL_PROFILES[model] : undefined;
}

/** The template key to use for `model`: the profile default replaces an unset or `<OCR>` prompt. */
export function visionPromptKeyForModel(prompt: string | undefined, model: string | undefined): string | undefined {
  const key = prompt?.trim();
  const profileDefault = visionModelProfile(model)?.defaultPrompt;
  return profileDefault && (!key || key === "<OCR>") ? profileDefault : prompt;
}

/** Request-body fragment with the profile's OpenRouter routing, or nothing. */
export function openRouterProviderParams(model: string | undefined): { provider?: OpenRouterProviderPreferences } {
  const provider = visionModelProfile(model)?.openRouterProvider;
  return provider ? { provider: { order: [...provider.order], allow_fallbacks: provider.allow_fallbacks } } : {};
}
