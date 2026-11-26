import {
  describePiiCategories,
  isPageWithheld,
  isPiiWithheldPlaceholder,
  pageOffsets,
  pagesOfMatch,
  PII_WITHHELD_SECTION_TEXT,
  piiCategoryIds,
  piiPlaceholderTypes,
  piiWithheldPageText,
  withheldPageOfSlot,
  withholdTextPages,
  withholdTextSections,
  type PiiMatch,
  type PiiPatternType,
  type PiiPolicy,
  type PiiWithholding,
} from "@docslurp/shared";

import { parseAtxHeading, plainHeadingText } from "./markdown-structure.js";
import { isStructuralKey } from "./pii-redaction.js";

/**
 * Page-scoped PII withholding for the worker (see packages/shared/src/pii-withholding.ts).
 *
 * Granularity:
 * - Paged documents (more than one page): the page. Canonical blocks carry their page; Markdown and source text
 *   are `\f`-separated, so a match's page is the page its offsets fall in (both pages when it spans a break). HTML
 *   and contract hits without a page are placed through the same value's fingerprint found on a paged source.
 * - Unpaged documents (one page: plain text, HTML, a transcript, a one-page PDF): the Markdown section holding the
 *   match (heading-delimited, or the paragraph when the text has no headings), and the canonical block holding it.
 *   For a transcript that section is the time range it covers.
 *
 * Fail closed: a hit that cannot be placed on a page (no page, a page outside the document, Markdown whose page
 * breaks do not match the page count, a section that cannot be located) withholds the whole document, with the
 * reason logged and recorded.
 */
export type PiiWithholdingPlan =
  | { scope: "none" }
  | {
      scope: "pages";
      pages: number[];
      carriedPages: number[];
      /** Kinds of PII detected on each withheld page (from its matches, or a carried placeholder); unknown pages are absent. */
      pageTypes: Map<number, PiiPatternType[]>;
    }
  | { scope: "sections"; sectionCount: number }
  | { scope: "document"; reason: string };

type Located = { pages: Set<number>; unattributed: string[]; types: Map<number, Set<PiiPatternType>> };

export type PiiScanFindings = {
  pageCount: number;
  canonical: {
    matches: PiiMatch[];
    changedPages: Array<number | null>;
    blocks: CanonicalBlockLike[];
    /** The Markdown (or source text) matches' values located in the blocks: {@link mapTextMatchesToCanonical}. */
    mapped?: CanonicalValueMap;
  } | null;
  markdown: { text: string; matches: PiiMatch[] } | null;
  fallback: { text: string; matches: PiiMatch[] } | null;
  html: { matches: PiiMatch[] } | null;
  contract: { matches: PiiMatch[] } | null;
  /**
   * The kinds of PII the previous outcome recorded per withheld page. A carried placeholder names labels, and several
   * ids share a label ("an API key"), so a carried page keeps these exact ids when they describe the same labels.
   */
  previousPageTypes?: ReadonlyMap<number, readonly PiiPatternType[]>;
};

export type CanonicalBlockLike = {
  text?: unknown;
  type?: unknown;
  headingPath?: unknown;
  pageNumber?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

function validPage(page: unknown, pageCount: number): page is number {
  return typeof page === "number" && Number.isSafeInteger(page) && page >= 1 && page <= pageCount;
}

/** Pages holding a hit, plus why any hit could not be placed. */
export function locateMatches(findings: PiiScanFindings): Located {
  const { pageCount } = findings;
  const pages = new Set<number>();
  const unattributed: string[] = [];
  const byFingerprint = new Map<string, Set<number>>();
  const types = new Map<number, Set<PiiPatternType>>();
  const typeOn = (page: number, type: PiiPatternType) => {
    const known = types.get(page) ?? new Set<PiiPatternType>();
    known.add(type);
    types.set(page, known);
  };
  const place = (match: PiiMatch, found: number[]) => {
    const fingerprint = match.matchedPrefix;
    for (const page of found) {
      pages.add(page);
      typeOn(page, match.patternType);
    }
    const known = byFingerprint.get(fingerprint) ?? new Set<number>();
    for (const page of found) known.add(page);
    byFingerprint.set(fingerprint, known);
  };

  for (const match of findings.canonical?.matches ?? []) {
    if (validPage(match.pageNumber, pageCount)) place(match, [match.pageNumber]);
    else unattributed.push("canonical-block-without-page");
  }
  for (const page of findings.canonical?.changedPages ?? []) {
    if (validPage(page, pageCount)) pages.add(page);
    else unattributed.push("canonical-block-without-page");
  }
  // Blocks holding a value the whole text matched (a label and its value in two blocks): their pages are withheld too.
  const mapped = findings.canonical?.mapped;
  if (mapped) {
    for (const [index, kinds] of mapped.blockIndexes) {
      const page = findings.canonical!.blocks[index]?.pageNumber;
      if (!validPage(page, pageCount)) { unattributed.push("canonical-block-without-page"); continue; }
      pages.add(page);
      for (const kind of kinds) typeOn(page, kind);
    }
    // A value in no block is withheld only if every page it falls on has blocks to replace.
    const blockPages = new Set(findings.canonical!.blocks.map((block) => block.pageNumber));
    for (const found of mapped.unmapped) {
      if (!found || !found.every((page) => blockPages.has(page))) unattributed.push("text-match-not-in-canonical");
    }
  }
  for (const [source, entry] of [["markdown", findings.markdown], ["source-text", findings.fallback]] as const) {
    if (!entry || entry.matches.length === 0) continue;
    const offsets = pageOffsets(entry.text, pageCount);
    for (const match of entry.matches) {
      const found = pagesOfMatch(offsets, match.charOffset, match.length);
      if (found) place(match, found);
      else unattributed.push(`${source}-page-breaks-unknown`);
    }
  }
  for (const [source, entry] of [["html", findings.html], ["extraction-contract", findings.contract]] as const) {
    for (const match of entry?.matches ?? []) {
      if (validPage(match.pageNumber, pageCount)) {
        place(match, [match.pageNumber]);
        continue;
      }
      // The HTML rendering and page-less contract fields repeat text a paged source already placed.
      const known = byFingerprint.get(match.matchedPrefix);
      if (known && known.size > 0) for (const page of known) { pages.add(page); typeOn(page, match.patternType); }
      else unattributed.push(`${source}-match-without-page`);
    }
  }
  return { pages, unattributed: [...new Set(unattributed)], types };
}

/**
 * Pages a previous scan already replaced with the withheld placeholder: a rescan of rewritten text keeps them, with the
 * kinds of PII the placeholder names (none for a placeholder written before types were recorded).
 */
export function carriedWithheldPages(findings: PiiScanFindings): Map<number, PiiPatternType[]> {
  const carried = new Map<number, PiiPatternType[]>();
  const carry = (page: number, text: string) => {
    const read = piiPlaceholderTypes(text) ?? [];
    const previous = findings.previousPageTypes?.get(page) ?? [];
    const sameLabels = previous.length > 0 && describePiiCategories(previous) === describePiiCategories(read);
    carried.set(page, piiCategoryIds([...(carried.get(page) ?? []), ...(sameLabels ? previous : read)]));
  };
  const { pageCount } = findings;
  for (const entry of [findings.markdown, findings.fallback]) {
    if (!entry) continue;
    const offsets = pageOffsets(entry.text, pageCount);
    if (!offsets || pageCount <= 1) continue;
    offsets.forEach((range, index) => {
      const pageText = entry.text.slice(range.start, range.end);
      if (isPiiWithheldPlaceholder(pageText)) carry(index + 1, pageText);
    });
  }
  if (findings.canonical && pageCount > 1) {
    const textByPage = new Map<number, string[]>();
    for (const block of findings.canonical.blocks) {
      if (!validPage(block.pageNumber, pageCount) || typeof block.text !== "string") continue;
      textByPage.set(block.pageNumber, [...(textByPage.get(block.pageNumber) ?? []), block.text]);
    }
    for (const [page, texts] of textByPage) {
      const meaningful = texts.filter((text) => text.trim());
      if (meaningful.length > 0 && meaningful.every(isPiiWithheldPlaceholder)) for (const text of meaningful) carry(page, text);
    }
  }
  return carried;
}

/**
 * Sections of an unpaged document a previous scan already replaced (the section placeholder in its text, or a canonical
 * block it marked withheld). A rescan over that rewritten text finds nothing, so without this it would record the
 * document clean and serve the pre-scan artifacts (source file, parser output, page image) that still hold the PII.
 */
export function carriedWithheldSections(findings: PiiScanFindings): number {
  if (findings.pageCount > 1) return 0;
  let count = 0;
  for (const entry of [findings.markdown, findings.fallback]) {
    if (entry) count = Math.max(count, entry.text.split(PII_WITHHELD_SECTION_TEXT).length - 1);
  }
  if (findings.canonical) {
    const marked = findings.canonical.blocks.filter((block) =>
      (block.metadata as { piiWithheld?: unknown } | null | undefined)?.piiWithheld === true
      || (typeof block.text === "string" && isPiiWithheldPlaceholder(block.text))).length;
    count = Math.max(count, marked);
  }
  return count;
}

/** Decide what `block_indexing` withholds. Other actions withhold no pages except ones a previous scan replaced. */
export function planPiiWithholding(action: PiiPolicy["action"], findings: PiiScanFindings, anyMatch: boolean): PiiWithholdingPlan {
  const carried = carriedWithheldPages(findings);
  const carriedSections = carriedWithheldSections(findings);
  const blocking = action === "block_indexing" || action === "block_document";
  if (!anyMatch || !blocking) {
    if (carried.size > 0) return withPages(findings, [...carried.keys()], [...carried.keys()], mergeTypes(carried, new Map()));
    return carriedSections > 0 ? { scope: "sections", sectionCount: carriedSections } : { scope: "none" };
  }
  if (action === "block_document") return { scope: "document", reason: "policy-block-document" };

  if (findings.pageCount <= 1) {
    const plan = planSections(findings);
    return plan.scope === "sections" ? { scope: "sections", sectionCount: plan.sectionCount + carriedSections } : plan;
  }

  const located = locateMatches(findings);
  if (located.unattributed.length > 0) return { scope: "document", reason: `unattributed:${located.unattributed.join(",")}` };
  if (located.pages.size === 0) return { scope: "document", reason: "unattributed:no-page-for-match" };
  return withPages(findings, [...located.pages, ...carried.keys()], [...carried.keys()], mergeTypes(carried, located.types));
}

function mergeTypes(carried: ReadonlyMap<number, readonly PiiPatternType[]>, located: ReadonlyMap<number, ReadonlySet<PiiPatternType>>): Map<number, PiiPatternType[]> {
  const out = new Map<number, PiiPatternType[]>();
  for (const page of new Set([...carried.keys(), ...located.keys()])) {
    const ids = piiCategoryIds([...(carried.get(page) ?? []), ...(located.get(page) ?? [])]);
    if (ids.length > 0) out.set(page, ids);
  }
  return out;
}

function withPages(findings: PiiScanFindings, pages: number[], carriedPages: number[], pageTypes: Map<number, PiiPatternType[]>): PiiWithholdingPlan {
  const unique = [...new Set(pages)].sort((a, b) => a - b);
  if (unique.length >= findings.pageCount) return { scope: "document", reason: "every-page-withheld" };
  // Text artifacts are rewritten page by page; text whose page breaks are unknown cannot be.
  for (const [source, entry] of [["markdown", findings.markdown], ["source-text", findings.fallback]] as const) {
    if (entry && pageOffsets(entry.text, findings.pageCount) === null) {
      return { scope: "document", reason: `unattributed:${source}-page-breaks-unknown` };
    }
  }
  return {
    scope: "pages", pages: unique, carriedPages: [...new Set(carriedPages)].sort((a, b) => a - b),
    pageTypes: new Map([...pageTypes].filter(([page]) => unique.includes(page)).sort(([a], [b]) => a - b)),
  };
}

function planSections(findings: PiiScanFindings): PiiWithholdingPlan {
  const text = findings.markdown ?? findings.fallback;
  const textMatches = text?.matches.length ?? 0;
  const otherMatches = (findings.canonical?.matches.length ?? 0) + (findings.canonical?.changedPages.length ?? 0)
    + (findings.html?.matches.length ?? 0) + (findings.contract?.matches.length ?? 0);
  // Text the sections are cut from must hold the hit itself; a hit only elsewhere cannot be located in it.
  if (text && textMatches === 0 && otherMatches > 0) return { scope: "document", reason: "unattributed:section-not-located" };
  if (!text && !findings.canonical) return { scope: "document", reason: "unattributed:no-text" };
  // The canonical document is rewritten block by block: a text match whose value no block holds cannot be withheld there.
  if (findings.canonical?.mapped && findings.canonical.mapped.unmapped.length > 0) {
    return { scope: "document", reason: "unattributed:text-match-not-in-canonical" };
  }
  const sectionCount = text
    ? withholdTextSections(text.text, text.matches).withheldSectionCount
    : new Set((findings.canonical?.matches ?? []).map((match) => match.charOffset)).size || 1;
  return { scope: "sections", sectionCount: Math.max(1, sectionCount) };
}

/**
 * Text-bearing strings of a canonical block: its text, heading path entries and every string in its metadata, except
 * structural keys (`url`, `*Id`, `*Key`), which redaction leaves alone: a value only there is not located (fails closed).
 */
function blockStrings(block: CanonicalBlockLike): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) if (!isStructuralKey(key)) visit(child);
    }
  };
  visit(block.text);
  visit(block.headingPath);
  visit(block.metadata);
  return out;
}

/** Values shorter than this (letters and digits) must be found near their place in the text to count as located. */
const SHORT_VALUE_CHARS = 12;

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) count += 1;
  return count;
}

const alnum = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

export type CanonicalValueMap = {
  /** Block index -> the kinds of PII whose value it holds. */
  blockIndexes: Map<number, Set<PiiPatternType>>;
  /** Block index -> the matched values it holds (for redaction). */
  values: Map<number, Array<{ value: string; type: PiiPatternType }>>;
  /** Text matches whose value is in no block: the pages the match falls on (null when unknown). */
  unmapped: Array<number[] | null>;
};

/**
 * Where the values matched in a whole text (Markdown or source text) sit in the canonical document.
 *
 * The text is scanned as one string and the canonical document block by block, so a context-validated detector (a
 * label, a blank line, then the value) can match the text while no single block matches: the label is one block and
 * the value the next. Each text match's value is looked up in the canonical blocks (exactly, then ignoring spacing and
 * punctuation); every block holding it is returned so it can be replaced or redacted like a block that matched. A
 * value found in no block is `unmapped`: the canonical document may still hold it in a form this cannot see (split
 * over two blocks, re-spaced), so callers fail closed.
 *
 * Cost: one pass building a per-page string index of the blocks, then one `indexOf` per match over the blocks of the
 * pages the match falls on (all blocks for an unpaged document, or when the value is not on its page).
 */
export function mapTextMatchesToCanonical(
  blocks: readonly CanonicalBlockLike[],
  text: string,
  matches: readonly PiiMatch[],
  pageCount: number,
): CanonicalValueMap {
  const blockIndexes = new Map<number, Set<PiiPatternType>>();
  const values = new Map<number, Array<{ value: string; type: PiiPatternType }>>();
  if (matches.length === 0) return { blockIndexes, values, unmapped: [] };
  // Per page (null: no page): the blocks' strings joined with separators no value contains, exact and normalized.
  type PageIndex = { exact: string; exactStarts: number[]; loose: string; looseStarts: number[]; blocks: number[] };
  const byPage = new Map<number | null, PageIndex>();
  blocks.forEach((block, index) => {
    const page = validPage(block.pageNumber, Math.max(pageCount, 1)) ? block.pageNumber : null;
    const entry = byPage.get(page) ?? { exact: "", exactStarts: [], loose: "", looseStarts: [], blocks: [] };
    const strings = blockStrings(block);
    entry.exactStarts.push(entry.exact.length);
    entry.exact += `${strings.join("\u0000")}\u0001`;
    entry.looseStarts.push(entry.loose.length);
    entry.loose += `${strings.map(alnum).join("\u0000")}\u0001`;
    entry.blocks.push(index);
    byPage.set(page, entry);
  });
  const blockAt = (starts: number[], at: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= at) low = mid; else high = mid - 1;
    }
    return low;
  };
  /** Every block holding the value exactly or ignoring spacing and punctuation (both: a hit of one never hides the other). */
  const findIn = (entry: PageIndex, value: string, loose: string): number[] => {
    const found = new Set<number>();
    for (const [haystack, needle, starts] of [[entry.exact, value, entry.exactStarts], [entry.loose, loose, entry.looseStarts]] as const) {
      if (!needle) continue;
      for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) found.add(entry.blocks[blockAt(starts, at)]!);
    }
    return [...found];
  };
  const offsets = pageCount > 1 ? pageOffsets(text, pageCount) : null;
  const unmapped: Array<number[] | null> = [];
  let textLoose: string | null = null;
  const allLoose = () => (textLoose ??= alnum(text));
  const counted = new Map<string, number>();
  const blockOccurrences = (needle: string) => {
    let count = counted.get(needle);
    if (count === undefined) {
      count = 0;
      for (const entry of byPage.values()) count += occurrences(entry.loose, needle);
      counted.set(needle, count);
    }
    return count;
  };
  for (const match of matches) {
    const value = text.slice(match.charOffset, match.charOffset + match.length);
    const loose = alnum(value);
    const pages = offsets ? pagesOfMatch(offsets, match.charOffset, match.length) : null;
    const candidates = pages ? [...pages.map((page) => byPage.get(page)), byPage.get(null)] : [...byPage.values()];
    let found = candidates.flatMap((entry) => (entry ? findIn(entry, value, loose) : []));
    // Paged text whose page disagrees with the blocks' page: look everywhere rather than miss the value.
    if (found.length === 0 && pages) found = [...byPage.values()].flatMap((entry) => findIn(entry, value, loose));
    // A short value can also sit inside an unrelated string (an order number), so a hit there does not show that the
    // match's own occurrence was found. For short values every occurrence in the text (ignoring spacing and
    // punctuation) needs one in the blocks; fewer, and the match is unmapped (the caller fails closed).
    const located = loose.length >= SHORT_VALUE_CHARS || occurrences(allLoose(), loose) <= blockOccurrences(loose);
    if (found.length === 0 || !located) {
      unmapped.push(pages ?? (pageCount <= 1 ? [1] : null));
      if (found.length === 0) continue;
    }
    for (const index of new Set(found)) {
      blockIndexes.set(index, (blockIndexes.get(index) ?? new Set<PiiPatternType>()).add(match.patternType));
      values.set(index, [...(values.get(index) ?? []), { value, type: match.patternType }]);
    }
  }
  return { blockIndexes, values, unmapped };
}

/**
 * A canonical block with each listed value redacted wherever it appears (text, heading path, metadata strings). A
 * string that holds the value only with different spacing or punctuation is replaced whole.
 */
export function redactValuesInBlock<T extends CanonicalBlockLike>(block: T, values: ReadonlyArray<{ value: string; type: PiiPatternType }>): T {
  const redactString = (input: string): string => {
    let out = input;
    for (const { value, type } of values) {
      if (!value) continue;
      if (out.includes(value)) out = out.split(value).join(`[REDACTED:${type}]`);
      else if (alnum(value) && alnum(out).includes(alnum(value))) return `[REDACTED:${type}]`;
    }
    return out;
  };
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") return redactString(node);
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, child]) => [key, isStructuralKey(key) ? child : visit(child)]));
    }
    return node;
  };
  return {
    ...block,
    ...(typeof block.text === "string" ? { text: redactString(block.text) } : {}),
    ...(Array.isArray(block.headingPath) ? { headingPath: block.headingPath.map(visit) } : {}),
    ...(block.metadata && typeof block.metadata === "object" ? { metadata: visit(block.metadata) } : {}),
  };
}

/** Markdown or source text with the plan applied. */
/**
 * Page-scoped rewrite of `\f`-separated text: withheld pages become their placeholder, and every other page is
 * redacted on its own. Withholding runs on the original text, before any redaction, and redaction never sees a page
 * break, so a match whose span crosses a break can never merge pages and shift later ones (the page count is kept by
 * construction). `matches` are the whole text's matches (offsets into `text`): each is clipped to every clean page it
 * touches and replaced there first, so a value split by a page break, which a scan of one page alone may not
 * recognise, is still redacted on both pages.
 */
export function withholdPagesThenRedact(
  text: string,
  pages: ReadonlySet<number>,
  redact: (page: string) => string,
  matches: readonly PiiMatch[] = [],
  pageTypes?: ReadonlyMap<number, readonly PiiPatternType[]>,
): string {
  let start = 0;
  return text.split("\f").map((page, index) => {
    const pageStart = start;
    const pageEnd = start + page.length;
    start = pageEnd + 1;
    if (pages.has(index + 1)) return piiWithheldPageText(index + 1, pageTypes?.get(index + 1));
    // Clip to the page, merge overlapping spans (earliest first, as `redactPii` does), then replace from the end.
    const clippedSpans = matches
      .map((match) => ({ type: match.patternType, from: Math.max(match.charOffset, pageStart), to: Math.min(match.charOffset + match.length, pageEnd) }))
      .filter((span) => span.to > span.from)
      .sort((left, right) => left.from - right.from || right.to - left.to);
    const merged: typeof clippedSpans = [];
    for (const span of clippedSpans) {
      const last = merged.at(-1);
      if (last && span.from < last.to) last.to = Math.max(last.to, span.to);
      else merged.push({ ...span });
    }
    let clipped = page;
    for (const span of merged.reverse()) {
      clipped = `${clipped.slice(0, span.from - pageStart)}[REDACTED:${span.type}]${clipped.slice(span.to - pageStart)}`;
    }
    return redact(clipped);
  }).join("\f");
}

export function applyPlanToText(plan: PiiWithholdingPlan, text: string, matches: readonly PiiMatch[]): string {
  if (plan.scope === "pages") return withholdTextPages(text, new Set(plan.pages), plan.pageTypes);
  if (plan.scope === "sections") return withholdTextSections(text, matches).text;
  return text;
}

/**
 * The canonical document with the plan applied. Paged: each withheld page becomes one placeholder block, headings
 * from a withheld page leave the heading paths of later pages, and blocks without a page (their origin unknown)
 * become section placeholders. Unpaged: each block with a hit becomes a placeholder.
 */
export function applyPlanToCanonical<T extends { blocks?: unknown }>(
  plan: PiiWithholdingPlan,
  document: T,
  hitBlockIndexes: ReadonlySet<number>,
): T {
  const blocks = Array.isArray(document.blocks) ? (document.blocks as CanonicalBlockLike[]) : [];
  if (plan.scope === "sections") {
    return {
      ...document,
      blocks: blocks.map((block, index) => hitBlockIndexes.has(index)
        ? { ...block, type: "paragraph", text: PII_WITHHELD_SECTION_TEXT, metadata: { piiWithheld: true } }
        : block),
    };
  }
  if (plan.scope !== "pages") return document;
  const withheld = new Set(plan.pages);
  const withheldHeadings = withheldHeadingTexts(blocks, withheld);
  const seen = new Set<number>();
  const out: CanonicalBlockLike[] = [];
  for (const block of blocks) {
    const page = typeof block.pageNumber === "number" ? block.pageNumber : null;
    if (page !== null && withheld.has(page)) {
      if (seen.has(page)) continue;
      seen.add(page);
      out.push({ ...block, type: "paragraph", text: piiWithheldPageText(page, plan.pageTypes.get(page)), headingPath: [], bbox: null, metadata: { piiWithheld: true } });
      continue;
    }
    const headingPath = withoutWithheldHeadings(block.headingPath, withheldHeadings);
    if (page === null) {
      out.push({ ...block, type: "paragraph", text: PII_WITHHELD_SECTION_TEXT, headingPath, metadata: { piiWithheld: true } });
      continue;
    }
    out.push({ ...block, headingPath });
  }
  return { ...document, blocks: out };
}

/**
 * Plain heading text (what heading-path entries hold) of every heading block on a withheld page. A heading block's own
 * path ends with its plain text; its raw line (`## Jane Roe: intake`) is reduced the same way as a fallback.
 */
export function withheldHeadingTexts(blocks: readonly CanonicalBlockLike[], withheld: ReadonlySet<number>): Set<string> {
  const out = new Set<string>();
  for (const block of blocks) {
    if (typeof block.pageNumber !== "number" || !withheld.has(block.pageNumber) || block.type !== "heading") continue;
    const own = Array.isArray(block.headingPath) ? block.headingPath.at(-1) : undefined;
    if (typeof own === "string" && own.trim()) out.add(own.trim());
    if (typeof block.text === "string") {
      const parsed = parseAtxHeading(block.text.trim());
      const plain = plainHeadingText(parsed ? parsed.text : block.text);
      if (plain.trim()) out.add(plain.trim());
    }
  }
  return out;
}

/** A heading path without the entries a withheld page's headings contributed. */
export function withoutWithheldHeadings(headingPath: unknown, withheldHeadings: ReadonlySet<string>): unknown {
  if (!Array.isArray(headingPath) || withheldHeadings.size === 0) return headingPath;
  return headingPath.filter((heading) => typeof heading !== "string" || !withheldHeadings.has(heading.trim()));
}

/**
 * A JSON artifact (the extraction contract) with the plan applied: every string under a node on a withheld page, or
 * under no page at all, becomes a placeholder. Identifier and location fields are kept so siblings still link.
 */
export function applyPlanToJson(plan: PiiWithholdingPlan, value: unknown, isStructuralKey: (key: string) => boolean): unknown {
  if (plan.scope !== "pages") return value;
  const withheld = new Set(plan.pages);
  const visit = (node: unknown, page: number | null): unknown => {
    if (typeof node === "string") {
      if (page === null) return node.trim() ? PII_WITHHELD_SECTION_TEXT : node;
      return withheld.has(page) ? piiWithheldPageText(page, plan.pageTypes.get(page)) : node;
    }
    if (Array.isArray(node)) return node.map((item) => visit(item, page));
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const nodePage = typeof record.pageNumber === "number" ? record.pageNumber : page;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) out[key] = isStructuralKey(key) ? child : visit(child, nodePage);
      return out;
    }
    return node;
  };
  return visit(value, null);
}

/**
 * Whether an artifact recorded before the scan may still be served. Only per-page artifacts (page images, renders,
 * figures) of pages that are known clean are: anything else holds text from every page and stays withheld.
 */
export function perPageArtifactServable(slot: string, cleanPage: (page: number) => boolean): boolean {
  const page = withheldPageOfSlot(slot);
  return page !== null && cleanPage(page);
}

/**
 * Whether `\f`-separated text (bytes of a Markdown slot read after the scan) is safe to keep as a copy under page-scoped
 * withholding: its page breaks match the page count and every withheld page is exactly the placeholder. Anything else
 * (unknown page breaks, a withheld page that still holds text, not UTF-8) is not.
 */
export function pageScopedTextVerified(bytes: Uint8Array | null, withholding: PiiWithholding, pageCount: number): boolean {
  if (!bytes || withholding.scope !== "pages") return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const offsets = pageOffsets(text, pageCount);
  if (!offsets) return false;
  return offsets.every((range, index) =>
    !isPageWithheld(withholding, index + 1) || isPiiWithheldPlaceholder(text.slice(range.start, range.end)));
}

/**
 * The extraction contract of an unpaged document under section withholding: its whole-text fields (`markdown`,
 * `rawText`) lose the sections that hold a match, as the Markdown slot does. Each field is scanned in its original
 * form (`original`) and its matched sections are replaced there; a field with no match keeps its redacted form, and
 * every other field keeps `redacted` (values replaced).
 */
export function applySectionsToContract(original: unknown, redacted: unknown, scan: (text: string) => { matches: readonly PiiMatch[] }): unknown {
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) return redacted;
  const source = original && typeof original === "object" && !Array.isArray(original) ? original as Record<string, unknown> : {};
  const out: Record<string, unknown> = { ...(redacted as Record<string, unknown>) };
  for (const field of ["markdown", "rawText"] as const) {
    const text = source[field];
    if (typeof text !== "string") continue;
    const matches = scan(text).matches;
    if (matches.length > 0) out[field] = withholdTextSections(text, matches).text;
  }
  return out;
}
