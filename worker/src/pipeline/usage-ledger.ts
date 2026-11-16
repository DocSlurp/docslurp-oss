import { recordUsageReceipt, usageTraceContext } from "@docslurp/shared/observability";
import { randomUUID } from "node:crypto";
import {
  BILLABLE_UNIT_METRICS,
  applySpeedBoostUnitCharge,
  speedBoostMultiplier,
  UNIT_CHARGE_PROVIDER,
  isUnitChargeEvent,
  pageCredits,
  pageUpgradeCredits,
  PAGE_READ_METRICS,
  priceAiUsageEvent,
  richPagesForOutputTokens,
  unitChargeMetadata,
} from "@docslurp/shared";

import type { UsageEvent } from "../models.js";
import { withServedUsageModel } from "@docslurp/shared";
import {
  buildWorkerAiUsageEvent,
  hasWorkerAiUsage,
  logWorkerAiUsage,
  type WorkerAiUsageInput,
} from "../lib/ai-usage.js";

/**
 * Usage metrics that mean the OCR route transcribed one page: the engine the operator configured for OCR, whatever runs
 * it. Each such page bills one flat OCR page per run (`ingest-page-ocr`), however long its text:
 * - `page-ocr`: a page or image frame the OCR engine read, in its VM or the self-hosted sandbox (ocr/ledger.ts);
 * - `pdf-ocr`: an extractor that OCRs pages itself without reporting which;
 * - `ocr-native-pdf`: the native PDF engine's own OCR (self-hosted local mode);
 * - `ocr-page-reader`: the OCR route's page reader, a second read of OCR'd pages in its own VM (ocr/page-reader.ts);
 * - `hosted-ocr`: DOCSLURP_OCR_MODE=hosted, where the operator's hosted OCR model reads a stored image in the engine's place.
 */
export const OCR_PAGE_READ_METRICS: ReadonlySet<string> = new Set([
  "page-ocr",
  "pdf-ocr",
  "ocr-native-pdf",
  "ocr-page-reader",
  "hosted-ocr",
]);

/**
 * Usage metrics that mean a vision model interpreted one page's content: the project's vision model (`page-analysis`), the
 * document map's vision read of a page without text (`document-map-ocr`, the run's vision route) and `ocr-escalation`, the
 * hosted vision read of a page the OCR engine read poorly (which upgrades that page from OCR to Rich, in every quality that
 * runs it). Each such page bills as Rich pages, once per run, as many as the pricing provider counts for its output tokens
 * (`richPagesForOutputTokens`). A Fast-mode page that falls back to vision is billed Rich the same way. Page-image embedding
 * charges Rich through `chargeRichPage`.
 *
 * A local caption of a photo on the page (`image-label`, the image labeler) is in neither set: it describes a picture,
 * it does not read the page's text, so it is recorded at its compute cost and the page stays Fast.
 */
export const RICH_PAGE_READ_METRICS: ReadonlySet<string> = new Set([
  "page-analysis",
  "document-map-ocr",
  "ocr-escalation",
]);

/**
 * Page reads that bill one Rich page at most: their output tokens never add Rich units, and a
 * read that returned no text (`metadata.outcome = "empty-output"`) charges nothing. `ocr-escalation` is the hosted second
 * read of a page the recogniser read poorly (owner decision, 2026-11-05); its provider cost is recorded either way.
 */
export const FLAT_RICH_PAGE_READ_METRICS: ReadonlySet<string> = new Set(["ocr-escalation"]);

/** Events taken for one checkpoint write; `commit()` once it has persisted. */
export interface PipelineUsageBatch {
  events: UsageEvent[];
  commit(): void;
}

/**
 * Pipeline Usage Event ledger: the only way a run records and flushes Usage
 * Events. Callers say what happened; the ledger prices AI calls, writes the
 * `[ai-usage]` log line, assigns stable ids (so a retried checkpoint cannot
 * double insert), and hands checkpoints a batch that is only dropped from the
 * buffer once the write commits. Events recorded while a checkpoint is in
 * flight stay buffered for the next one.
 *
 * Billing: AI and compute events are recorded at provider cost but bill 0
 * credits (priceAiUsageEvent). The billable events are price-card units: a
 * page the OCR route read adds one `ingest-page-ocr` charge here, a page a
 * vision model read adds `ingest-page-rich` charges (deterministic ids per
 * run and page); Fast pages are charged when the run completes
 * (db/page-base-fee.ts) and media minutes by the media stage.
 *
 * Page classes per run and page, each charged once: OCR then Rich pays the
 * Rich charge minus the OCR charge already made (the page's first Rich unit
 * carries the difference); Rich then OCR adds nothing; a page charged OCR or
 * Rich is never charged Fast at completion.
 */
export class PipelineUsageEventLedger {
  readonly speedBoost: boolean;

  constructor(speedBoost: boolean = false) {
    speedBoostMultiplier(speedBoost);
    this.speedBoost = speedBoost;
    Object.defineProperty(this, "speedBoost", { writable: false, configurable: false });
  }

  private readonly pending: UsageEvent[] = [];
  private readonly lifetime = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  private pendingBillable = 0;
  /**
   * Rich pages charged by this ledger, by `documentId:pageNumber`: how many (`pages`, the page's Rich units so far) and the
   * output tokens each reader (`metric:model`) has produced for the page (`readers`). A page's total is the sum over its readers
   * of each reader's largest read: OCR then a vision model both count, while a reader reading the page again (a retry) adds only
   * what its biggest read exceeds its earlier ones.
   */
  private readonly richCharged = new Map<string, { pages: number; readers: Map<string, number> }>();
  /** OCR page charges by `documentId:pageNumber`: the charge's event id. */
  private readonly ocrCharged = new Map<string, string>();

  /** Run being billed; set by WorkflowState. Rich page charges need it for their idempotent ids. */
  runId: string | null = null;

  /**
   * Record an AI/embedding call: price it, log it, buffer it. `visionAttemptTicket` is the vision
   * guard request that read the page: a Rich charge this record creates carries it, so the checkpoint
   * that persists the charge removes that request from the org's uncharged count.
   */
  record(input: WorkerAiUsageInput, options: { visionAttemptTicket?: string | null } = {}): UsageEvent | null {
    const event = buildWorkerAiUsageEvent(withServedUsageModel(input));
    this.chargePageRead(event, options.visionAttemptTicket ?? null);
    if (!hasWorkerAiUsage(event)) {
      return null;
    }
    logWorkerAiUsage(event, { includeOutputTokens: input.logOutputTokens });
    return this.buffer(event);
  }

  /**
   * Buffer a pre-built event. Cost-only events (local compute, fees, failed
   * attempts) are kept as long as they carry tokens, an amount, or a cost.
   * Pass `logAiUsage` when the event describes an AI call attempt.
   */
  enqueue(
    event: UsageEvent,
    options: { logAiUsage?: boolean } = {},
  ): UsageEvent | null {
    if (options.logAiUsage) {
      logWorkerAiUsage({
        ...event,
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        metadata: event.metadata ?? {},
      });
    }
    this.chargePageRead(event);
    if (!hasUsageToPersist(event)) {
      return null;
    }
    return this.buffer(event);
  }

  /** Rich pages (units) this ledger has charged for a page: 0 when no model read it. */
  richPagesCharged(documentId: string, pageNumber: number): number {
    return this.richCharged.get(`${documentId}:${pageNumber}`)?.pages ?? 0;
  }

  /** Whether this ledger already charged the page as Rich. */
  hasRichCharge(documentId: string, pageNumber: number): boolean {
    return this.richCharged.has(`${documentId}:${pageNumber}`);
  }

  /** Whether this ledger already charged the page as OCR (it may also have been upgraded to Rich since). */
  hasOcrCharge(documentId: string, pageNumber: number): boolean {
    return this.ocrCharged.has(`${documentId}:${pageNumber}`);
  }

  /** The dearest class this ledger charged the page in: `rich`, `ocr`, or null when no read charged it. */
  pageChargeClass(documentId: string, pageNumber: number): "ocr" | "rich" | null {
    if (this.hasRichCharge(documentId, pageNumber)) return "rich";
    return this.hasOcrCharge(documentId, pageNumber) ? "ocr" : null;
  }

  /** Pages of a document this ledger charged as Rich. */
  richPagesOf(documentId: string): Set<number> {
    return pagesOf(this.richCharged.keys(), documentId);
  }

  /** Pages of a document this ledger charged by a read, OCR or Rich (so Fast charges skip them). */
  readPagesOf(documentId: string): Set<number> {
    return new Set([...pagesOf(this.richCharged.keys(), documentId), ...pagesOf(this.ocrCharged.keys(), documentId)]);
  }

  /** Charge a page a model read as an image (page-image embedding) as a Rich page, once per run. */
  chargeRichPage(args: { documentId: string; pageNumber: number; readBy: string; model?: string; outputTokens?: number }): void {
    this.chargeRichPageRead({ metric: args.readBy, model: args.model, outputTokens: args.outputTokens ?? 0,
      metadata: { documentId: args.documentId, pageNumber: args.pageNumber } }, true);
  }

  /** Charge a page the OCR route read (OCR_PAGE_READ_METRICS) as one OCR page, once per run. */
  chargeOcrPage(args: { documentId: string; pageNumber: number; readBy: string; model?: string }): void {
    this.chargeOcrPageRead({ metric: args.readBy, model: args.model, metadata: { documentId: args.documentId, pageNumber: args.pageNumber } }, true);
  }

  private chargePageRead(event: { metric: string; model?: string; outputTokens?: number | null; metadata?: Record<string, unknown> | null }, visionAttemptTicket: string | null = null): void {
    if (OCR_PAGE_READ_METRICS.has(event.metric)) this.chargeOcrPageRead(event, false, visionAttemptTicket);
    else this.chargeRichPageRead(event, false, visionAttemptTicket);
  }

  /**
   * An OCR read of a page: one flat OCR page per run and page (`ocr:<run>:<document>:<page>`, so a retried checkpoint or a
   * second OCR reader of the page adds nothing), whatever its output length. A page this ledger already charged Rich adds
   * nothing: its Rich charge covers the read.
   */
  private chargeOcrPageRead(
    event: { metric: string; model?: string; metadata?: Record<string, unknown> | null },
    force = false,
    visionAttemptTicket: string | null = null,
  ): void {
    if (!this.runId || (!force && !OCR_PAGE_READ_METRICS.has(event.metric))) return;
    const page = pageOf(event.metadata);
    if (!page) return;
    const key = `${page.documentId}:${page.pageNumber}`;
    if (this.ocrCharged.has(key) || this.richCharged.has(key)) return;
    const id = `ocr:${this.runId}:${key}`;
    this.ocrCharged.set(key, id);
    const charge: UsageEvent = {
      id,
      provider: UNIT_CHARGE_PROVIDER,
      model: "price-card",
      metric: BILLABLE_UNIT_METRICS.ocrPage,
      amount: 1,
      unit: "page",
      costCents: pageCredits("ocr", 1),
      inputTokens: 0,
      outputTokens: 0,
      metadata: unitChargeMetadata({ documentId: page.documentId, pageNumber: page.pageNumber, readBy: event.metric, model: event.model }),
    };
    this.buffer(visionAttemptTicket ? { ...charge, visionAttemptTicket } : charge);
  }

  /**
   * A vision read of a page: buffer its billable Rich page charges. The page's first read charges one Rich page (the id
   * makes a retried checkpoint a no-op); every reader's output tokens count toward the page's running total, and the page owes one
   * more Rich unit when the pricing provider counts more for the output (richPagesForOutputTokens). Each unit
   * after the first is its own event with a deterministic id (`rich:<run>:<document>:<page>:unit:<n>`), so a read that comes
   * after a cheaper one (a retry with a larger output budget) raises the charge to what the total owes, and a retried
   * checkpoint, or a retry that reads again, can never charge a unit twice. A flat read (FLAT_RICH_PAGE_READ_METRICS) counts
   * no output tokens and charges nothing when it returned no text. A page this run already charged OCR is upgraded: its first
   * Rich unit charges the Rich price minus the OCR charge (`upgradeOf` names that charge), so the page pays Rich once in all.
   */
  private chargeRichPageRead(
    event: { metric: string; model?: string; outputTokens?: number | null; metadata?: Record<string, unknown> | null },
    force = false,
    visionAttemptTicket: string | null = null,
  ): void {
    if (!this.runId || (!force && !RICH_PAGE_READ_METRICS.has(event.metric))) return;
    const page = pageOf(event.metadata);
    if (!page) return;
    const { documentId, pageNumber } = page;
    const flat = FLAT_RICH_PAGE_READ_METRICS.has(event.metric);
    if (flat && event.metadata?.outcome === "empty-output") return;
    const key = `${documentId}:${pageNumber}`;
    const outputTokens = flat ? 0 : Math.max(0, Number(event.outputTokens ?? 0) || 0);
    const before = this.richCharged.get(key);
    const readers = before?.readers ?? new Map<string, number>();
    const reader = `${event.metric}:${event.model ?? ""}`;
    readers.set(reader, Math.max(readers.get(reader) ?? 0, outputTokens));
    const total = [...readers.values()].reduce((sum, tokens) => sum + tokens, 0);
    const owed = richPagesForOutputTokens(total);
    const charged = before?.pages ?? 0;
    this.richCharged.set(key, { pages: Math.max(charged, owed), readers });
    // An OCR charge of this page (this run) is credited against its first Rich unit: the page pays Rich once in all.
    const ocrCharge = this.ocrCharged.get(key) ?? null;
    const unit = (n: number) => ({
      id: n === 1 ? `rich:${this.runId}:${key}` : `rich:${this.runId}:${key}:unit:${n}`,
      provider: UNIT_CHARGE_PROVIDER,
      model: "price-card",
      metric: BILLABLE_UNIT_METRICS.richPage,
      amount: 1,
      unit: "page",
      costCents: n === 1 && ocrCharge ? pageUpgradeCredits("ocr", "rich") : pageCredits("rich", 1),
      inputTokens: 0,
      outputTokens: 0,
      metadata: unitChargeMetadata({ documentId, pageNumber, readBy: event.metric, model: event.model, outputTokens: total,
        ...(n > 1 ? { unit: n } : {}), ...(n === 1 && ocrCharge ? { upgradeOf: ocrCharge, upgradeFrom: "ocr" } : {}) }),
    });
    for (let n = Math.max(1, charged + 1); n <= owed; n += 1) {
      // The vision call's request ticket rides on the page's first charge only: a later read of a charged page stays uncharged.
      this.buffer(n === 1 && visionAttemptTicket ? { ...unit(n), visionAttemptTicket } : unit(n));
    }
  }

  /** Number of events buffered since the last committed checkpoint. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Billable cost (credits) of the events buffered since the last committed
   * checkpoint, kept as a running sum so cost-cap checks stay O(1). Together
   * with `project_runs.spent_cents` (the committed part) it is the run's
   * spend figure (checkpoints.ts runSpentCents).
   */
  get pendingBillableCents(): number {
    return this.pendingBillable;
  }

  /** Events buffered since the last committed checkpoint. */
  snapshot(): UsageEvent[] {
    return [...this.pending];
  }

  /**
   * Totals of everything this ledger has recorded, flushed or not. Cost is
   * what the checkpoint persists to `usage_events` (unbilled events count at
   * 0, as usage-event-store.ts writes them), so an activity that reports these
   * totals reports the same spend `usage_attribution` will show.
   */
  totals(): {
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  } {
    return { ...this.lifetime };
  }

  /**
   * Take the currently buffered events for a checkpoint write. Nothing is
   * dropped until `commit()`, so a failed write retries the same ids.
   */
  checkpoint(): PipelineUsageBatch {
    return this.take(() => true);
  }

  /**
   * Take the buffered page read charges (OCR and Rich) of one document, so a
   * caller can persist them in the same transaction as the page billing
   * decision they back (db/page-base-fee.ts recordMaterializedPageFee). Like
   * `checkpoint`, nothing is dropped until `commit()`.
   */
  takeRichPageCharges(documentId: string, includePage: (pageNumber: number) => boolean = () => true): PipelineUsageBatch {
    return this.take((event) => (PAGE_READ_METRICS as readonly string[]).includes(event.metric ?? "")
      && isUnitChargeEvent(event) && event.metadata?.documentId === documentId
      && includePage(Number(event.metadata?.pageNumber)));
  }

  private take(include: (event: UsageEvent) => boolean): PipelineUsageBatch {
    const events = this.pending.filter(include);
    let committed = false;
    return {
      events,
      commit: () => {
        if (committed) return;
        committed = true;
        const taken = new Set(events);
        const remaining = this.pending.filter((event) => !taken.has(event));
        this.pending.splice(0, this.pending.length, ...remaining);
        this.pendingBillable = remaining.reduce((sum, event) => sum + billableCents(event), 0);
      },
    };
  }

  private buffer(event: UsageEvent): UsageEvent {
    const priced = applySpeedBoostUnitCharge(
      (event.inputTokens ?? 0) > 0 || (event.outputTokens ?? 0) > 0 ? priceAiUsageEvent(event) : event,
      this.speedBoost,
    );
    const stamped = { ...priced, id: event.id ?? randomUUID(), metadata: { ...usageTraceContext(), ...priced.metadata } };
    recordUsageReceipt(stamped);
    this.pending.push(stamped);
    this.pendingBillable += billableCents(stamped);
    this.lifetime.inputTokens += stamped.inputTokens ?? 0;
    this.lifetime.outputTokens += stamped.outputTokens ?? 0;
    this.lifetime.costCents += billableCents(stamped);
    return stamped;
  }
}

/**
 * What the checkpoint persists as cost_cents for an event (usage-event-store.ts),
 * floored at 0: only price-card unit charges bill customers.
 */
export function billableCents(event: UsageEvent): number {
  return isUnitChargeEvent(event) && event.metadata?.billable !== false ? Math.max(0, Number(event.costCents) || 0) : 0;
}

function pageOf(metadata: Record<string, unknown> | null | undefined): { documentId: string; pageNumber: number } | null {
  const documentId = metadata?.documentId;
  const pageNumber = metadata?.pageNumber;
  if (typeof documentId !== "string" || typeof pageNumber !== "number" || !Number.isInteger(pageNumber)) return null;
  return { documentId, pageNumber };
}

function pagesOf(keys: Iterable<string>, documentId: string): Set<number> {
  const pages = new Set<number>();
  for (const key of keys) {
    const split = key.lastIndexOf(":");
    if (key.slice(0, split) === documentId) pages.add(Number(key.slice(split + 1)));
  }
  return pages;
}

function hasUsageToPersist(event: UsageEvent): boolean {
  return (event.inputTokens ?? 0) > 0
    || (event.outputTokens ?? 0) > 0
    || event.amount > 0
    || event.costCents > 0;
}
