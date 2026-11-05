import {
  splitTextIntoPagesStrict,
  type ExtractionContract,
  type ExtractionHeader,
  type ExtractionLink,
  type CanonicalDocument,
  type ExtractionTable,
} from "@docslurp/shared";
import { scoreExtractionPlausibility } from "./extracted-markdown.js";
import { estimateTokens, foldKey } from "./unicode-text.js";

/** Whole-heading titles of a table of contents. A substring test ("toc") also matched Stockton, protocol and octocat. */
const TOC_HEADINGS = new Set([
  "table of contents", "contents", "toc", "index of contents",
  "inhaltsverzeichnis", "inhalt", "sommaire", "table des matieres", "table des matières",
  "indice", "índice", "tabla de contenido", "sumário", "sumario", "indice dei contenuti", "inhoud", "inhoudsopgave",
  "содержание", "оглавление", "目次", "目录", "目錄", "차례", "목차", "المحتويات", "विषय सूची",
].map(foldKey));

function isTocHeading(text: string): boolean {
  return TOC_HEADINGS.has(foldKey(text.replace(/^#+\s*/, "")));
}

/** Five or more consecutive entries that end in a page number after a dot leader or a wide gap. */
function hasLeaderTocRun(text: string): boolean {
  let run = 0;
  for (const line of text.split("\n")) {
    if (/\S.*(?:\.{3,}|…|·{3,}|\s{3,})\s*\d{1,4}\s*$/u.test(line)) {
      if (++run >= 5) return true;
    } else if (line.trim()) {
      run = 0;
    }
  }
  return false;
}

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
  // Page numbers only where the text's own page breaks match the page count;
  // otherwise the document is one section of unknown page.
  const strictPages = splitTextIntoPagesStrict(markdown, pageCount);
  const pages = strictPages ?? [markdown.replace(/\f/g, "\n")];
  const plausibilitySignals = scoreExtractionPlausibility(markdown, pageCount);

  const headers: ExtractionHeader[] = [];
  const links: ExtractionLink[] = [];
  const tables: ExtractionTable[] = [];

  let hasToC = false;
  let hasLaTeX = false;
  let hasCode = false;
  const hasQRCodes = false;

  if (canonicalDocument) {
    for (const block of canonicalDocument.blocks) {
      if (block.type === "heading") {
        headers.push({
          level: (block.metadata.level as number) ?? 1,
          text: block.text,
          pageNumber: block.pageNumber,
        });
        if (isTocHeading(block.text)) {
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
    const pageNumber = strictPages ? index + 1 : null;

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
        if (isTocHeading(headerMatch[2])) {
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
    if (hasLeaderTocRun(pageText)) {
      hasToC = true;
    }
    // hasQRCodes stays false: a page that mentions "QR code" does not contain one,
    // and only a decoder run over the page images (not in the pipeline yet) can say.
  });

  // Simple token/chunk counts
  const tokenCount = estimateTokens(markdown);
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
