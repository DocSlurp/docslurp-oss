/*
 * The Auto ladder in the worker (@docslurp/shared auto-ladder.ts): each page's rung from page triage, planned once per
 * document from the stored triage artifact and the pages extraction already read, so vision fan-out (planPageTasks), its
 * page tasks and the whole-document pass all execute the same plan.
 *
 * - Extraction (extract-markdown) reads scanned PDF pages with the OCR engine before triage runs. Under an above-fast
 *   share it reads at most the document's budget of them, in document order, and records which ones it read here.
 * - Vision (vision-extract) plans the rest: pages already read count first, then pages without native text, then higher
 *   triage confidence, then document order.
 */
import {
  documentLadderPolicy,
  isMultiFrameImageFile,
  DRAWN_CONTENT_SIGNAL,
  MIXED_SCAN_IMAGE_SIGNAL,
  planLadder,
  type AdaptivePageRoutingEntry,
  type DocumentLadderPolicy,
  type LadderPageNeed,
  type LadderPlan,
  type PipelineFeatures,
} from "@docslurp/shared";

import { pageLacksNativeText, selectLegacyVisionPages, TABLE_LEAK_ONLY_SIGNAL } from "../stages/classify-route.js";
import { ocrFailedPages } from "../ocr/mode.js";

/** Document artifact slot: JSON list of pages extraction read above fast (the OCR engine on scanned pages). */
export const LADDER_EXTRACT_ESCALATED_KEY = "ladder-extract-escalated";

type Ledger = {
  read(slot: string): string | undefined | null;
  readDocument(documentId: string, key: string): string | undefined | null;
  recordDocument(documentId: string, key: string, value: string): unknown;
  record(slot: string, value: string): unknown;
};

const pageList = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((page): page is number => Number.isSafeInteger(page) && page > 0) : [];

/**
 * A ladder slot's pages, only when this run wrote it: a reprocess seeds the source run's artifacts into the new run, and
 * an earlier run's plan or reads (under its own limits) say nothing about this one.
 */
function runPages(raw: string | null | undefined, runId: string, field: "pages" | "escalated" | "intelligent"): number[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value?.runId !== runId) return null;
    return pageList(value[field]);
  } catch {
    return null;
  }
}

/** Pages extraction read above fast for this document in this run. */
export function extractEscalatedPages(ledger: Pick<Ledger, "readDocument">, documentId: string, runId: string): Set<number> {
  return new Set(runPages(ledger.readDocument(documentId, LADDER_EXTRACT_ESCALATED_KEY), runId, "pages") ?? []);
}

/** Adds pages extraction read above fast (also under the content hash, so a deduplicated copy inherits them). */
export function recordExtractEscalatedPages(ledger: Ledger, documentId: string, runId: string, pages: readonly number[], contentHash?: string): void {
  const known = extractEscalatedPages(ledger, documentId, runId);
  for (const page of pages) if (Number.isSafeInteger(page) && page > 0) known.add(page);
  const value = JSON.stringify({ runId, pages: [...known].sort((a, b) => a - b) });
  ledger.recordDocument(documentId, LADDER_EXTRACT_ESCALATED_KEY, value);
  if (contentHash) ledger.record(`${LADDER_EXTRACT_ESCALATED_KEY}:${contentHash}`, value);
}

/** A deduplicated document inherits the pages its original's extraction read (its Markdown is reused). */
export function inheritExtractEscalatedPages(ledger: Ledger, documentId: string, contentHash: string): void {
  const inherited = ledger.read(`${LADDER_EXTRACT_ESCALATED_KEY}:${contentHash}`);
  if (inherited) ledger.recordDocument(documentId, LADDER_EXTRACT_ESCALATED_KEY, inherited);
}

/** Triage routes whose content is a figure: read on the intelligent rung (the hosted vision model). */
const FIGURE_ROUTES = new Set(["chart-or-figure", "image-heavy"]);

/** Why triage selected a page, in ladder terms. */
function needOf(page: AdaptivePageRoutingEntry | undefined): Pick<LadderPageNeed, "need" | "reason" | "lacksText" | "confidence"> {
  if (!page) return { need: "ocr", reason: "no-page-triage", lacksText: true, confidence: 0 };
  const signals = page.ocrDecision?.signals ?? [];
  // The same test that orders vision's page selection (classify-route.ts prioritizePagesWithoutNativeText).
  const lacksText = pageLacksNativeText(page);
  const confidence = page.ocrDecision?.confidence ?? page.confidence;
  if (FIGURE_ROUTES.has(page.route)) return { need: "intelligent", reason: `figure:${page.route}`, lacksText, confidence };
  const reason = signals.includes(MIXED_SCAN_IMAGE_SIGNAL) ? "mixed-scan"
    : signals.includes(DRAWN_CONTENT_SIGNAL) ? "drawn-content"
    : signals.includes(TABLE_LEAK_ONLY_SIGNAL) ? "table-rescue"
    : lacksText ? "no-native-text"
    : page.extractorHint === "vision-rescue" ? "vision-rescue"
    : page.ocrDecision?.authorized ? `triage:${signals[0] ?? "authorized"}`
    : `route:${page.route}`;
  return { need: "ocr", reason, lacksText, confidence };
}

/** The ladder needs of the pages vision selected, from page triage (pages without triage need transcription). */
export function ladderNeeds(selectedPages: readonly number[], triage: readonly AdaptivePageRoutingEntry[]): LadderPageNeed[] {
  const byPage = new Map(triage.map((page) => [page.pageNumber, page]));
  return selectedPages.map((pageNumber) => ({ pageNumber, ...needOf(byPage.get(pageNumber)) }));
}

export interface DocumentLadder {
  policy: DocumentLadderPolicy;
  plan: LadderPlan;
}

/** Plans a document's rungs: its selected pages under the run's limits, after the pages extraction already read. */
export function planDocumentLadder(args: {
  pipeline: Pick<PipelineFeatures, "quality" | "ladder">;
  runId: string;
  documentId: string;
  pageCount: number;
  selectedPages: readonly number[];
  triage: readonly AdaptivePageRoutingEntry[];
  ledger: Pick<Ledger, "readDocument">;
}): DocumentLadder {
  const policy = documentLadderPolicy(args.pipeline, args.pageCount);
  const plan = planLadder({
    pageCount: args.pageCount,
    needs: ladderNeeds(args.selectedPages, args.triage),
    policy,
    alreadyEscalated: extractEscalatedPages(args.ledger, args.documentId, args.runId),
  });
  return { policy, plan };
}

/** Document artifact slot: the first plan's escalated pages, so every later plan of this run executes at most those. */
export const LADDER_PLAN_KEY = "ladder-plan";

/** A run's pinned plan for a document: the pages it escalated and the ones it read on the intelligent rung. */
export interface LadderPin {
  escalated: Set<number>;
  intelligent: Set<number>;
}

/** The plan this run pinned for the document, or null when it has none yet (or only an earlier run's). */
export function readLadderPin(ledger: Pick<Ledger, "readDocument">, documentId: string, runId: string): LadderPin | null {
  const raw = ledger.readDocument(documentId, LADDER_PLAN_KEY);
  const escalated = runPages(raw, runId, "escalated");
  if (!escalated) return null;
  return { escalated: new Set(escalated), intelligent: new Set(runPages(raw, runId, "intelligent") ?? []) };
}

/**
 * The pages vision may read under the plan this run first made for the document. The first plan is recorded; a later one
 * (the whole-document pass, a retried activity) keeps only pages the first one escalated, and on the intelligent rung only
 * pages the first one put there, so retries and restarts never read more than the first plan allowed.
 */
export function pinLadderPlan(ledger: Ledger, documentId: string, runId: string, plan: LadderPlan): LadderPin {
  const stored = readLadderPin(ledger, documentId, runId);
  if (stored) {
    return {
      escalated: new Set(plan.escalated.filter((page) => stored.escalated.has(page))),
      intelligent: new Set(plan.intelligent.filter((page) => stored.intelligent.has(page))),
    };
  }
  ledger.recordDocument(documentId, LADDER_PLAN_KEY, JSON.stringify({ runId, escalated: plan.escalated, intelligent: plan.intelligent }));
  return { escalated: new Set(plan.escalated), intelligent: new Set(plan.intelligent) };
}

/**
 * Vision's page selection from page triage (the legacy, non-router path) with the ladder applied: the pages triage
 * selects (selectLegacyVisionPages, without pages whose OCR failed), planned by planDocumentLadder. `keepAsImage` are
 * pages a limit kept off every model whose content is pixels only: render-images keeps them as page images, as Fast does.
 */
export function visionLadderSelection(args: {
  pipeline: Pick<PipelineFeatures, "quality" | "ladder">;
  runId: string;
  documentId: string;
  pageCount: number;
  triage: readonly AdaptivePageRoutingEntry[];
  routingV2: boolean;
  ledger: Pick<Ledger, "readDocument">;
}): DocumentLadder & { selected: number[]; keepAsImage: number[] } {
  const failed = ocrFailedPages(args.ledger as never, args.documentId);
  const selected = selectLegacyVisionPages([...args.triage], { routingV2: args.routingV2 }).filter((page) => !failed.has(page));
  const ladder = planDocumentLadder({ ...args, selectedPages: selected });
  const byPage = new Map(args.triage.map((page) => [page.pageNumber, page]));
  const keepAsImage = ladder.plan.decisions
    .filter((decision) => decision.rung === "fast" && decision.cappedBy && byPage.has(decision.pageNumber) && pageLacksNativeText(byPage.get(decision.pageNumber)!))
    .map((decision) => decision.pageNumber);
  return { ...ladder, selected, keepAsImage };
}

/**
 * Whether the ladder keeps an image file unread (kept as its page image, as Fast keeps it). The OCR engine reads every
 * frame of an image and intake counts an image as one page, so under an above-fast share a format that can hold several
 * frames (TIFF, GIF, WebP), whose frame count is unknown before the read, is never sent; nor is any image whose frames the share does not
 * cover. A single-frame image is one page and the share always allows one.
 */
export function ladderKeepsImageUnread(
  policy: Pick<DocumentLadderPolicy, "quality" | "ladder" | "aboveFastBinding">,
  file: { filename?: string | null; mimeType?: string | null; sniffedMimeType?: string | null },
): boolean {
  if (policy.quality !== "auto" || policy.ladder.aboveFast === undefined) return false;
  const type = (file.sniffedMimeType ?? file.mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(file.filename ?? "")?.[1]?.toLowerCase() ?? "";
  // Formats that can hold several frames (animated GIF and WebP as well as TIFF): never sent under a share (fail closed).
  const mayHoldFrames = isMultiFrameImageFile({ name: file.filename ?? "", type: type || null })
    || MAY_HOLD_FRAMES_TYPES.has(type) || MAY_HOLD_FRAMES_EXTENSIONS.has(extension);
  return policy.aboveFastBinding || mayHoldFrames;
}

const MAY_HOLD_FRAMES_TYPES = new Set(["image/gif", "image/webp", "image/apng"]);
const MAY_HOLD_FRAMES_EXTENSIONS = new Set(["gif", "webp", "apng"]);
