import {
  splitTextIntoPages,
  type ExtractionContract,
  type ExtractionHeader,
  type ExtractionLink,
  type CanonicalDocument,
  type ExtractionTable,
} from "@docslurp/shared";
import { scoreExtractionPlausibility } from "./extracted-markdown.js";

export function buildExtractionContract(args: {
  documentId: string;
  markdown: string;
  extractor: string;
  strategy: string;
  extractionTimeMs: number;
  pageCount: number;
  canonicalDocument?: CanonicalDocument;
}): ExtractionContract {
  const {
    documentId,
    markdown,
    extractor,
    strategy,
    extractionTimeMs,
    pageCount,
    canonicalDocument,
  } = args;

  const rawText = markdown.replace(/[#*`]/g, ""); // Very basic raw text extraction
  const pages = splitTextIntoPages(markdown, pageCount);
  const plausibilitySignals = scoreExtractionPlausibility(markdown, pageCount);

  const headers: ExtractionHeader[] = [];
  const links: ExtractionLink[] = [];
  const tables: ExtractionTable[] = [];

  let hasToC = false;
  let hasLaTeX = false;
  let hasCode = false;
  let hasQRCodes = false;

  if (canonicalDocument) {
    for (const block of canonicalDocument.blocks) {
      if (block.type === "heading") {
        headers.push({
          level: (block.metadata.level as number) ?? 1,
          text: block.text,
          pageNumber: block.pageNumber,
        });
        if (
          block.text.toLowerCase().includes("table of contents") ||
          block.text.toLowerCase().includes("toc")
        ) {
          hasToC = true;
        }
      } else if (block.type === "table") {
        tables.push({
          id: block.id,
          markdown: block.text,
          rowCount: (block.metadata.rowCount as number) ?? 0,
          colCount: (block.metadata.colCount as number) ?? 0,
          pageNumber: block.pageNumber ?? 1,
          bbox: block.bbox
            ? {
                ...block.bbox,
                pageNumber: block.pageNumber ?? 1,
                polygon: (block.metadata.polygon as any) ?? [],
              }
            : null,
        });
      } else if (block.type === "code") {
        hasCode = true;
      }
    }
  }

  pages.forEach((pageText, index) => {
    const pageNumber = index + 1;

    // Fallback headers if no canonical doc
    if (!canonicalDocument) {
      const headerRegex = /^(#{1,6})\s+(.+)$/gm;
      let headerMatch: RegExpExecArray | null = headerRegex.exec(pageText);
      while (headerMatch) {
        headers.push({
          level: headerMatch[1].length,
          text: headerMatch[2].trim(),
          pageNumber,
        });
        if (
          headerMatch[2].toLowerCase().includes("table of contents") ||
          headerMatch[2].toLowerCase().includes("toc")
        ) {
          hasToC = true;
        }
        headerMatch = headerRegex.exec(pageText);
      }
    }

    // Extract links
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let linkMatch: RegExpExecArray | null = linkRegex.exec(pageText);
    while (linkMatch) {
      links.push({
        text: linkMatch[1].trim(),
        url: linkMatch[2].trim(),
        pageNumber,
      });
      linkMatch = linkRegex.exec(pageText);
    }

    // Check features
    if (pageText.includes("$$") || pageText.includes("\\begin{equation}")) {
      hasLaTeX = true;
    }
    if (pageText.includes("```")) {
      hasCode = true;
    }
    if (pageText.toLowerCase().includes("qr code")) {
      hasQRCodes = true;
    }
  });

  // Simple token/chunk counts
  const words = markdown.split(/\s+/).filter(Boolean).length;
  const tokenCount = Math.ceil(words * 1.35);
  const chunkCount = pages.length;

  return {
    documentId,
    markdown,
    rawText,
    images: [], // Populated later by vision/render stages
    charts: [], // Populated later
    tables,
    headers,
    links,
    hasToC,
    hasLaTeX,
    hasCode,
    hasQRCodes,
    metadata: {
      tokenCount,
      chunkCount,
      ocrStats: null,
      extractionTimeMs,
      extractor,
      strategy,
      plausibilityScore: plausibilitySignals.plausibilityScore,
      plausibilitySignals: {
        charYield: plausibilitySignals.charYield,
        averageWordLengthPlausibility:
          plausibilitySignals.averageWordLengthPlausibility,
        whitespacePlausibility: plausibilitySignals.whitespacePlausibility,
        charCount: plausibilitySignals.charCount,
        wordCount: plausibilitySignals.wordCount,
      },
    },
  };
}
