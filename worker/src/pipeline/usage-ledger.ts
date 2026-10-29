import { recordUsageReceipt, usageTraceContext } from "@docslurp/shared/observability";
import { randomUUID } from "node:crypto";
import {
  BILLABLE_UNIT_METRICS,
  UNIT_CHARGE_PROVIDER,
  isUnitChargeEvent,
  pageCredits,
  priceAiUsageEvent,
  richPagesForOutputTokens,
  unitChargeMetadata,
} from "@docslurp/shared";

import type { UsageEvent } from "../models.js";
import {
  buildWorkerAiUsageEvent,
  hasWorkerAiUsage,
  logWorkerAiUsage,
  type WorkerAiUsageInput,
} from "../lib/ai-usage.js";

/**
 * Usage metrics that mean a vision or OCR model read one page (hosted vision,
 * local OCR, page mapping OCR, image labelling). Each such page bills as a Rich
 * page (PRICE_CARD), once per run, plus one more per extra 1,000 output tokens.
 * A Fast-mode page that falls back to vision is billed Rich the same way.
 */
export const RICH_PAGE_READ_METRICS: ReadonlySet<string> = new Set([
  "page-analysis",
  "document-map-ocr",
  "ocr-native-pdf",
  "image-label",
]);

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
 * page read by a vision/OCR model adds an `ingest-page-rich` charge here
 * (deterministic id per run and page); Fast pages are charged when the run
 * completes (db/page-base-fee.ts) and media minutes by the media stage.
 */
export class PipelineUsageEventLedger {
  private readonly pending: UsageEvent[] = [];
  private readonly lifetime = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  private pendingBillable = 0;
  /** Rich pages charged by this ledger, by `documentId:pageNumber`. */
  private readonly richCharged = new Map<string, number>();

  /** Run being billed; set by WorkflowState. Rich page charges need it for their idempotent ids. */
  runId: string | null = null;

  /** Record an AI/embedding call: price it, log it, buffer it. */
  record(input: WorkerAiUsageInput): UsageEvent | null {
    const event = buildWorkerAiUsageEvent(input);
    this.chargeRichPageRead(event);
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
    this.chargeRichPageRead(event);
    if (!hasUsageToPersist(event)) {
      return null;
    }
    return this.buffer(event);
  }

  /** Pages of a document this ledger charged as Rich (so Fast charges skip them). */
  richPagesOf(documentId: string): Set<number> {
    const pages = new Set<number>();
    for (const key of this.richCharged.keys()) {
      const split = key.lastIndexOf(":");
      if (key.slice(0, split) === documentId) pages.add(Number(key.slice(split + 1)));
    }
    return pages;
  }

  /** Charge a page a model read as an image (page-image embedding) as a Rich page, once per run. */
  chargeRichPage(args: { documentId: string; pageNumber: number; readBy: string; model?: string; outputTokens?: number }): void {
    this.chargeRichPageRead({ metric: args.readBy, model: args.model, outputTokens: args.outputTokens ?? 0,
      metadata: { documentId: args.documentId, pageNumber: args.pageNumber } }, true);
  }

  /**
   * A vision/OCR read of a page: buffer one billable Rich page charge for it
   * (once per page per run; the id makes a retried checkpoint a no-op).
   */
  private chargeRichPageRead(event: { metric: string; model?: string; outputTokens?: number | null; metadata?: Record<string, unknown> | null }, force = false): void {
    if (!this.runId || (!force && !RICH_PAGE_READ_METRICS.has(event.metric))) return;
    const documentId = event.metadata?.documentId;
    const pageNumber = event.metadata?.pageNumber;
    if (typeof documentId !== "string" || typeof pageNumber !== "number" || !Number.isInteger(pageNumber)) return;
    const key = `${documentId}:${pageNumber}`;
    if (this.richCharged.has(key)) return;
    const outputTokens = Math.max(0, Number(event.outputTokens ?? 0) || 0);
    const pages = richPagesForOutputTokens(outputTokens);
    this.richCharged.set(key, pages);
    this.buffer({
      id: `rich:${this.runId}:${key}`,
      provider: UNIT_CHARGE_PROVIDER,
      model: "price-card",
      metric: BILLABLE_UNIT_METRICS.richPage,
      amount: pages,
      unit: "page",
      costCents: pageCredits("rich", pages),
      inputTokens: 0,
      outputTokens: 0,
      metadata: unitChargeMetadata({ documentId, pageNumber, readBy: event.metric, model: event.model, outputTokens }),
    });
  }

  /** Number of events buffered since the last committed checkpoint. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Billable cost (credits) of the events buffered since the last committed
   * checkpoint, kept as a running sum so cost-cap checks stay O(1). Together
   * with `workspace_runs.spent_cents` (the committed part) it is the run's
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
   * Take the buffered Rich page charges of one document, so a caller can
   * persist them in the same transaction as the page billing decision they
   * back (db/page-base-fee.ts recordMaterializedPageFee). Like `checkpoint`,
   * nothing is dropped until `commit()`.
   */
  takeRichPageCharges(documentId: string): PipelineUsageBatch {
    return this.take((event) => event.metric === BILLABLE_UNIT_METRICS.richPage
      && isUnitChargeEvent(event) && event.metadata?.documentId === documentId);
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
    const priced = (event.inputTokens ?? 0) > 0 || (event.outputTokens ?? 0) > 0 ? priceAiUsageEvent(event) : event;
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

function hasUsageToPersist(event: UsageEvent): boolean {
  return (event.inputTokens ?? 0) > 0
    || (event.outputTokens ?? 0) > 0
    || event.amount > 0
    || event.costCents > 0;
}
