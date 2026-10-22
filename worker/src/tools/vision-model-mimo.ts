/**
 * Page-transcription profile for `xiaomi/mimo-v2.6-flash` (tuned 2026-10-21).
 *
 * With the generic `<OCR>` prompt MiMo writes plain text: tables flatten into
 * runs of cells, standalone formulas come back as bare LaTeX with no `$`/`$$`
 * delimiters, and text inside figures is replaced by an image placeholder.
 * This profile gives it an explicit Markdown transcription prompt and prefers
 * its fastest OpenRouter endpoints. It is scoped to this exact model id; every
 * other model keeps the shared templates and OpenRouter's default routing.
 */

export const MIMO_VISION_MODEL = "xiaomi/mimo-v2.6-flash";

export const MIMO_TRANSCRIPTION_PROMPT = [
  "Transcribe this document page into GitHub-flavored Markdown, exactly as printed and in natural reading order (in multi-column layouts, finish each column before starting the next).",
  "- Copy every visible word verbatim in its original language and script. Do not translate, summarize or add commentary.",
  "- Mark titles and section headings with # headings and bulleted or numbered items as Markdown lists.",
  "- Use a Markdown pipe table only for real tabular data: rows of values under column headers, such as line items, schedules, registers and timetables. Keep one table row per printed row. Do not turn page columns, side-by-side articles, cards, adverts or form fields into tables; write those as ordinary text, one block after another, and form fields as \"Label: value\" lines.",
  "- Write mathematical formulas and equations in LaTeX: inline formulas inside $...$ and each displayed equation inside its own $$...$$ block on separate lines, one block per printed equation line. Never output a formula without these delimiters. Keep ordinary words, numbers, footnote markers, identifiers and code as plain text.",
  "- Transcribe the text, labels and formulas printed inside figures, charts and diagrams, then their captions. Do not add image placeholders or describe what a picture shows.",
  "- Write each paragraph as a single line and separate paragraphs with a blank line.",
  "Output only the Markdown transcription.",
].join("\n");

/**
 * OpenRouter endpoint preference. Relace (mxfp4) was fastest and cheapest with
 * quality equal to the fp8 endpoints; DeepInfra had the next-best tail. Unpinned
 * routing spread calls onto Makora/Venice/Xiaomi, whose 11-34 tok/s throughput
 * made the p95 latency tail. Fallbacks stay on so an outage never fails a page.
 */
export const MIMO_PROVIDER_ORDER = ["relace", "deepinfra"] as const;

/** The prompt MiMo uses in place of the default `<OCR>` template; undefined for other models or explicit templates. */
export function mimoVisionPrompt(model: string | undefined, promptKey: string | undefined): string | undefined {
  if (model !== MIMO_VISION_MODEL) return undefined;
  const key = promptKey?.trim() || "<OCR>";
  return key === "<OCR>" ? MIMO_TRANSCRIPTION_PROMPT : undefined;
}

/** Extra OpenRouter request fields for MiMo page transcription (provider preference); empty for other models. */
export function mimoOpenRouterParams(model: string | undefined): { provider?: { order: string[]; allow_fallbacks: true } } {
  return model === MIMO_VISION_MODEL ? { provider: { order: [...MIMO_PROVIDER_ORDER], allow_fallbacks: true } } : {};
}
