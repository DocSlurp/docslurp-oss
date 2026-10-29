import {
  canonicalDocumentSchema,
  extractionContractSchema,
  PAGE_IMAGE_REFERENCE_ADAPTER,
  blankPages,
  isPageImageReferenceBlock,
  pageImageExtension,
  pageImageReferenceMarkdown,
  pageImageReferencePages,
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

/** Default caps on Fast page-image renders (WORKER_FAST_PAGE_IMAGE_MAX_PER_DOCUMENT / _PER_RUN). */
export const FAST_PAGE_IMAGE_MAX_PER_DOCUMENT = 1_000;
export const FAST_PAGE_IMAGE_MAX_PER_RUN = 10_000;

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Caps on pages Fast renders to keep as page images: per document and per run. 0 renders none. */
export function fastPageImageCaps(env: NodeJS.ProcessEnv = process.env): { perDocument: number; perRun: number } {
  return {
    perDocument: positiveIntEnv(env.WORKER_FAST_PAGE_IMAGE_MAX_PER_DOCUMENT, FAST_PAGE_IMAGE_MAX_PER_DOCUMENT),
    perRun: positiveIntEnv(env.WORKER_FAST_PAGE_IMAGE_MAX_PER_RUN, FAST_PAGE_IMAGE_MAX_PER_RUN),
  };
}

/**
 * Pages Fast found without extracted text, split into the pages it keeps as page images and the pages it leaves
 * unread. A page has text when a non-reference canonical block on it has text; pages classification judged blank
 * (nothing to show) are left unread, as are textless pages past `maxPages` (in page order, so every page-range shard
 * of a document agrees). Fails closed, rendering nothing: no canonical document (missing or unparseable) means the
 * pages' text is unknown, and in a multi-page document a text block without a page number means page attribution is
 * unknown. An image file is its single page.
 */
export function pagesKeptAsImage(args: {
  canonicalDocument: CanonicalDocument | null;
  pageCount: number;
  isImage: boolean;
  routing?: AdaptiveRoutingDecisionSurface | null;
  maxPages?: number;
}): { kept: number[]; unread: number[]; reason: string | null } {
  const maxPages = Math.max(0, Math.trunc(args.maxPages ?? Number.POSITIVE_INFINITY));
  const textBlocks = (args.canonicalDocument?.blocks ?? [])
    .filter((block) => block.text.trim().length > 0 && !isPageImageReferenceBlock(block));
  if (args.isImage) {
    if (textBlocks.length > 0) return { kept: [], unread: [], reason: null };
    return maxPages >= 1 ? { kept: [1], unread: [], reason: null } : { kept: [], unread: [1], reason: "cap" };
  }
  if (!args.canonicalDocument) return { kept: [], unread: [], reason: "canonical-document-missing" };
  const pageCount = Math.max(1, Math.trunc(args.pageCount));
  if (pageCount > 1 && textBlocks.some((block) => block.pageNumber === null || block.pageNumber === undefined)) {
    return { kept: [], unread: [], reason: "unpaged-text" };
  }
  const withText = new Set(textBlocks.map((block) => block.pageNumber ?? 1));
  const blank = new Set(
    args.routing?.status === "ready"
      ? args.routing.pages
          .filter((page) => page.ocrDecision?.signals.includes(BLANK_PAGE_SIGNAL) || page.signals.includes(BLANK_PAGE_SIGNAL))
          .map((page) => page.pageNumber)
      : [],
  );
  const kept: number[] = [];
  const unread: number[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    if (withText.has(pageNumber)) continue;
    if (!blank.has(pageNumber) && kept.length < maxPages) kept.push(pageNumber);
    else unread.push(pageNumber);
  }
  return { kept, unread, reason: unread.length > 0 && kept.length >= maxPages ? "cap" : null };
}

/**
 * Per-run budget of Fast page-image renders, shared by the documents one worker process renders for a run. A
 * document's grant is remembered, so page-range shards, the stage that follows them and a retried stage reuse it
 * instead of spending the budget again. A distributed run can exceed the budget by at most one per-document cap
 * per concurrent worker.
 */
const runRenderBudgets = new Map<string, { used: number; touched: number; grants: Map<string, number> }>();

/** Reserves up to `wanted` renders of a run's budget for one document and returns how many were granted. */
export function reserveFastPageImageRenders(runId: string, documentId: string, wanted: number, perRun: number): number {
  const now = Date.now();
  for (const [id, entry] of runRenderBudgets) if (now - entry.touched > 6 * 60 * 60_000) runRenderBudgets.delete(id);
  const entry = runRenderBudgets.get(runId) ?? { used: 0, touched: now, grants: new Map<string, number>() };
  entry.touched = now;
  runRenderBudgets.set(runId, entry);
  const previous = entry.grants.get(documentId);
  if (previous !== undefined) return Math.min(previous, wanted);
  const granted = Math.max(0, Math.min(wanted, perRun - entry.used));
  entry.used += granted;
  entry.grants.set(documentId, granted);
  return granted;
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
  /** Pages to reference, each with its stored page image's key or URI (its format names the reference). */
  pages: Array<{ pageNumber: number; artifactUri: string }>;
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
    replacements: args.pages.map(({ pageNumber, artifactUri }) => ({
      pageNumber,
      markdown: pageImageReferenceMarkdown(pageNumber, pageImageExtension(artifactUri)),
      source: {
        adapter: PAGE_IMAGE_REFERENCE_ADAPTER,
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
    text: blankPages(reconciled.markdown, pageImageReferencePages(reconciled.canonicalDocument.blocks)),
    sourceUri: storage.uri(markdownOut),
  });
  return reconciled.changedPages;
}
