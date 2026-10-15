import type { CanonicalBlock, CanonicalDocument } from "@docslurp/shared";

import { buildCanonicalDocumentFromMarkdown } from "./canonical-document.js";

export interface StructuredWordBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StructuredTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
  confidence?: number;
  rotation?: number;
  words?: StructuredWordBox[];
}

export interface StructuredExtractionPage {
  pageNumber: number;
  width: number;
  height: number;
  markdown: string;
  text: string;
  textItems: StructuredTextItem[];
}

/**
 * Builds the canonical block tree from one parser result while its spatial
 * evidence is still local. Markdown supplies the parser's structural choices;
 * text items from that same invocation supply geometry and provenance.
 */
export function buildCanonicalDocumentFromStructuredExtraction(args: {
  documentId: string;
  extractor: string;
  pages: StructuredExtractionPage[];
  sourceArtifactUri?: string | null;
  parserArtifactUri?: string | null;
}): CanonicalDocument {
  const pages = [...args.pages].sort((left, right) => left.pageNumber - right.pageNumber);
  const markdown = pages.map((page) => page.markdown).join("\f");
  const document = buildCanonicalDocumentFromMarkdown({
    documentId: args.documentId,
    text: markdown,
    pageCount: pages.length,
    sourceArtifactUri: args.sourceArtifactUri,
    extractor: args.extractor,
  });

  document.generator = "structured-extraction-block-tree@v1";
  document.source.parser = args.extractor;
  document.source.parserArtifactUri = args.parserArtifactUri ?? null;
  for (const block of document.blocks) {
    const sourcePage = block.pageNumber === null ? undefined : pages[block.pageNumber - 1];
    block.pageNumber = sourcePage?.pageNumber ?? block.pageNumber;
  }
  document.stats.pageCount = pages.reduce(
    (maximum, page) => Math.max(maximum, page.pageNumber),
    0,
  );

  for (const page of pages) {
    enrichPageBlocks(
      document.blocks.filter((block) => block.pageNumber === page.pageNumber),
      page,
      {
        extractor: args.extractor,
        sourceArtifactUri: args.sourceArtifactUri ?? null,
        parserArtifactUri: args.parserArtifactUri ?? null,
      },
    );
  }

  return document;
}

function enrichPageBlocks(
  blocks: CanonicalBlock[],
  page: StructuredExtractionPage,
  provenance: {
    extractor: string;
    sourceArtifactUri: string | null;
    parserArtifactUri: string | null;
  },
): void {
  const itemTokens = page.textItems.flatMap((item, itemIndex) =>
    tokenize(item.text).map((token) => ({ token, itemIndex })),
  );
  let tokenCursor = 0;

  for (const block of blocks) {
    const blockTokens = tokenize(block.text);
    const matchStart = findTokenSequence(itemTokens, blockTokens, tokenCursor);
    const fallbackStart = matchStart < 0
      ? findTokenSequence(itemTokens, blockTokens, 0)
      : matchStart;
    const matchedItems = fallbackStart < 0
      ? []
      : collectMatchedItems(page.textItems, itemTokens, fallbackStart, blockTokens.length);

    if (fallbackStart >= 0) {
      tokenCursor = fallbackStart + blockTokens.length;
    }

    block.metadata = {
      ...block.metadata,
      extractor: provenance.extractor,
      sourceArtifactUri: provenance.sourceArtifactUri,
      parserArtifactUri: provenance.parserArtifactUri,
      structuredEvidenceMatched: matchedItems.length > 0,
      parserTextItemCount: matchedItems.length,
      pageWidth: page.width,
      pageHeight: page.height,
      bboxCoordinateSpace: "page-top-left-points",
    };

    if (matchedItems.length === 0) {
      continue;
    }

    block.bbox = unionBox(matchedItems);
    const confidence = mean(
      matchedItems
        .map((item) => item.confidence)
        .filter((value): value is number => typeof value === "number"),
    );
    const dominantFont = dominantValue(matchedItems, (item) => item.fontName);
    const dominantFontSize = dominantNumber(matchedItems, (item) => item.fontSize);
    const rotations = [...new Set(matchedItems.map((item) => item.rotation ?? 0))];
    const wordBoxes = matchedItems.flatMap((item) => item.words ?? []);

    if (confidence !== null) block.metadata.parserConfidence = confidence;
    if (dominantFont !== null) block.metadata.fontName = dominantFont;
    if (dominantFontSize !== null) block.metadata.fontSize = dominantFontSize;
    if (rotations.length > 0) block.metadata.rotations = rotations;
    if (wordBoxes.length > 0) block.metadata.wordBoxes = wordBoxes;
  }
}

function tokenize(text: string): string[] {
  const linkTextOnly = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  return (linkTextOnly.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
}

function findTokenSequence(
  haystack: Array<{ token: string; itemIndex: number }>,
  needle: string[],
  start: number,
): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;

  for (let index = Math.max(0, start); index <= haystack.length - needle.length; index++) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset]?.token !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function collectMatchedItems(
  items: StructuredTextItem[],
  tokenItems: Array<{ token: string; itemIndex: number }>,
  start: number,
  length: number,
): StructuredTextItem[] {
  const itemIndexes = new Set(
    tokenItems.slice(start, start + length).map((entry) => entry.itemIndex),
  );
  return [...itemIndexes]
    .sort((left, right) => left - right)
    .map((index) => items[index])
    .filter((item): item is StructuredTextItem => item !== undefined);
}

function unionBox(items: StructuredTextItem[]) {
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dominantValue<T extends string>(
  items: StructuredTextItem[],
  getValue: (item: StructuredTextItem) => T | undefined,
): T | null {
  const weights = new Map<T, number>();
  for (const item of items) {
    const value = getValue(item);
    if (value === undefined) continue;
    weights.set(value, (weights.get(value) ?? 0) + Math.max(1, item.text.length));
  }
  return [...weights.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function dominantNumber(
  items: StructuredTextItem[],
  getValue: (item: StructuredTextItem) => number | undefined,
): number | null {
  const weights = new Map<number, number>();
  for (const item of items) {
    const value = getValue(item);
    if (value === undefined) continue;
    weights.set(value, (weights.get(value) ?? 0) + Math.max(1, item.text.length));
  }
  return [...weights.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}
