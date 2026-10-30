import {
  canonicalDocumentSchema,
  isPageImageReferenceBlock,
  type CanonicalBlock,
  type CanonicalDocument,
  type ExtractionContract,
} from "@docslurp/shared";

import { buildCanonicalDocumentFromMarkdown } from "./canonical-document.js";
import { buildExtractionContract } from "./extraction-contract.js";

export interface CanonicalReplacementSource {
  adapter: string;
  model: string;
  confidence: number;
  confidenceBasis: "page-triage" | "specialist";
  reason: string;
  artifactUri?: string | null;
}

export interface CanonicalPageReplacement {
  pageNumber: number;
  markdown: string;
  source: CanonicalReplacementSource;
}

export interface CanonicalReconciliationDecision {
  pageNumber: number;
  outcome: "accepted" | "rejected";
  reason: string;
  source: CanonicalReplacementSource;
  replacedBlockIds: string[];
}

export interface CanonicalReconciliationResult {
  canonicalDocument: CanonicalDocument;
  extractionContract: ExtractionContract;
  markdown: string;
  rawText: string;
  decisions: CanonicalReconciliationDecision[];
  changedPages: number[];
}

/**
 * Reconciles trusted page-level specialist output into the searchable Document.
 *
 * Callers identify weak pages and supply one candidate per page. This Module
 * owns validation, deterministic replacement, provenance, canonical ordering,
 * Markdown/raw-text regeneration, and extraction-contract rebuilding.
 */
export function reconcileCanonicalArtifacts(args: {
  canonicalDocument: CanonicalDocument;
  extractionContract: ExtractionContract;
  replacements: CanonicalPageReplacement[];
  minimumConfidence?: number;
}): CanonicalReconciliationResult {
  const canonicalDocument = canonicalDocumentSchema.parse(args.canonicalDocument);
  const minimumConfidence = args.minimumConfidence ?? 0.5;
  const decisions: CanonicalReconciliationDecision[] = [];
  const accepted = new Map<number, CanonicalPageReplacement>();
  const pageCount = Math.max(1, canonicalDocument.stats.pageCount);

  for (const replacement of selectBestReplacementPerPage(args.replacements)) {
    const replacedBlockIds = canonicalDocument.blocks
      .filter((block) => block.pageNumber === replacement.pageNumber)
      .map((block) => block.id);
    const rejectionReason = validateReplacement({
      replacement,
      pageCount,
      minimumConfidence,
      currentText: canonicalDocument.blocks
        .filter((block) => block.pageNumber === replacement.pageNumber)
        .map((block) => block.text)
        .join("\n\n"),
    });

    if (rejectionReason) {
      decisions.push({
        pageNumber: replacement.pageNumber,
        outcome: "rejected",
        reason: rejectionReason,
        source: replacement.source,
        replacedBlockIds,
      });
      continue;
    }

    accepted.set(replacement.pageNumber, replacement);
    decisions.push({
      pageNumber: replacement.pageNumber,
      outcome: "accepted",
      reason: replacement.source.reason,
      source: replacement.source,
      replacedBlockIds,
    });
  }

  const blocks = reconcileBlocks(canonicalDocument, accepted);
  const changedPages = [...accepted.keys()].sort((left, right) => left - right);
  const reconciledDocument = canonicalDocumentSchema.parse({
    ...canonicalDocument,
    generator:
      changedPages.length > 0
        ? `${canonicalDocument.generator}+canonical-reconciliation@v1`
        : canonicalDocument.generator,
    stats: buildCanonicalStats(canonicalDocument, blocks),
    blocks,
  });
  const markdown = canonicalDocumentToMarkdown(reconciledDocument);
  const rawText = canonicalDocumentToRawText(reconciledDocument);
  const rebuiltContract = buildExtractionContract({
    documentId: reconciledDocument.documentId,
    markdown,
    extractor: args.extractionContract.metadata.extractor,
    strategy:
      changedPages.length > 0
        ? `${args.extractionContract.metadata.strategy}+canonical-reconciliation`
        : args.extractionContract.metadata.strategy,
    extractionTimeMs: args.extractionContract.metadata.extractionTimeMs,
    pageCount,
    canonicalDocument: reconciledDocument,
  });

  return {
    canonicalDocument: reconciledDocument,
    extractionContract: {
      ...rebuiltContract,
      rawText,
      images: [...args.extractionContract.images],
      charts: [...args.extractionContract.charts],
      metadata: {
        ...rebuiltContract.metadata,
        ocrStats: args.extractionContract.metadata.ocrStats,
      },
    },
    markdown,
    rawText,
    decisions,
    changedPages,
  };
}

export function canonicalDocumentToMarkdown(document: CanonicalDocument): string {
  const pageCount = Math.max(1, document.stats.pageCount);
  const pages = Array.from({ length: pageCount }, () => [] as CanonicalBlock[]);
  for (const block of document.blocks) {
    const pageIndex = Math.max(0, Math.min(pageCount - 1, (block.pageNumber ?? 1) - 1));
    pages[pageIndex]!.push(block);
  }

  return pages
    .map((blocks) =>
      blocks
        .sort((left, right) => left.order - right.order)
        .map(blockToMarkdown)
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\f");
}

export function canonicalDocumentToRawText(document: CanonicalDocument): string {
  const pageCount = Math.max(1, document.stats.pageCount);
  const pages = Array.from({ length: pageCount }, () => [] as CanonicalBlock[]);
  for (const block of document.blocks) {
    const pageIndex = Math.max(0, Math.min(pageCount - 1, (block.pageNumber ?? 1) - 1));
    pages[pageIndex]!.push(block);
  }
  return pages
    .map((blocks) =>
      blocks
        .sort((left, right) => left.order - right.order)
        // A Fast page-image reference is Markdown only: the page has no extracted text.
        .filter((block) => !isPageImageReferenceBlock(block))
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\f");
}

function selectBestReplacementPerPage(
  replacements: CanonicalPageReplacement[],
): CanonicalPageReplacement[] {
  const selected = new Map<number, CanonicalPageReplacement>();
  for (const replacement of replacements) {
    const current = selected.get(replacement.pageNumber);
    if (!current || replacement.source.confidence > current.source.confidence) {
      selected.set(replacement.pageNumber, replacement);
    }
  }
  return [...selected.values()].sort((left, right) => left.pageNumber - right.pageNumber);
}

function validateReplacement(args: {
  replacement: CanonicalPageReplacement;
  pageCount: number;
  minimumConfidence: number;
  currentText: string;
}): string | null {
  if (!Number.isInteger(args.replacement.pageNumber) || args.replacement.pageNumber < 1) {
    return "invalid-page-number";
  }
  if (args.replacement.pageNumber > args.pageCount) {
    return "page-out-of-range";
  }
  // Confidence gates replacement of existing evidence. An empty scan has no
  // native text to protect, and may also have no text-derived triage evidence.
  if (normalizeComparisonText(args.currentText) &&
      args.replacement.source.confidence < args.minimumConfidence) {
    return "confidence-below-threshold";
  }
  const replacementText = normalizeComparisonText(args.replacement.markdown);
  if (!replacementText) {
    return "empty-specialist-output";
  }
  if (replacementText === normalizeComparisonText(args.currentText)) {
    return "unchanged-specialist-output";
  }
  return null;
}

function reconcileBlocks(
  document: CanonicalDocument,
  accepted: Map<number, CanonicalPageReplacement>,
): CanonicalBlock[] {
  if (accepted.size === 0) {
    return document.blocks.map((block) => ({ ...block, metadata: { ...block.metadata } }));
  }

  const blocksByPage = new Map<number, CanonicalBlock[]>();
  for (const block of document.blocks) {
    const pageNumber = block.pageNumber ?? 1;
    const blocks = blocksByPage.get(pageNumber) ?? [];
    blocks.push(block);
    blocksByPage.set(pageNumber, blocks);
  }

  const reconciled: CanonicalBlock[] = [];
  const pageCount = Math.max(1, document.stats.pageCount);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const replacement = accepted.get(pageNumber);
    if (!replacement) {
      reconciled.push(...(blocksByPage.get(pageNumber) ?? []));
      continue;
    }

    const replacedBlocks = blocksByPage.get(pageNumber) ?? [];
    const specialistDocument = buildCanonicalDocumentFromMarkdown({
      documentId: document.documentId,
      text: replacement.markdown,
      pageCount: 1,
      sourceArtifactUri: replacement.source.artifactUri,
      extractor: replacement.source.adapter,
    });
    specialistDocument.blocks.forEach((block, index) => {
      reconciled.push({
        ...block,
        id: `${document.documentId}:reconciled:${pageNumber.toString().padStart(4, "0")}:${index
          .toString()
          .padStart(4, "0")}`,
        pageNumber,
        bbox: null,
        metadata: {
          ...block.metadata,
          extractor: replacement.source.adapter,
          sourceArtifactUri: replacement.source.artifactUri ?? null,
          parserArtifactUri: null,
          replacementConfidence: replacement.source.confidence,
          replacementConfidenceBasis: replacement.source.confidenceBasis,
          replacedBlockIds: replacedBlocks.map((candidate) => candidate.id),
          provenance: {
            kind: "specialist-replacement",
            adapter: replacement.source.adapter,
            model: replacement.source.model,
            confidence: replacement.source.confidence,
            confidenceBasis: replacement.source.confidenceBasis,
            reason: replacement.source.reason,
            artifactUri: replacement.source.artifactUri ?? null,
            replacedBlockIds: replacedBlocks.map((candidate) => candidate.id),
          },
        },
      });
    });
  }

  return reconciled.map((block, order) => ({ ...block, order }));
}

function buildCanonicalStats(
  document: CanonicalDocument,
  blocks: CanonicalBlock[],
): CanonicalDocument["stats"] {
  const count = (type: CanonicalBlock["type"]) =>
    blocks.filter((block) => block.type === type).length;
  return {
    blockCount: blocks.length,
    headingCount: count("heading"),
    paragraphCount: count("paragraph"),
    codeBlockCount: count("code"),
    tableCount: count("table"),
    pageCount: Math.max(1, document.stats.pageCount),
  };
}

function blockToMarkdown(block: CanonicalBlock): string {
  const text = block.text.trim();
  if (!text) return "";
  if (block.type === "heading") {
    const level = Math.max(1, Math.min(6, Number(block.metadata.level ?? 1)));
    return `${"#".repeat(level)} ${text.replace(/^#{1,6}\s+/, "")}`;
  }
  if (block.type === "quote") {
    return text
      .split("\n")
      .map((line) => (line.startsWith(">") ? line : `> ${line}`))
      .join("\n");
  }
  return text;
}

function normalizeComparisonText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
