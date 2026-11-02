import { nitroBaseModel } from "@docslurp/shared";
/**
 * Per-model overrides for hosted page transcription, keyed by the exact
 * OpenRouter model id. Models without an entry keep the generic defaults.
 */

import { openRouterReasoningParams, type OpenRouterReasoning } from "@docslurp/shared";

import { unwrapWholeMarkdownFence } from "./vision-markdown-fence.js";
import { normalizeMarkdownMathDelimiters } from "./vision-math-delimiters.js";
import { insertMissingTableDelimiters } from "./vision-table-delimiter.js";
import { normalizeVisionWhitespace } from "./vision-whitespace.js";

/** Shared evidence rules; relationships remain Markdown, not a new response schema. */
export const VISUAL_RELATIONSHIP_INSTRUCTIONS = [
  "Keep printed text verbatim. The visual evidence descriptions and explicitly marked approximate readings requested below are permitted additions to the transcription; they must be grounded in visible marks, not unrelated commentary.",
  "For charts, preserve legible titles, axes, units, tick labels, legends and series. Keep each value associated with its series and category or coordinate.",
  "Distinguish exact printed values from approximate visual readings. Only report an approximate visual reading when the marks and scale are legible, and label each such reading approximate; otherwise state that the value is unreadable or uncertain. Never infer hidden values.",
  "For diagrams, preserve visible arrow direction and endpoints, containment, and label-to-node or label-to-edge relationships as concise Markdown lines. Preserve visible relationships rather than flattening labels into an unrelated list. Never invent relationships; explicitly mark unclear endpoints, labels or direction as uncertain.",
].join("\n");

/** Markdown transcription that asks for LaTeX math, keeps text inside figures, and forbids layout padding or paraphrase. */
export const MARKDOWN_LATEX_VISION_PROMPT =
  "Transcribe this document page into GitHub-flavored Markdown, exactly as written. Copy every word verbatim in reading order; do not paraphrase, summarize, translate, correct the text or add unrelated descriptions. Include text, labels and formulas printed inside figures and diagrams. Use Markdown headings for headings, GFM tables for tables and lists for lists. Write every mathematical formula in LaTeX: inline math as $...$ and display equations as $$...$$ on their own lines. Do not reproduce column alignment, padding spaces or the page's line wrapping. Output only the Markdown." + "\n" + VISUAL_RELATIONSHIP_INSTRUCTIONS;

/**
 * Markdown transcription with explicit rules for tables (real tabular data only), multi-column reading order,
 * delimited LaTeX, text inside figures and one-line paragraphs.
 */
export const MARKDOWN_TRANSCRIPTION_VISION_PROMPT = [
  "Transcribe this document page into GitHub-flavored Markdown, exactly as printed and in natural reading order (in multi-column layouts, finish each column before starting the next).",
  "- Copy every visible word verbatim in its original language and script. Do not translate, summarize or add unrelated commentary.",
  "- Mark titles and section headings with # headings and bulleted or numbered items as Markdown lists.",
  "- Use a Markdown pipe table only for real tabular data: rows of values under column headers, such as line items, schedules, registers and timetables. Keep one table row per printed row. Do not turn page columns, side-by-side articles, cards, adverts or form fields into tables; write those as ordinary text, one block after another, and form fields as \"Label: value\" lines.",
  "- Write mathematical formulas and equations in LaTeX: inline formulas inside $...$ and each displayed equation inside its own $$...$$ block on separate lines, one block per printed equation line. Never output a formula without these delimiters. Keep ordinary words, numbers, footnote markers, identifiers and code as plain text.",
  "- Transcribe the text, labels and formulas printed inside figures, charts and diagrams, then their captions. Do not add image placeholders or unrelated picture descriptions.",
  "- Write each paragraph as a single line and separate paragraphs with a blank line.",
  VISUAL_RELATIONSHIP_INSTRUCTIONS,
  "Output only the Markdown transcription.",
].join("\n");

/** Page-wide Markdown transcription with LaTeX math, GFM tables for printed tables, and text inside figures. */
export const PAGE_MARKDOWN_LATEX_VISION_PROMPT = [
  "Transcribe this document page into GitHub-flavored Markdown. Copy every visible word verbatim in natural reading order: finish each column before starting the next, and keep headers, footers, captions and labels where they appear. Do not summarize, translate or add unrelated commentary.",
  "- Headings as # headings; lists as - or numbered lists.",
  "- Math: write every formula and equation in LaTeX, inline as $...$ and each equation set on its own line as $$...$$ (keep equation numbers with \\tag{}). Never write math as Unicode symbols, plain text or \\( \\) delimiters.",
  "- Tables: transcribe content printed as a table (ruled or column-aligned rows) as a GFM pipe table with one row per line, keeping header rows and every cell. Do not turn other content, such as diagrams or label-value lines, into tables.",
  "- Text inside charts, diagrams and figures: transcribe it with its visible relationships.",
  VISUAL_RELATIONSHIP_INSTRUCTIONS,
  "- Do not pad lines with alignment spaces. Output only the Markdown.",
].join("\n");

export type VisionProfilePromptKey = "markdown-latex" | "markdown-transcription" | "page-markdown-latex";

export interface OpenRouterProviderPreferences {
  order: string[];
  allow_fallbacks: boolean;
}

/**
 * First-attempt OpenRouter routing: a pinned `order`, or an `only` allowlist of measured hosts that OpenRouter
 * sorts by current price. An org or workspace without China-based providers narrows either to its allowed hosts
 * (openrouter-routing.ts `restrictToNonChinaProviders`, applied before every send).
 */
export type OpenRouterRoute =
  | OpenRouterProviderPreferences
  | { only: string[]; sort: "price"; allow_fallbacks: boolean };

export interface VisionModelProfile {
  /** Prompt template key used in place of the generic `<OCR>` default. Explicit other keys are kept. */
  defaultPrompt?: VisionProfilePromptKey;
  /** Output cap in tokens; `maxOutputTokensMode` says how it combines with VISION_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  /**
   * `default` (the default): used only when VISION_MAX_OUTPUT_TOKENS is unset, so the env overrides it.
   * `ceiling`: min(VISION_MAX_OUTPUT_TOKENS or the shared default, maxOutputTokens), so the env can only lower it.
   */
  maxOutputTokensMode?: "default" | "ceiling";
  /** OpenRouter routing for this model. */
  openRouterProvider?: OpenRouterRoute;
  /**
   * Reasoning control for page transcription. Kept here, not in the shared chat floor table, so it
   * never changes how the same model reasons in chat. Models without one fall back to `openRouterReasoningParams`.
   */
  reasoning?: OpenRouterReasoning;
  /** OpenAI-style `image_url.detail` sent with the page image. Unset sends no `detail`. */
  imageDetail?: "low" | "high" | "auto";
  /**
   * OpenRouter routing for a single retry when the first endpoint's output filter stops the page
   * (`finish_reason: "content_filter"`); filters differ per host for the same model. The retry's text is kept
   * and usage and cost are summed over both calls.
   * TODO: pending unification into the generic retry-on-refusal/length/content-filter mechanism (other branch);
   * fold this field into it then.
   */
  contentFilterRetryProvider?: OpenRouterProviderPreferences;
  /** Repair applied to the model's transcription text. */
  postProcess?: (text: string) => string;
}

/** Add a model with one entry; add a template to `visionPromptTemplates` only if it needs a new prompt. */
export const VISION_MODEL_PROFILES: Readonly<Record<string, VisionModelProfile>> = {
  // 2026-10-21 tune split (68 pages): with `<OCR>` this snapshot writes plain-text math
  // (`softmax(QK^T / √d_k) V`); the Markdown/LaTeX prompt lifts math partial 0.44 -> 0.86.
  // BaseTen served runaway repetition loops ("| | | …" to the cap) and word substitutions;
  // DeepSeek native and Together had none. Routing is restricted to hosts measured to transcribe faithfully:
  // US-hosted Together, Fireworks and Parasail (2026-10-22 select split: p50 2.2 / 4.1 / 3.6 s, equal quality,
  // 0 failures), and China-based StreamLake and DeepSeek (2026-10-29 tune + select, 95 pages each: content,
  // tables and math equal to Together within noise, 0 failures, p50 4.1-4.3 / 3.3-3.8 s).
  // Asking for text inside figures recovers formulas and labels printed in figures (+0.2 math on those pages).
  // The longest legitimate page was ~3k output tokens, so 8k bounds a runaway's cost.
  "deepseek/deepseek-v4.1-flash-1017": {
    defaultPrompt: "markdown-latex",
    maxOutputTokens: 8_192,
    // Effort `none` returns zero reasoning tokens; `low` cost 6.4x per page and lowered math.
    reasoning: { effort: "none" },
    // Keep the established hosts until disclosure, notice and rollout gates pass.
    openRouterProvider: { only: ["together", "fireworks", "parasail"], sort: "price", allow_fallbacks: true },
  },
  // 2026-10-21 tune: with `<OCR>` MiMo writes plain text: tables flatten into runs of cells, standalone
  // formulas come back as bare LaTeX with no `$`/`$$`, and figure text becomes an image placeholder.
  // Output: the longest complete page in 2,490 calls was 2,509 tokens; a repetition loop on a low-resource
  // script ran to the 16k cap (48 s), so 8k keeps 3x headroom and can only lower a smaller shared cap.
  // Routing: Relace (mxfp4) was fastest and cheapest at fp8 quality; DeepInfra had the next-best tail.
  // Unpinned routing spread calls onto Makora/Venice/Xiaomi (11-34 tok/s), which made the p95 tail.
  // Fallbacks stay on so an outage never fails a page.
  "xiaomi/mimo-v2.6-flash": {
    defaultPrompt: "markdown-transcription",
    maxOutputTokens: 8_192,
    maxOutputTokensMode: "ceiling",
    // Reasons by default; `{ effort: "none" }` and `{ enabled: false }` both return 0 reasoning tokens.
    reasoning: { effort: "none" },
    openRouterProvider: { order: ["relace", "deepinfra"], allow_fallbacks: true },
    postProcess: normalizeMarkdownMathDelimiters,
  },
  // 2026-10-21 tuning (tune split, 68 pages x 2): the LaTeX/table template lifts math and content F1;
  // detail "high" caps image tokens ~7% below the default. Downscaling to a 1,600 px long side saved another ~13%
  // but blurred dense non-Latin script (Hebrew content F1 0.99 -> 0.95), so pages go at full size.
  // Probes: effort none, minimal and `{ enabled: false }` all return 200; unset spends ~240 reasoning tokens on a page.
  "openai/gpt-6-luna": {
    defaultPrompt: "page-markdown-latex",
    imageDetail: "high",
    reasoning: { effort: "none" },
    // Rare: some models wrap the whole page in a ```markdown fence.
    postProcess: unwrapWholeMarkdownFence,
    // OpenAI's output filter deterministically stops some ordinary published pages (corporate filings,
    // government guidance) mid-page; Bedrock and Azure US transcribed them. Bedrock lists $0.11/$0.55 per M.
    contentFilterRetryProvider: { order: ["amazon-bedrock/us-east-1", "azure/us"], allow_fallbacks: false },
  },
  // 2026-10-21 tune split (68 pages): with `<OCR>` GLM writes math as Unicode prose and matrices as
  // box-drawing art, and describes figures ("[Figure: plot of …]"); the template lifts content F1 0.922 -> 0.963,
  // reading order 0.781 -> 0.838 and math 0.837 -> 0.988 at the same token cost.
  // Routing: quality was flat across 15 endpoints (fp4 matched fp8), except OpenInference, which drops the
  // image (~590 input tokens a page) and invents the page. Wafer was fastest and about half Friendli's
  // reported cost; Friendli and InferenceNet back it up. Fallbacks stay off so a page never reaches an
  // endpoint that ignores the image.
  // Output: the longest complete page was ~2.4k tokens; rare separator loops (`- - -`, `_ _ _`) ran to the
  // 16k cap, so 8k bounds their cost and latency and can only lower a smaller shared cap.
  "z-ai/glm-5.3-flash": {
    defaultPrompt: "markdown-transcription",
    maxOutputTokens: 8_192,
    maxOutputTokensMode: "ceiling",
    // Same as the shared chat floor, pinned here so chat changes never move vision. Its endpoints reject
    // `none` and `{ enabled: false }` ("Reasoning is mandatory"); minimal spends ~1 reasoning token a page.
    reasoning: { effort: "minimal" },
    openRouterProvider: { order: ["wafer/nvfp4", "friendli", "inference-net/fp4"], allow_fallbacks: false },
    // ~3% of its pipe tables (course lists, price lists) arrive without the `| --- |` row and would render
    // as literal text; the repair restored them (tables tolerant +0.32 and +0.51 on the affected pages).
    postProcess: insertMissingTableDelimiters,
  },
};

export function visionModelProfile(model: string | undefined): VisionModelProfile | undefined {
  return model ? VISION_MODEL_PROFILES[nitroBaseModel(model) ?? model] : undefined;
}

/** The template key to use for `model`: the profile default replaces an unset or `<OCR>` prompt. */
export function visionPromptKeyForModel(prompt: string | undefined, model: string | undefined): string | undefined {
  const key = prompt?.trim();
  const profileDefault = visionModelProfile(model)?.defaultPrompt;
  return profileDefault && (!key || key === "<OCR>") ? profileDefault : prompt;
}

/** Request-body fragment with the profile's OpenRouter routing, or nothing. */
export function openRouterProviderParams(model: string | undefined): { provider?: OpenRouterRoute } {
  // Nitro chooses throughput-ranked providers, not the baseline profile order.
  if (model && nitroBaseModel(model)) return {};
  const provider = visionModelProfile(model)?.openRouterProvider;
  if (!provider) return {};
  return "only" in provider
    ? { provider: { only: [...provider.only], sort: provider.sort, allow_fallbacks: provider.allow_fallbacks } }
    : { provider: { order: [...provider.order], allow_fallbacks: provider.allow_fallbacks } };
}

/**
 * Output cap for `model`. `shared` is the generic cap and whether VISION_MAX_OUTPUT_TOKENS set it:
 * a `default` profile cap applies only when the env is unset; a `ceiling` cap never exceeds the shared value.
 */
export function visionOutputCapForModel(model: string | undefined, shared: { value: number; configured: boolean }): number {
  const profile = visionModelProfile(model);
  if (profile?.maxOutputTokens === undefined) return shared.value;
  if (profile.maxOutputTokensMode === "ceiling") return Math.min(shared.value, profile.maxOutputTokens);
  return shared.configured ? shared.value : profile.maxOutputTokens;
}

/**
 * Post-process a page transcription from any vision/OCR model: the model's profile repair (if any), then the
 * shared padding-whitespace collapse. Runs after the repair so a whole-page fence is unwrapped before the
 * collapse skips fenced code.
 */
export function postProcessVisionText(model: string | undefined, text: string): string {
  return normalizeVisionWhitespace(visionModelProfile(model)?.postProcess?.(text) ?? text);
}

/** Request-body fragment with the reasoning control for `model`: the profile's, else the shared verified floor. */
export function visionReasoningParams(model: string | undefined): { reasoning?: OpenRouterReasoning } {
  const reasoning = visionModelProfile(model)?.reasoning;
  return reasoning ? { reasoning: { ...reasoning } } : openRouterReasoningParams(model);
}

/** `image_url` fields beyond `url` for `model` (currently the profile's `detail`). */
export function visionImageUrlOptions(model: string | undefined): { detail?: "low" | "high" | "auto" } {
  const detail = visionModelProfile(model)?.imageDetail;
  return detail ? { detail } : {};
}

/** Provider routing for the one content-filter retry of `model`, or undefined when it has none. */
export function contentFilterRetryProvider(model: string | undefined): OpenRouterProviderPreferences | undefined {
  const provider = visionModelProfile(model)?.contentFilterRetryProvider;
  return provider ? { order: [...provider.order], allow_fallbacks: provider.allow_fallbacks } : undefined;
}
