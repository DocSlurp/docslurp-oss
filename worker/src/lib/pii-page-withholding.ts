import {
  isPiiWithheldPlaceholder,
  pageOffsets,
  pagesOfMatch,
  PII_WITHHELD_SECTION_TEXT,
  piiWithheldPageText,
  withheldPageOfSlot,
  withholdTextPages,
  withholdTextSections,
  type PiiMatch,
  type PiiPolicy,
} from "@docslurp/shared";

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
  | { scope: "pages"; pages: number[]; carriedPages: number[] }
  | { scope: "sections"; sectionCount: number }
  | { scope: "document"; reason: string };

type Located = { pages: Set<number>; unattributed: string[] };

export type PiiScanFindings = {
  pageCount: number;
  canonical: { matches: PiiMatch[]; changedPages: Array<number | null>; blocks: CanonicalBlockLike[] } | null;
  markdown: { text: string; matches: PiiMatch[] } | null;
  fallback: { text: string; matches: PiiMatch[] } | null;
  html: { matches: PiiMatch[] } | null;
  contract: { matches: PiiMatch[] } | null;
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
  const place = (fingerprint: string, found: number[]) => {
    for (const page of found) pages.add(page);
    const known = byFingerprint.get(fingerprint) ?? new Set<number>();
    for (const page of found) known.add(page);
    byFingerprint.set(fingerprint, known);
  };

  for (const match of findings.canonical?.matches ?? []) {
    if (validPage(match.pageNumber, pageCount)) place(match.matchedPrefix, [match.pageNumber]);
    else unattributed.push("canonical-block-without-page");
  }
  for (const page of findings.canonical?.changedPages ?? []) {
    if (validPage(page, pageCount)) pages.add(page);
    else unattributed.push("canonical-block-without-page");
  }
  for (const [source, entry] of [["markdown", findings.markdown], ["source-text", findings.fallback]] as const) {
    if (!entry || entry.matches.length === 0) continue;
    const offsets = pageOffsets(entry.text, pageCount);
    for (const match of entry.matches) {
      const found = pagesOfMatch(offsets, match.charOffset, match.length);
      if (found) place(match.matchedPrefix, found);
      else unattributed.push(`${source}-page-breaks-unknown`);
    }
  }
  for (const [source, entry] of [["html", findings.html], ["extraction-contract", findings.contract]] as const) {
    for (const match of entry?.matches ?? []) {
      if (validPage(match.pageNumber, pageCount)) {
        place(match.matchedPrefix, [match.pageNumber]);
        continue;
      }
      // The HTML rendering and page-less contract fields repeat text a paged source already placed.
      const known = byFingerprint.get(match.matchedPrefix);
      if (known && known.size > 0) for (const page of known) pages.add(page);
      else unattributed.push(`${source}-match-without-page`);
    }
  }
  return { pages, unattributed: [...new Set(unattributed)] };
}

/** Pages a previous scan already replaced with the withheld placeholder: a rescan of rewritten text keeps them. */
export function carriedWithheldPages(findings: PiiScanFindings): Set<number> {
  const carried = new Set<number>();
  const { pageCount } = findings;
  for (const entry of [findings.markdown, findings.fallback]) {
    if (!entry) continue;
    const offsets = pageOffsets(entry.text, pageCount);
    if (!offsets || pageCount <= 1) continue;
    offsets.forEach((range, index) => {
      if (isPiiWithheldPlaceholder(entry.text.slice(range.start, range.end))) carried.add(index + 1);
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
      if (meaningful.length > 0 && meaningful.every(isPiiWithheldPlaceholder)) carried.add(page);
    }
  }
  return carried;
}

/** Decide what `block_indexing` withholds. Other actions withhold no pages except ones a previous scan replaced. */
export function planPiiWithholding(action: PiiPolicy["action"], findings: PiiScanFindings, anyMatch: boolean): PiiWithholdingPlan {
  const carried = carriedWithheldPages(findings);
  const blocking = action === "block_indexing" || action === "block_document";
  if (!anyMatch || !blocking) {
    return carried.size > 0
      ? withPages(findings, [...carried], [...carried])
      : { scope: "none" };
  }
  if (action === "block_document") return { scope: "document", reason: "policy-block-document" };

  if (findings.pageCount <= 1) return planSections(findings);

  const located = locateMatches(findings);
  if (located.unattributed.length > 0) return { scope: "document", reason: `unattributed:${located.unattributed.join(",")}` };
  if (located.pages.size === 0) return { scope: "document", reason: "unattributed:no-page-for-match" };
  return withPages(findings, [...located.pages, ...carried], [...carried]);
}

function withPages(findings: PiiScanFindings, pages: number[], carriedPages: number[]): PiiWithholdingPlan {
  const unique = [...new Set(pages)].sort((a, b) => a - b);
  if (unique.length >= findings.pageCount) return { scope: "document", reason: "every-page-withheld" };
  // Text artifacts are rewritten page by page; text whose page breaks are unknown cannot be.
  for (const [source, entry] of [["markdown", findings.markdown], ["source-text", findings.fallback]] as const) {
    if (entry && pageOffsets(entry.text, findings.pageCount) === null) {
      return { scope: "document", reason: `unattributed:${source}-page-breaks-unknown` };
    }
  }
  return { scope: "pages", pages: unique, carriedPages: [...new Set(carriedPages)].sort((a, b) => a - b) };
}

function planSections(findings: PiiScanFindings): PiiWithholdingPlan {
  const text = findings.markdown ?? findings.fallback;
  const textMatches = text?.matches.length ?? 0;
  const otherMatches = (findings.canonical?.matches.length ?? 0) + (findings.canonical?.changedPages.length ?? 0)
    + (findings.html?.matches.length ?? 0) + (findings.contract?.matches.length ?? 0);
  // Text the sections are cut from must hold the hit itself; a hit only elsewhere cannot be located in it.
  if (text && textMatches === 0 && otherMatches > 0) return { scope: "document", reason: "unattributed:section-not-located" };
  if (!text && !findings.canonical) return { scope: "document", reason: "unattributed:no-text" };
  const sectionCount = text
    ? withholdTextSections(text.text, text.matches).withheldSectionCount
    : new Set((findings.canonical?.matches ?? []).map((match) => match.charOffset)).size || 1;
  return { scope: "sections", sectionCount: Math.max(1, sectionCount) };
}

/** Markdown or source text with the plan applied. */
export function applyPlanToText(plan: PiiWithholdingPlan, text: string, matches: readonly PiiMatch[]): string {
  if (plan.scope === "pages") return withholdTextPages(text, new Set(plan.pages));
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
  const withheldHeadings = new Set(
    blocks
      .filter((block) => typeof block.pageNumber === "number" && withheld.has(block.pageNumber) && block.type === "heading" && typeof block.text === "string")
      .map((block) => (block.text as string).trim()),
  );
  const seen = new Set<number>();
  const out: CanonicalBlockLike[] = [];
  for (const block of blocks) {
    const page = typeof block.pageNumber === "number" ? block.pageNumber : null;
    if (page !== null && withheld.has(page)) {
      if (seen.has(page)) continue;
      seen.add(page);
      out.push({ ...block, type: "paragraph", text: piiWithheldPageText(page), headingPath: [], bbox: null, metadata: { piiWithheld: true } });
      continue;
    }
    const headingPath = Array.isArray(block.headingPath)
      ? block.headingPath.filter((heading) => typeof heading !== "string" || !withheldHeadings.has(heading.trim()))
      : block.headingPath;
    if (page === null) {
      out.push({ ...block, type: "paragraph", text: PII_WITHHELD_SECTION_TEXT, headingPath, metadata: { piiWithheld: true } });
      continue;
    }
    out.push({ ...block, headingPath });
  }
  return { ...document, blocks: out };
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
      return withheld.has(page) ? piiWithheldPageText(page) : node;
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
