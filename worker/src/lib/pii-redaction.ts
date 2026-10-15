import { type PiiMatch, type PiiPatternType, scanAndRedactPii } from "@docslurp/shared";

/** Scans one string (optionally tagged with its page) and returns matches plus the redacted string. */
export type PiiTextScanner = (text: string, pageNumber?: number | null) => { matches: PiiMatch[]; redacted: string };

export function createPiiTextScanner(
  patterns: readonly PiiPatternType[],
  allowlistPatterns: readonly string[],
): PiiTextScanner {
  return (text, pageNumber = null) => scanAndRedactPii(text, patterns, { pageNumber, allowlistPatterns });
}

/** Keys whose string values are identifiers or locations, never document text. */
const STRUCTURAL_KEY = /^(?:id|ids|uri|url|key|hash|sha256)$|[a-z0-9](?:Id|Ids|ID|Uri|URI|Url|URL|Key|Hash|Sha256)$/;

function isStructuralKey(key: string): boolean {
  return STRUCTURAL_KEY.test(key);
}

/**
 * Redact every text-bearing string inside a JSON value (table cells, headings,
 * page text, link labels). Identifier and URI fields are left alone so the
 * artifact still links to its siblings.
 */
export function redactJsonText(
  value: unknown,
  scan: PiiTextScanner,
  pageNumber: number | null = null,
): { value: unknown; matches: PiiMatch[] } {
  const matches: PiiMatch[] = [];

  const visit = (node: unknown, page: number | null): unknown => {
    if (typeof node === "string") {
      const result = scan(node, page);
      matches.push(...result.matches);
      return result.redacted;
    }
    if (Array.isArray(node)) {
      return node.map((item) => visit(item, page));
    }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const nodePage = typeof record.pageNumber === "number" ? record.pageNumber : page;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) {
        out[key] = isStructuralKey(key) ? child : visit(child, nodePage);
      }
      return out;
    }
    return node;
  };

  return { value: visit(value, pageNumber), matches };
}

type CanonicalLikeBlock = {
  text?: unknown;
  headingPath?: unknown;
  pageNumber?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

/**
 * Redact the canonical document in place of its text: block text, heading
 * paths and block metadata (table cells and rows). Chunks, page text,
 * propositions, summaries and structured extraction all read these fields.
 */
export function redactCanonicalDocument<T extends { blocks?: unknown }>(
  document: T,
  scan: PiiTextScanner,
): { document: T; matches: PiiMatch[]; changed: boolean } {
  const blocks = Array.isArray(document.blocks) ? (document.blocks as CanonicalLikeBlock[]) : [];
  const matches: PiiMatch[] = [];
  let changed = false;

  const redactedBlocks = blocks.map((block) => {
    const page = typeof block.pageNumber === "number" ? block.pageNumber : null;
    const next: CanonicalLikeBlock = { ...block };
    if (typeof block.text === "string") {
      const result = scan(block.text, page);
      matches.push(...result.matches);
      if (result.matches.length > 0) changed = true;
      next.text = result.redacted;
    }
    if (Array.isArray(block.headingPath)) {
      next.headingPath = block.headingPath.map((heading) => {
        if (typeof heading !== "string") return heading;
        const result = scan(heading, page);
        // Heading text repeats on every block below it; detections count block text only.
        if (result.matches.length > 0) changed = true;
        return result.redacted;
      });
    }
    if (block.metadata && typeof block.metadata === "object") {
      const result = redactJsonText(block.metadata, scan, page);
      if (result.matches.length > 0) changed = true;
      next.metadata = result.value;
    }
    return next;
  });

  return { document: { ...document, blocks: redactedBlocks }, matches, changed };
}
