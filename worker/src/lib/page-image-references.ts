import {
  canonicalDocumentSchema,
  extractionContractSchema,
  isPageImageReferenceMarkdown,
  pageImageReferenceMarkdown,
  stripPageImageReferences,
  type AdaptiveRoutingDecisionSurface,
  type CanonicalDocument,
} from "@docslurp/shared";

import type { WorkflowState } from "../pipeline/pipeline.js";
import type { Document } from "../models.js";
import { type ArtifactStore, keyFromStorageUri } from "../tools/storage.js";
import { runArtifactRoot } from "./artifact-root.js";
import { reconcileCanonicalArtifacts } from "./canonical-reconciliation.js";
import { refreshSummaryEvidence } from "../stages/summary-evidence-refresh.js";

/** Classification signal for a page with neither text nor a significant image. */
const BLANK_PAGE_SIGNAL = "ocr-not-authorized:blank-page";

/**
 * Pages Fast keeps as page images: pages whose extracted text is empty (no usable text layer), except pages
 * classification judged blank (nothing to show). An image file is its single page.
 */
export function pagesKeptAsImage(args: {
  canonicalDocument: CanonicalDocument | null;
  pageCount: number;
  isImage: boolean;
  routing?: AdaptiveRoutingDecisionSurface | null;
}): number[] {
  if (args.isImage) {
    const text = (args.canonicalDocument?.blocks ?? [])
      .filter((block) => !isPageImageReferenceMarkdown(block.text))
      .map((block) => block.text).join("").trim();
    return text ? [] : [1];
  }
  const pageCount = Math.max(1, Math.trunc(args.pageCount));
  const withText = new Set(
    (args.canonicalDocument?.blocks ?? [])
      .filter((block) => block.text.trim().length > 0 && !isPageImageReferenceMarkdown(block.text))
      .map((block) => block.pageNumber ?? 1),
  );
  const blank = new Set(
    args.routing?.status === "ready"
      ? args.routing.pages
          .filter((page) => page.ocrDecision?.signals.includes(BLANK_PAGE_SIGNAL) || page.signals.includes(BLANK_PAGE_SIGNAL))
          .map((page) => page.pageNumber)
      : [],
  );
  const pages: number[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    if (!withText.has(pageNumber) && !blank.has(pageNumber)) pages.push(pageNumber);
  }
  return pages;
}

/**
 * Writes Fast page-image references into a document's searchable artifacts: each page in `pages` gets
 * `pageImageReferenceMarkdown(page)` in place of its (empty) text, through the same canonical reconciliation
 * vision uses, and the reconciled canonical document, extraction contract and Markdown replace the ledger
 * entries. Returns the pages actually changed (none when the artifacts are missing).
 */
export async function applyPageImageReferences(args: {
  state: WorkflowState;
  document: Document;
  storage: ArtifactStore;
  pages: number[];
  manifestUri: string;
}): Promise<number[]> {
  const { state, document, storage } = args;
  if (args.pages.length === 0) return [];
  const contractUri = state.artifactLedger.readDocument(document.id, "extraction-contract");
  const canonicalUri = state.artifactLedger.readDocument(document.id, "canonical-document");
  const contractKey = contractUri ? keyFromStorageUri(contractUri, storage.bucket) : null;
  const canonicalKey = canonicalUri ? keyFromStorageUri(canonicalUri, storage.bucket) : null;
  if (!contractKey || !canonicalKey) {
    console.warn(
      `[render-images] page-image references skipped document=${document.id} ` +
        `contract=${contractUri ? "present" : "missing"} canonical=${canonicalUri ? "present" : "missing"}`,
    );
    return [];
  }
  const contract = extractionContractSchema.parse(await storage.getJson(contractKey));
  const canonicalDocument = canonicalDocumentSchema.parse(await storage.getJson(canonicalKey));
  const reconciled = reconcileCanonicalArtifacts({
    canonicalDocument,
    extractionContract: contract,
    replacements: args.pages.map((pageNumber) => ({
      pageNumber,
      markdown: pageImageReferenceMarkdown(pageNumber),
      source: {
        adapter: "page-image",
        model: "none",
        confidence: 1,
        confidenceBasis: "page-triage" as const,
        reason: "fast-quality-kept-as-image",
        artifactUri: args.manifestUri,
      },
    })),
  });
  if (reconciled.changedPages.length === 0) return [];

  const root = runArtifactRoot(state.run, document.userId);
  const canonicalOut = `${root}/canonical-reconciled/${document.id}.json`;
  const contractOut = `${root}/extraction-reconciled/${document.id}.contract.json`;
  const markdownOut = `${root}/markdown-reconciled/${document.id}.md`;
  const reconciliationOut = `${root}/canonical-reconciliation/${document.id}.json`;
  await storage.putJson(canonicalOut, reconciled.canonicalDocument);
  await storage.putJson(contractOut, reconciled.extractionContract);
  await storage.putBytes(markdownOut, Buffer.from(reconciled.markdown, "utf8"), "text/markdown; charset=utf-8");
  await storage.putJson(reconciliationOut, {
    documentId: document.id,
    changedPages: reconciled.changedPages,
    decisions: reconciled.decisions,
    sourceCanonicalUri: canonicalUri,
    sourceContractUri: contractUri,
  });
  state.artifactLedger.recordDocument(document.id, "canonical-document", storage.uri(canonicalOut));
  state.artifactLedger.recordDocument(document.id, "extraction-contract", storage.uri(contractOut));
  state.artifactLedger.recordDocument(document.id, "markdown", storage.uri(markdownOut));
  state.artifactLedger.recordDocument(document.id, "canonical-reconciliation", storage.uri(reconciliationOut));
  await refreshSummaryEvidence({
    storage, ledger: state.artifactLedger, document,
    text: stripPageImageReferences(reconciled.markdown), sourceUri: storage.uri(markdownOut),
  });
  return reconciled.changedPages;
}
