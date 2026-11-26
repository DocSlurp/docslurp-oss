import { DOPPLER_FIGURE_ID } from "./doppler-figures.js";
import { piiPatternTypeSchema, type PiiPatternType } from "./pii.js";
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
  | {
      scope: "none";
      /** A redaction outcome that recorded the pages it redacted: only those pages' pixels show a value. */
      redactedPages?: ReadonlySet<number>;
    }
  | { scope: "sections"; sectionCount: number; types?: readonly PiiPatternType[] }
  | {
      scope: "pages";
      pages: ReadonlySet<number>;
      /** Kinds of PII detected on each withheld page; a page missing here has unknown types (a generic reason). */
      pageTypes?: ReadonlyMap<number, readonly PiiPatternType[]>;
      types?: readonly PiiPatternType[];
      /**
       * The outcome also redacted values: the pages it redacted on (their images still show the value), or `"unknown"`
       * when they were not recorded, in which case no page's pixels are known clean.
       */
      redactedPages?: ReadonlySet<number> | "unknown";
    }
  | { scope: "document"; reason: string; types?: readonly PiiPatternType[] };

export type PiiWithholdingScope = PiiWithholding["scope"];

/**
 * Plain labels for the kinds of PII the detectors find (`PiiPatternType` ids are the stable category ids). Labels are
 * noun phrases for "contains ...". Credential formats share a label, so a reason never names a vendor.
 */
export const PII_CATEGORY_LABELS: Readonly<Record<PiiPatternType, string>> = Object.freeze({
  "ssn": "a Social Security number",
  "credit-card": "a payment card number",
  "phone": "a phone number",
  "email": "an email address",
  "openai-api-key": "an API key",
  "anthropic-api-key": "an API key",
  "github-token": "an access token",
  "generic-api-key": "an API key",
  "ip-address": "an IP address",
  "bank-account": "a bank account number",
  "iban": "a bank account number",
  "passport": "a passport number",
  "drivers-license": "a driver's license number",
  "aws-access-key": "an API key",
  "stripe-api-key": "an API key",
  "slack-token": "an access token",
  "google-api-key": "an API key",
  "jwt": "an access token",
  "private-key": "a private key",
});

/** A detected PII category as responses show it: the stable id and its label. */
export type PiiCategory = { id: PiiPatternType; label: string };

const CATEGORY_ORDER = new Map(piiPatternTypeSchema.options.map((id, index) => [id, index]));

function isPiiPatternType(value: unknown): value is PiiPatternType {
  return typeof value === "string" && CATEGORY_ORDER.has(value as PiiPatternType);
}

/** Known category ids from stored data, deduplicated and in a stable order; unknown or malformed entries are dropped. */
export function piiCategoryIds(values: unknown): PiiPatternType[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(isPiiPatternType))].sort((a, b) => CATEGORY_ORDER.get(a)! - CATEGORY_ORDER.get(b)!);
}

export function piiCategories(ids: readonly PiiPatternType[]): PiiCategory[] {
  return piiCategoryIds(ids).map((id) => ({ id, label: PII_CATEGORY_LABELS[id] }));
}

/** "a payment card number and an email address"; null when no type is known. Labels shared by several ids appear once. */
export function describePiiCategories(ids: readonly PiiPatternType[]): string | null {
  const labels = [...new Set(piiCategoryIds(ids).map((id) => PII_CATEGORY_LABELS[id]))];
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The fixed text a withheld page is replaced with. It names the kinds of PII detected (never the matched text, where
 * it was or how many): `[Page 3 withheld by the project's privacy policy: contains a payment card number]`.
 */
export function piiWithheldPageText(pageNumber: number, types: readonly PiiPatternType[] = []): string {
  const described = describePiiCategories(types);
  return `[Page ${pageNumber} withheld by the project's privacy policy${described ? `: contains ${described}` : ""}]`;
}

/** The fixed text a withheld section of an unpaged document is replaced with. */
export const PII_WITHHELD_SECTION_TEXT = "[Section withheld by the project's privacy policy]";

const WITHHELD_PAGE_TEXT = /^\[Page [1-9][0-9]{0,8} withheld by the project's privacy policy(?:: contains ([a-zA-Z' ,]{1,600}))?\]$/;
const LABEL_IDS = new Map<string, PiiPatternType>();
for (const id of piiPatternTypeSchema.options) if (!LABEL_IDS.has(PII_CATEGORY_LABELS[id])) LABEL_IDS.set(PII_CATEGORY_LABELS[id], id);

const WITHHELD_PAGE_TEXT_ANYWHERE = /\[Page ([1-9][0-9]{0,8}) withheld by the project's privacy policy(?:: contains [a-zA-Z' ,]{1,600})?\]/g;

/**
 * A retrieval unit's text without the withheld placeholders, and the pages whose placeholder it held. A unit that is only
 * placeholders comes back empty: it is never indexed, so a query for a PII category cannot fill results with them. A
 * unit spanning a clean and a withheld page keeps its clean text and loses the withheld page.
 */
export function withoutPiiPlaceholders(text: string): { text: string; withheldPages: number[]; changed: boolean } {
  if (!text.includes("withheld by the project's privacy policy")) return { text, withheldPages: [], changed: false };
  const withheldPages: number[] = [];
  const stripped = text
    .replace(WITHHELD_PAGE_TEXT_ANYWHERE, (_match, page: string) => { withheldPages.push(Number(page)); return ""; })
    .split(PII_WITHHELD_SECTION_TEXT).join("");
  const out = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, withheldPages, changed: out !== text };
}

/** True when a page's whole text is the withheld placeholder (a rescan of rewritten text keeps it withheld). */
export function isPiiWithheldPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === PII_WITHHELD_SECTION_TEXT) return true;
  const match = WITHHELD_PAGE_TEXT.exec(trimmed);
  return match !== null && (match[1] === undefined || piiPlaceholderTypes(trimmed) !== null);
}

/**
 * The categories a page placeholder names (a rescan keeps a carried page's reason), or null when the text is not a
 * placeholder or names something that is not a label. Labels several ids share read back as one representative id.
 */
export function piiPlaceholderTypes(text: string): PiiPatternType[] | null {
  const match = WITHHELD_PAGE_TEXT.exec(text.trim());
  if (!match) return null;
  if (match[1] === undefined) return [];
  const parts = match[1].split(/, | and /);
  const ids: PiiPatternType[] = [];
  for (const part of parts) {
    const id = LABEL_IDS.get(part);
    if (!id) return null;
    ids.push(id);
  }
  return piiCategoryIds(ids);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The withholding recorded for a document. Fails closed: status `pii_blocked`, `pii.blocked`, an unknown scope or a
 * malformed page list all withhold the whole document.
 */
export function piiWithholding(document: { status?: string | null; metadata?: unknown }): PiiWithholding {
  if (document.status === PII_BLOCKED_DOCUMENT_STATUS) {
    const types = piiCategoryIds((document.metadata as { pii?: { patternTypes?: unknown } } | null | undefined)?.pii?.patternTypes);
    return { scope: "document", reason: "pii-blocked", ...(types.length > 0 ? { types } : {}) };
  }
  const metadata = document.metadata;
  if (metadata === null || metadata === undefined) return { scope: "none" };
  if (typeof metadata !== "object" || Array.isArray(metadata)) return { scope: "document", reason: "malformed-metadata" };
  const pii = (metadata as { pii?: unknown }).pii;
  if (pii === null || pii === undefined) return { scope: "none" };
  if (typeof pii !== "object" || Array.isArray(pii)) return { scope: "document", reason: "malformed-metadata" };
  const record = pii as { blocked?: unknown; scope?: unknown; withheldPages?: unknown; withheldSectionCount?: unknown; withheldPageTypes?: unknown; patternTypes?: unknown; redacted?: unknown; redactedPages?: unknown };
  const redactedPages = record.redacted === true
    ? Array.isArray(record.redactedPages) && record.redactedPages.every(isPositiveInteger) ? new Set(record.redactedPages) : "unknown" as const
    : undefined;
  // Kinds of PII are descriptive: missing or malformed type data never changes what is withheld, only the reason shown.
  const types = piiCategoryIds(record.patternTypes);
  const typed = types.length > 0 ? { types } : {};
  if (record.blocked === true) return { scope: "document", reason: "pii-blocked", ...typed };
  switch (record.scope) {
    case undefined:
    case null:
    case "none":
      // Flag-for-review and redaction outcomes (and outcomes written before page scoping) withhold no pages;
      // their unscanned artifacts are still withheld by `withheldArtifactUris`.
      if (record.withheldPages !== undefined) return { scope: "document", reason: "malformed-metadata" };
      // Outcomes written before redacted pages were recorded keep reading as before (their withheld list governs).
      return redactedPages instanceof Set ? { scope: "none", redactedPages } : { scope: "none" };
    case "pages": {
      const pages = record.withheldPages;
      if (!Array.isArray(pages) || pages.length === 0 || !pages.every(isPositiveInteger)) {
        return { scope: "document", reason: "malformed-metadata" };
      }
      const pageSet = new Set(pages);
      const pageTypes = withheldPageTypes(record.withheldPageTypes, pageSet);
      return { scope: "pages", pages: pageSet, ...(pageTypes.size > 0 ? { pageTypes } : {}), ...typed, ...(redactedPages ? { redactedPages } : {}) };
    }
    case "sections":
      return { scope: "sections", sectionCount: isPositiveInteger(record.withheldSectionCount) ? record.withheldSectionCount : 1, ...typed };
    case "document":
      return { scope: "document", reason: "pii-blocked", ...typed };
    default:
      return { scope: "document", reason: "unknown-scope" };
  }
}

/** `metadata.pii.withheldPageTypes` (`{ "3": ["credit-card"] }`) for withheld pages; anything malformed is skipped. */
function withheldPageTypes(value: unknown, pages: ReadonlySet<number>): Map<number, PiiPatternType[]> {
  const out = new Map<number, PiiPatternType[]>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const page = /^[1-9][0-9]{0,8}$/.test(key) ? Number(key) : 0;
    if (!pages.has(page)) continue;
    const ids = piiCategoryIds(entry);
    if (ids.length > 0) out.set(page, ids);
  }
  return out;
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

/**
 * Whether a page's pixels (page image, render, figures) are withheld. A withheld page's are; so are those of a page the
 * outcome redacted a value on (the image still shows it), and every page's when an outcome redacted without recording
 * its pages. Text readers use {@link isPageWithheld}: redacted text is servable, its image is not.
 */
export function isPageImageWithheld(withholding: PiiWithholding, page: number | null | undefined): boolean {
  if (isPageWithheld(withholding, page)) return true;
  if (withholding.scope !== "pages" && withholding.scope !== "none") return false;
  const redacted = withholding.redactedPages;
  if (redacted === undefined) return false;
  if (redacted === "unknown") return true;
  return !isPositiveInteger(page) || redacted.has(page);
}

/** Withheld page numbers, sorted; `"all"` when the whole document is withheld. */
export function withheldPages(withholding: PiiWithholding): number[] | "all" {
  if (withholding.scope === "document") return "all";
  if (withholding.scope !== "pages") return [];
  return [...withholding.pages].sort((a, b) => a - b);
}

/** One withheld page as responses show it: its number, the kinds of PII detected on it, and a short reason. */
export type PiiWithheldPage = { page: number; types: PiiCategory[]; message: string };

/**
 * Public summary for document responses, the ingest report and the viewer: scope, page numbers, counts of pages and
 * sections, and the kinds of PII detected. Never the matched text, where on a page it was, or how many matches.
 */
export type PiiWithheldSummary = {
  scope: PiiWithholdingScope;
  withheldPages: number[];
  withheldPageCount: number;
  withheldSectionCount: number;
  /** Kinds of PII detected in what was withheld; empty when not recorded (documents processed before types were). */
  types: PiiCategory[];
  /** Per withheld page (page scope only). */
  pages: PiiWithheldPage[];
  message: string | null;
};

/** "Page 3 withheld: contains a payment card number and an email address." (or a generic reason when types are unknown). */
export function piiWithheldPageMessage(page: number, types: readonly PiiPatternType[]): string {
  const described = describePiiCategories(types);
  return described ? `Page ${page} withheld: contains ${described}.` : `Page ${page} withheld for privacy.`;
}

function withTypes(base: string, types: readonly PiiPatternType[]): string {
  const described = describePiiCategories(types);
  return described ? `${base}: contains ${described}` : base;
}

export function piiWithheldSummary(withholding: PiiWithholding, pageCount?: number | null): PiiWithheldSummary {
  switch (withholding.scope) {
    case "none":
      return { scope: "none", withheldPages: [], withheldPageCount: 0, withheldSectionCount: 0, types: [], pages: [], message: null };
    case "sections": {
      const types = withholding.types ?? [];
      return {
        scope: "sections", withheldPages: [], withheldPageCount: 0, withheldSectionCount: withholding.sectionCount,
        types: piiCategories(types), pages: [],
        message: withTypes(`${withholding.sectionCount} section${withholding.sectionCount === 1 ? "" : "s"} withheld for privacy`, types),
      };
    }
    case "pages": {
      const pages = [...withholding.pages].sort((a, b) => a - b);
      const perPage = pages.map((page) => {
        const ids = withholding.pageTypes?.get(page) ?? [];
        return { page, types: piiCategories(ids), message: piiWithheldPageMessage(page, ids) };
      });
      const recorded = perPage.flatMap((entry) => entry.types.map((type) => type.id));
      const types = piiCategoryIds(recorded.length > 0 ? recorded : withholding.types ?? []);
      return {
        scope: "pages", withheldPages: pages, withheldPageCount: pages.length, withheldSectionCount: 0,
        types: piiCategories(types), pages: perPage,
        message: withTypes(`${pages.length} page${pages.length === 1 ? "" : "s"} withheld for privacy (${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")})`, types),
      };
    }
    case "document": {
      const all = isPositiveInteger(pageCount) ? Array.from({ length: pageCount }, (_, index) => index + 1) : [];
      const types = withholding.types ?? [];
      return {
        scope: "document", withheldPages: all, withheldPageCount: all.length, withheldSectionCount: 0,
        types: piiCategories(types), pages: [],
        message: withTypes("Document withheld for privacy", types),
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

/** `\f`-separated text with each withheld page's text replaced by its placeholder (naming its PII types when known). */
export function withholdTextPages(
  text: string,
  pages: ReadonlySet<number>,
  pageTypes?: ReadonlyMap<number, readonly PiiPatternType[]>,
): string {
  if (pages.size === 0) return text;
  return text.split("\f").map((page, index) => (pages.has(index + 1) ? piiWithheldPageText(index + 1, pageTypes?.get(index + 1)) : page)).join("\f");
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
