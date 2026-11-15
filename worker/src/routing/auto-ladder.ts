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

const parsePages = (raw: string | null | undefined): number[] => {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((page): page is number => Number.isSafeInteger(page) && page > 0) : [];
  } catch {
    return [];
  }
};

/** Pages extraction read above fast for this document in this run. */
export function extractEscalatedPages(ledger: Pick<Ledger, "readDocument">, documentId: string): Set<number> {
  return new Set(parsePages(ledger.readDocument(documentId, LADDER_EXTRACT_ESCALATED_KEY)));
}

/** Adds pages extraction read above fast (also under the content hash, so a deduplicated copy inherits them). */
export function recordExtractEscalatedPages(ledger: Ledger, documentId: string, pages: readonly number[], contentHash?: string): void {
  const known = extractEscalatedPages(ledger, documentId);
  for (const page of pages) if (Number.isSafeInteger(page) && page > 0) known.add(page);
  const list = JSON.stringify([...known].sort((a, b) => a - b));
  ledger.recordDocument(documentId, LADDER_EXTRACT_ESCALATED_KEY, list);
  if (contentHash) ledger.record(`${LADDER_EXTRACT_ESCALATED_KEY}:${contentHash}`, list);
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
    alreadyEscalated: extractEscalatedPages(args.ledger, args.documentId),
  });
  return { policy, plan };
}

/** Document artifact slot: the first plan's escalated pages, so every later plan of this run executes at most those. */
export const LADDER_PLAN_KEY = "ladder-plan";

/**
 * The pages vision may read under the plan this run first made for the document. The first plan is recorded; a later one
 * (page tasks, the whole-document pass, a retried activity) keeps only pages the first one escalated, so fan-out,
 * retries and restarts can never read more pages than the first plan allowed.
 */
export function pinLadderPlan(ledger: Ledger, documentId: string, plan: LadderPlan): { escalated: Set<number>; intelligent: Set<number> } {
  const stored = ledger.readDocument(documentId, LADDER_PLAN_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { escalated?: unknown; intelligent?: unknown };
      const pages = (value: unknown) => new Set(Array.isArray(value) ? value.filter((page): page is number => Number.isSafeInteger(page) && page > 0) : []);
      const escalated = pages(parsed.escalated);
      const intelligent = pages(parsed.intelligent);
      return {
        escalated: new Set(plan.escalated.filter((page) => escalated.has(page))),
        intelligent: new Set(plan.intelligent.filter((page) => intelligent.has(page))),
      };
    } catch {
      // An unreadable pin allows nothing beyond a fresh plan that is itself within the limits.
    }
  }
  ledger.recordDocument(documentId, LADDER_PLAN_KEY, JSON.stringify({ escalated: plan.escalated, intelligent: plan.intelligent }));
  return { escalated: new Set(plan.escalated), intelligent: new Set(plan.intelligent) };
}

/** Whether a pinned plan (LADDER_PLAN_KEY) lets vision read `page`; no pin yet allows it (the plan made the task). */
export function ladderPinAllows(stored: string | null | undefined, page: number): boolean {
  if (!stored) return true;
  try {
    const escalated = (JSON.parse(stored) as { escalated?: unknown }).escalated;
    return Array.isArray(escalated) && escalated.includes(page);
  } catch {
    return false;
  }
}

/**
 * Vision's page selection from page triage (the legacy, non-router path) with the ladder applied: the pages triage
 * selects (selectLegacyVisionPages, without pages whose OCR failed), planned by planDocumentLadder. `keepAsImage` are
 * pages a limit kept off every model whose content is pixels only: render-images keeps them as page images, as Fast does.
 */
export function visionLadderSelection(args: {
  pipeline: Pick<PipelineFeatures, "quality" | "ladder">;
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
