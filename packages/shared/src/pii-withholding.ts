import { DOPPLER_FIGURE_ID } from "./doppler-figures.js";
import { PII_BLOCKED_DOCUMENT_STATUS } from "./run.js";

/**
 * Page-scoped PII withholding.
 *
 * Under `piiPolicy.action = "block_indexing"` a match withholds the page it is on, not the document. The worker
 * replaces that page's text with {@link piiWithheldPageText} before anything is summarised, chunked, embedded or
 * indexed, refuses the page's images and figures, and records the outcome on `documents.metadata.pii`:
 *
 * - `scope: "pages"` with `withheldPages` (1-based, sorted): the rest of the document completes and is served.
 * - `scope: "sections"`: an unpaged document (one-page text, HTML, a transcript). The Markdown section holding each
 *   match is replaced with {@link PII_WITHHELD_SECTION_TEXT}; everything written before the scan stays withheld.
 * - `scope: "document"` (status `pii_blocked`): every page is withheld, the matches could not be placed on a page,
 *   or the project chose `block_document`.
 *
 * Every reader (search, chat, file proxy, page images, figures, exports, figure resume, chart export, page renders)
 * asks {@link piiWithholding} and {@link isPageWithheld}. Both fail closed: malformed metadata withholds the whole
 * document, and a hit with no page on a document with withheld pages is withheld.
 */
export type PiiWithholding =
  | { scope: "none" }
  | { scope: "sections"; sectionCount: number }
  | { scope: "pages"; pages: ReadonlySet<number> }
  | { scope: "document"; reason: string };

export type PiiWithholdingScope = PiiWithholding["scope"];

/** The fixed text a withheld page is replaced with. It never names what matched. */
export function piiWithheldPageText(pageNumber: number): string {
  return `[Page ${pageNumber} withheld by the project's privacy policy]`;
}

/** The fixed text a withheld section of an unpaged document is replaced with. */
export const PII_WITHHELD_SECTION_TEXT = "[Section withheld by the project's privacy policy]";

const WITHHELD_PAGE_TEXT = /^\[Page [1-9][0-9]{0,8} withheld by the project's privacy policy\]$/;

/** True when a page's whole text is the withheld placeholder (a rescan of rewritten text keeps it withheld). */
export function isPiiWithheldPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return WITHHELD_PAGE_TEXT.test(trimmed) || trimmed === PII_WITHHELD_SECTION_TEXT;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The withholding recorded for a document. Fails closed: status `pii_blocked`, `pii.blocked`, an unknown scope or a
 * malformed page list all withhold the whole document.
 */
export function piiWithholding(document: { status?: string | null; metadata?: unknown }): PiiWithholding {
  if (document.status === PII_BLOCKED_DOCUMENT_STATUS) return { scope: "document", reason: "pii-blocked" };
  const metadata = document.metadata;
  if (metadata === null || metadata === undefined) return { scope: "none" };
  if (typeof metadata !== "object" || Array.isArray(metadata)) return { scope: "document", reason: "malformed-metadata" };
  const pii = (metadata as { pii?: unknown }).pii;
  if (pii === null || pii === undefined) return { scope: "none" };
  if (typeof pii !== "object" || Array.isArray(pii)) return { scope: "document", reason: "malformed-metadata" };
  const record = pii as { blocked?: unknown; scope?: unknown; withheldPages?: unknown; withheldSectionCount?: unknown };
  if (record.blocked === true) return { scope: "document", reason: "pii-blocked" };
  switch (record.scope) {
    case undefined:
    case null:
    case "none":
      // Flag-for-review and redaction outcomes (and outcomes written before page scoping) withhold no pages;
      // their unscanned artifacts are still withheld by `withheldArtifactUris`.
      if (record.withheldPages !== undefined) return { scope: "document", reason: "malformed-metadata" };
      return { scope: "none" };
    case "pages": {
      const pages = record.withheldPages;
      if (!Array.isArray(pages) || pages.length === 0 || !pages.every(isPositiveInteger)) {
        return { scope: "document", reason: "malformed-metadata" };
      }
      return { scope: "pages", pages: new Set(pages) };
    }
    case "sections":
      return { scope: "sections", sectionCount: isPositiveInteger(record.withheldSectionCount) ? record.withheldSectionCount : 1 };
    case "document":
      return { scope: "document", reason: "pii-blocked" };
    default:
      return { scope: "document", reason: "unknown-scope" };
  }
}

/**
 * Whether a page (or any page of a hit spanning several) is withheld. A hit without a page on a document that
 * withholds pages is withheld: its text cannot be shown to come from a clean page.
 */
export function isPageWithheld(
  withholding: PiiWithholding,
  page: number | readonly (number | null | undefined)[] | null | undefined,
): boolean {
  if (withholding.scope === "document") return true;
  if (withholding.scope !== "pages") return false;
  const pages = Array.isArray(page) ? page : [page];
  const known = pages.filter(isPositiveInteger);
  if (known.length === 0 || known.length !== pages.length) return true;
  return known.some((value) => withholding.pages.has(value));
}

/** Withheld page numbers, sorted; `"all"` when the whole document is withheld. */
export function withheldPages(withholding: PiiWithholding): number[] | "all" {
  if (withholding.scope === "document") return "all";
  if (withholding.scope !== "pages") return [];
  return [...withholding.pages].sort((a, b) => a - b);
}

/** Public summary for document responses and the ingest report: counts and page numbers, never content. */
export type PiiWithheldSummary = {
  scope: PiiWithholdingScope;
  withheldPages: number[];
  withheldPageCount: number;
  withheldSectionCount: number;
  message: string | null;
};

export function piiWithheldSummary(withholding: PiiWithholding, pageCount?: number | null): PiiWithheldSummary {
  switch (withholding.scope) {
    case "none":
      return { scope: "none", withheldPages: [], withheldPageCount: 0, withheldSectionCount: 0, message: null };
    case "sections":
      return {
        scope: "sections", withheldPages: [], withheldPageCount: 0, withheldSectionCount: withholding.sectionCount,
        message: `${withholding.sectionCount} section${withholding.sectionCount === 1 ? "" : "s"} withheld for privacy`,
      };
    case "pages": {
      const pages = [...withholding.pages].sort((a, b) => a - b);
      return {
        scope: "pages", withheldPages: pages, withheldPageCount: pages.length, withheldSectionCount: 0,
        message: `${pages.length} page${pages.length === 1 ? "" : "s"} withheld for privacy (${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")})`,
      };
    }
    case "document": {
      const all = isPositiveInteger(pageCount) ? Array.from({ length: pageCount }, (_, index) => index + 1) : [];
      return {
        scope: "document", withheldPages: all, withheldPageCount: all.length, withheldSectionCount: 0,
        message: "Document withheld for privacy",
      };
    }
  }
}

const PAGE_SLOT = /(?:^|:)(?:[a-z0-9-]*-)?page-([1-9][0-9]{0,8})$/;
const FIGURE_SLOT = /(?:^|:)doppler-figure:(p[^:]+)$/;

/**
 * The page a per-page artifact slot belongs to: page images (`<doc>:page-N`), page renders
 * (`<doc>:raster-...-page-N`) and Doppler figures (`<doc>:doppler-figure:pN.M`). Null for every other slot: those
 * carry no page and are withheld whole when any page is.
 */
export function withheldPageOfSlot(slot: string): number | null {
  const figure = FIGURE_SLOT.exec(slot);
  if (figure) {
    const id = DOPPLER_FIGURE_ID.exec(figure[1]!);
    return id ? Number(id[1]) : null;
  }
  const page = PAGE_SLOT.exec(slot);
  return page ? Number(page[1]) : null;
}

/**
 * The 1-based pages of `\f`-separated text, or null when the text's page breaks do not match `pageCount` (page
 * attribution unknown). A document of one page is one page whatever it contains.
 */
export function pageOffsets(text: string, pageCount: number | null | undefined): Array<{ start: number; end: number }> | null {
  if (!isPositiveInteger(pageCount)) return null;
  if (pageCount === 1) return [{ start: 0, end: text.length }];
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === "\f") {
      ranges.push({ start, end: index });
      start = index + 1;
    }
  }
  // Trailing empty pages a writer appended past the page count are dropped; any other mismatch is unknown.
  while (ranges.length > pageCount && ranges[ranges.length - 1]!.start >= ranges[ranges.length - 1]!.end) ranges.pop();
  return ranges.length === pageCount ? ranges : null;
}

/** Pages a match covers (both pages of a match that spans a break), or null when attribution is unknown. */
export function pagesOfMatch(
  offsets: Array<{ start: number; end: number }> | null,
  charOffset: number,
  length: number,
): number[] | null {
  if (!offsets || !Number.isSafeInteger(charOffset) || charOffset < 0) return null;
  const last = charOffset + Math.max(1, length) - 1;
  const pages: number[] = [];
  offsets.forEach((range, index) => {
    // A page owns [start, end]; its trailing `\f` (at `end`) counts with it.
    if (charOffset <= range.end && last >= range.start) pages.push(index + 1);
  });
  return pages.length > 0 ? pages : null;
}

/** `\f`-separated text with each withheld page's text replaced by its placeholder. */
export function withholdTextPages(text: string, pages: ReadonlySet<number>): string {
  if (pages.size === 0) return text;
  return text.split("\f").map((page, index) => (pages.has(index + 1) ? piiWithheldPageText(index + 1) : page)).join("\f");
}

/**
 * Sections of unpaged Markdown: split before each heading line, or at blank lines when there are no headings.
 * Returned as half-open [start, end) ranges covering the whole text.
 */
export function markdownSections(text: string): Array<{ start: number; end: number }> {
  const headings: number[] = [];
  const headingPattern = /^#{1,6}\s/gm;
  for (let match = headingPattern.exec(text); match; match = headingPattern.exec(text)) {
    if (match.index > 0) headings.push(match.index);
  }
  const boundaries = headings.length > 0 ? headings : (() => {
    const out: number[] = [];
    const paragraphBreak = /\n[ \t]*\n+/g;
    for (let match = paragraphBreak.exec(text); match; match = paragraphBreak.exec(text)) out.push(match.index + match[0].length);
    return out;
  })();
  const sections: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary > start) sections.push({ start, end: boundary });
    start = Math.max(start, boundary);
  }
  sections.push({ start, end: text.length });
  return sections;
}

/** Unpaged Markdown with every section that overlaps a match replaced. Returns the text and how many sections went. */
export function withholdTextSections(
  text: string,
  matches: ReadonlyArray<{ charOffset: number; length: number }>,
): { text: string; withheldSectionCount: number } {
  if (matches.length === 0) return { text, withheldSectionCount: 0 };
  const sections = markdownSections(text);
  const hit = new Set<number>();
  for (const match of matches) {
    const last = match.charOffset + Math.max(1, match.length) - 1;
    sections.forEach((section, index) => {
      if (match.charOffset < section.end && last >= section.start) hit.add(index);
    });
  }
  if (hit.size === 0) {
    // A match outside the text it claims to be in cannot be placed: withhold everything.
    return { text: PII_WITHHELD_SECTION_TEXT, withheldSectionCount: Math.max(1, sections.length) };
  }
  const out = sections.map((section, index) => {
    if (!hit.has(index)) return text.slice(section.start, section.end);
    const original = text.slice(section.start, section.end);
    const trailing = /\s*$/.exec(original)?.[0] ?? "";
    return `${PII_WITHHELD_SECTION_TEXT}${trailing || "\n\n"}`;
  });
  return { text: out.join(""), withheldSectionCount: hit.size };
}

/** A retrieval hit as the withholding filter sees it (search results, chat citations, page hits). */
export type WithholdableHit = {
  citation: { source?: string | null; documentId: string; pageNumber?: number | null; pageNumbers?: readonly number[] | null };
};

/**
 * Drops every document hit on a withheld page (or with no page, on a document that withholds pages) and every hit of
 * a wholly withheld document. A document missing from `withholdings` is treated as withheld whole: the caller could not
 * show it is clean. Non-document hits (community summaries, web results) carry no page of any document and pass.
 */
export function filterPiiWithheldHits<T extends WithholdableHit>(
  hits: readonly T[],
  withholdings: ReadonlyMap<string, PiiWithholding>,
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const hit of hits) {
    const source = hit.citation.source ?? "document";
    if (source !== "document") {
      kept.push(hit);
      continue;
    }
    const withholding = withholdings.get(hit.citation.documentId) ?? { scope: "document", reason: "unknown-document" } as const;
    const pages = [...(hit.citation.pageNumbers ?? [])];
    if (hit.citation.pageNumber !== null && hit.citation.pageNumber !== undefined && !pages.includes(hit.citation.pageNumber)) {
      pages.push(hit.citation.pageNumber);
    }
    if (isPageWithheld(withholding, pages.length > 0 ? pages : null)) dropped += 1;
    else kept.push(hit);
  }
  return { kept, dropped };
}
