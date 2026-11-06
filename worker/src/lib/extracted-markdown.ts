import { assessTextLayer, pageWordCount } from "@docslurp/shared";
import { stripLeadingFrontmatter } from "./markdown-structure.js";

/**
 * Pipe-table blocks: maximal runs of lines that start and end with `|`, each ended by a newline and followed by a blank
 * line or the end of the text. Line-based and linear: the regex this replaces (`(^|\n)((?:\|.*\|\n)+)(?=\n|$)`)
 * backtracked quadratically over a long pipe block that was not followed by a blank line (council I audit). Returns the
 * runs as line index ranges [first, last].
 */
function markdownTableBlocks(lines: readonly string[]): Array<[number, number]> {
  // A line holding a form feed spans a page break: never a table row, so the break is never trimmed out of a cell and
  // pages never merge (council K #7).
  const isPipeLine = (line: string) => line.length >= 2 && line.charCodeAt(0) === 124 && line.charCodeAt(line.length - 1) === 124 && !/[\r\f\u2028\u2029]/.test(line);
  const blocks: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isPipeLine(lines[i]!)) continue;
    let j = i;
    while (j + 1 < lines.length && isPipeLine(lines[j + 1]!)) j += 1;
    if (j + 1 < lines.length && lines[j + 1] === "") blocks.push([i, j]);
    i = j;
  }
  return blocks;
}

/** `,`, `)`, quotes or whitespace end a data: URI's type. */
const isDataUriStop = (code: number) => code === 44 || code === 41 || code === 34 || code === 39 || code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)));
const isBase64Char = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 43 || code === 47 || code === 61;

/**
 * Replace each `data:<type>;base64,<payload>` URI (case-insensitive; the type has no `,`, whitespace, `)` or quote and
 * ends with `;base64`) via `replace`. A linear scan: the regex this replaces backtracked quadratically on `data:data:…`
 * runs (council I audit), so a run's end is found once and shared by every `data:` inside it.
 */
function replaceDataUris(text: string, replace: (match: string) => string): string {
  const lower = text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  const out: string[] = [];
  let from = 0, search = 0, runEnd = -1;
  for (let at = lower.indexOf("data:", search); at !== -1; at = lower.indexOf("data:", search)) {
    const typeStart = at + 5;
    if (runEnd < typeStart) {
      runEnd = typeStart;
      while (runEnd < text.length && !isDataUriStop(text.charCodeAt(runEnd))) runEnd += 1;
    }
    if (text.charCodeAt(runEnd) === 44 && runEnd - typeStart > 7 && lower.startsWith(";base64", runEnd - 7)) {
      let end = runEnd + 1;
      while (end < text.length && isBase64Char(text.charCodeAt(end))) end += 1;
      if (end > runEnd + 1) {
        out.push(text.slice(from, at), replace(text.slice(at, end)));
        from = search = end;
        continue;
      }
    }
    search = at + 1;
  }
  out.push(text.slice(from));
  return out.join("");
}

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
  const sanitized = replaceDataUris(body.markdown, (match) => {
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
  return markdownTableBlocks(markdown.split("\n")).length;
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

/** A cell with none of these needs neither inline-Markdown stripping nor HTML escaping. */
const CELL_NEEDS_WORK = /[`*<>&"]/;

/** String#trim's whitespace, by code: ASCII fast, the rest through \s. */
const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)));

function cellHtml(cell: string): string {
  const trimmed = cell.trim();
  return CELL_NEEDS_WORK.test(trimmed) ? escapeHtml(stripInlineMarkdown(trimmed)) : trimmed;
}

const SEPARATOR_ROW = /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/** HTML for the pipe-table block lines[first..last] (each line starts and ends with `|`), or null when it is not a table. */
function markdownTableToHtml(lines: readonly string[], first: number, last: number): string | null {
  let header: string | null = null;
  let body = "";
  let rows = 0;
  let index = 0;
  for (let at = first; at <= last; at++) {
    const line = lines[at]!.trim();
    if (!line) continue;
    const position = index++;
    if (position === 1 && line.includes("---") && SEPARATOR_ROW.test(line)) continue;
    // Cells between pipes, trimmed by index (one string per cell, no split or trim copies).
    const start = line.charCodeAt(0) === 124 ? 1 : 0;
    const end = line.length > 1 && line.charCodeAt(line.length - 1) === 124 ? line.length - 1 : line.length;
    let html = "";
    let filled = false;
    const tag = header === null ? "th" : "td";
    for (let from = start; from <= end;) {
      let to = line.indexOf("|", from);
      if (to === -1 || to > end) to = end;
      let a = from, b = to;
      while (a < b && isSpace(line.charCodeAt(a))) a++;
      while (b > a && isSpace(line.charCodeAt(b - 1))) b--;
      const cell = a === b ? "" : cellHtml(line.slice(a, b));
      if (cell) filled = true;
      html += `<${tag}>${cell}</${tag}>`;
      from = to + 1;
    }
    if (!filled) continue;
    rows += 1;
    if (header === null) header = `<tr>${html}</tr>`;
    else body += `<tr>${html}</tr>`;
  }
  if (index < 2 || rows < 2) return null;
  return `<table>\n<thead>\n${header}\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
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

  // One forward pass (blocks are in order and do not overlap): never a splice per table, which is quadratic on a file of
  // many small tables (council K #1: 110 s on 4 MB).
  const lines = args.markdown.split("\n");
  const out: string[] = [];
  let next = 0;
  for (const [first, last] of markdownTableBlocks(lines)) {
    const html = markdownTableToHtml(lines, first, last);
    if (!html) continue;
    for (; next < first; next++) out.push(lines[next]!);
    out.push(html);
    next = last + 1;
  }
  for (; next < lines.length; next++) out.push(lines[next]!);
  return out.join("\n");
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
