import { assessTextLayer, pageWordCount } from "@docslurp/shared";
import { stripLeadingFrontmatter } from "./markdown-structure.js";

const MARKDOWN_TABLE_BLOCK =
  /(^|\n)(?<table>(?:\|.*\|\n)+)(?=\n|$)/g;

const DATA_URI = /data:[^,\s)"']+;base64,[a-z0-9+/=]+/gi;

export type ExtractionPlausibilitySignals = {
  plausibilityScore: number;
  charYield: number;
  averageWordLengthPlausibility: number;
  whitespacePlausibility: number;
  charCount: number;
  wordCount: number;
};

export type SanitizedExtractedMarkdown = {
  markdown: string;
  strippedDataUriCount: number;
  strippedDataUriBytes: number;
  /** Lines of a leading metadata block (`---` … `---`) removed from the body. */
  strippedFrontmatterLines: number;
};

/**
 * Binary payloads are artifacts, not document text. Keeping them in Markdown
 * corrupts yield metrics and can put megabytes of base64 into chunks/search.
 * A leading metadata block (HTML converters emit `---\ntitle: …` from
 * `<title>`/`<meta>`) is likewise dropped so it cannot become a heading,
 * a chunk or chunk context.
 */
export function sanitizeExtractedMarkdown(
  markdown: string,
): SanitizedExtractedMarkdown {
  let strippedDataUriCount = 0;
  let strippedDataUriBytes = 0;
  const body = stripLeadingFrontmatter(markdown);
  const sanitized = body.markdown.replace(DATA_URI, (match) => {
    strippedDataUriCount += 1;
    strippedDataUriBytes += Buffer.byteLength(match);
    return "artifact://externalized-data-uri";
  });

  return {
    markdown: sanitized,
    strippedDataUriCount,
    strippedDataUriBytes,
    strippedFrontmatterLines: body.strippedLines,
  };
}

/** Readability of extracted text by `assessTextLayer` verdict (0..1): an ok layer is fully readable. */
const READABILITY: Record<string, number> = { ok: 1, suspect: 0.5, garbled: 0.1, empty: 0 };
/** Share of the score that is yield (words per page over `YIELD_WORDS_PER_PAGE`); the rest is readability. */
const YIELD_WEIGHT = 0.2;
const YIELD_WORDS_PER_PAGE = 100;
const PLAUSIBILITY_WINDOW_CHARS = 32 * 1024;

/**
 * How readable extracted text is, and roughly how much of it there is. Readability is the text-layer quality
 * detector's verdict (`assessTextLayer`: unmapped glyphs, mojibake, glyph shifts, letter pairs per script), taken over
 * the start, middle and end of the text; yield is words per page (script-aware) against a typical page, so a short real
 * page loses at most `YIELD_WEIGHT`. It is deliberately not calibrated extraction quality: it cannot judge
 * correctness, reading order, OCR substitutions, tables, geometry, or hallucinations, only whether the text is
 * text and not noise. A garbled export scores under the store's warning threshold; an invoice of 20 words does not.
 */
export function scoreExtractionPlausibility(
  text: string,
  pageCount: number,
): ExtractionPlausibilitySignals {
  const sanitized = sanitizeExtractedMarkdown(text).markdown;
  if (!sanitized.trim() || pageCount === 0) {
    return {
      plausibilityScore: 0,
      charYield: 0,
      averageWordLengthPlausibility: 0,
      whitespacePlausibility: 0,
      charCount: 0,
      wordCount: 0,
    };
  }
  const wordCount = pageWordCount(sanitized);
  const charCount = sanitized.length;
  const whitespaceCount = (sanitized.match(/\s/g) ?? []).length;
  const windows = charCount <= PLAUSIBILITY_WINDOW_CHARS * 3
    ? [sanitized]
    : [
        sanitized.slice(0, PLAUSIBILITY_WINDOW_CHARS),
        sanitized.slice(Math.floor(charCount / 2) - PLAUSIBILITY_WINDOW_CHARS / 2, Math.floor(charCount / 2) + PLAUSIBILITY_WINDOW_CHARS / 2),
        sanitized.slice(-PLAUSIBILITY_WINDOW_CHARS),
      ];
  const readability = windows.reduce((sum, window) => sum + (READABILITY[assessTextLayer(window).verdict] ?? 0), 0) / windows.length;
  const charYield = Math.min(1, charCount / (pageCount * 500));
  const words = sanitized.trim().split(/\s+/).filter(Boolean).length;
  const averageWordLengthPlausibility = Math.min(1, (words > 0 ? charCount / words : 0) / 6);
  const whitespaceRatio = charCount > 0 ? whitespaceCount / charCount : 0;
  const whitespacePlausibility = whitespaceRatio > 0.05 && whitespaceRatio < 0.4 ? 1 : 0.5;
  const yieldShare = Math.min(1, wordCount / (pageCount * YIELD_WORDS_PER_PAGE));
  return {
    plausibilityScore: Math.min(1, readability * (1 - YIELD_WEIGHT) + yieldShare * YIELD_WEIGHT),
    charYield,
    averageWordLengthPlausibility,
    whitespacePlausibility,
    charCount,
    wordCount,
  };
}

export function countMarkdownTables(markdown: string): number {
  return [...markdown.matchAll(MARKDOWN_TABLE_BLOCK)].length;
}

export function countHtmlTables(markdown: string): number {
  return (markdown.match(/<table[\s>]/gi) ?? []).length;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function markdownTableToHtml(tableMarkdown: string): string | null {
  const lines = tableMarkdown
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return null;
  }

  const rows = lines
    .filter((line, index) => {
      if (index !== 1) {
        return true;
      }
      return !/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
    })
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => escapeHtml(stripInlineMarkdown(cell.trim()))),
    )
    .filter((row) => row.length > 0 && row.some((cell) => cell.length > 0));

  if (rows.length < 2) {
    return null;
  }

  const [header, ...body] = rows;
  const headerHtml = `<tr>${header.map((cell) => `<th>${cell}</th>`).join("")}</tr>`;
  const bodyHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table>\n<thead>\n${headerHtml}\n</thead>\n<tbody>\n${bodyHtml}\n</tbody>\n</table>`;
}

/**
 * With table preservation on, convert Markdown pipe tables to HTML tables so
 * every table reaches chunking in one format. Output that already contains an
 * HTML table is left as extracted.
 */
export function normalizeExtractedMarkdown(args: {
  markdown: string;
  preserveTables: boolean;
}): string {
  if (!args.preserveTables || countHtmlTables(args.markdown) > 0) {
    return args.markdown;
  }

  return args.markdown.replace(
    MARKDOWN_TABLE_BLOCK,
    (fullMatch, prefix, table) => {
      const html = markdownTableToHtml(table);
      return html ? `${prefix}${html}\n` : fullMatch;
    },
  );
}

export function scoreMarkdownCandidate(args: {
  markdown: string;
  pageCount?: number;
}): {
  plausibilityScore: number;
  plausibilitySignals: ExtractionPlausibilitySignals;
  markdownTableCount: number;
  htmlTableCount: number;
  formattingScore: number;
  selectionScore: number;
} {
  const sanitized = sanitizeExtractedMarkdown(args.markdown).markdown;
  const markdownTableCount = countMarkdownTables(sanitized);
  const htmlTableCount = countHtmlTables(sanitized);
  const plausibilitySignals = scoreExtractionPlausibility(
    sanitized,
    args.pageCount ?? 1,
  );
  const plausibilityScore = plausibilitySignals.plausibilityScore;
  const formattingSignals =
    (sanitized.match(/^#{1,6}\s+/gm) ?? []).length * 2 +
    (sanitized.match(/\*\*[^*\n][^*\n]*\*\*/g) ?? []).length +
    (sanitized.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length +
    (sanitized.match(/^\s*[-*+]\s+/gm) ?? []).length;
  const formattingScore = Math.min(0.2, formattingSignals * 0.02);
  const selectionScore =
    plausibilityScore +
    markdownTableCount * 0.2 +
    htmlTableCount * 0.25 +
    formattingScore;

  return {
    plausibilityScore,
    plausibilitySignals,
    markdownTableCount,
    htmlTableCount,
    formattingScore,
    selectionScore,
  };
}
