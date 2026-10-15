import { randomUUID } from "node:crypto";
import { priceAiUsageEvent } from "@docslurp/shared";

import type { UsageEvent } from "../models.js";
import {
  buildWorkerAiUsageEvent,
  hasWorkerAiUsage,
  logWorkerAiUsage,
  type WorkerAiUsageInput,
} from "../lib/ai-usage.js";

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
 */
export class PipelineUsageEventLedger {
  private readonly pending: UsageEvent[] = [];
  private readonly lifetime = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  private pendingBillable = 0;

  /** Plan of the org being billed; bonus plans pay the plan-neutral AI credit factor. */
  planId: string | null = null;

  /** Record an AI/embedding call: price it, log it, buffer it. */
  record(input: WorkerAiUsageInput): UsageEvent | null {
    const event = buildWorkerAiUsageEvent(input);
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
    if (!hasUsageToPersist(event)) {
      return null;
    }
    return this.buffer(event);
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
    const events = this.pending.slice();
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
    const priced = (event.inputTokens ?? 0) > 0 || (event.outputTokens ?? 0) > 0 ? priceAiUsageEvent(event, { planId: this.planId }) : event;
    const stamped = { ...priced, id: event.id ?? randomUUID() };
    this.pending.push(stamped);
    this.pendingBillable += billableCents(stamped);
    this.lifetime.inputTokens += stamped.inputTokens ?? 0;
    this.lifetime.outputTokens += stamped.outputTokens ?? 0;
    this.lifetime.costCents += stamped.metadata?.billable === false ? 0 : stamped.costCents;
    return stamped;
  }
}

/** What the checkpoint persists as cost_cents for an event (usage-event-store.ts), floored at 0. */
function billableCents(event: UsageEvent): number {
  return event.metadata?.billable === false ? 0 : Math.max(0, Number(event.costCents) || 0);
}

function hasUsageToPersist(event: UsageEvent): boolean {
  return (event.inputTokens ?? 0) > 0
    || (event.outputTokens ?? 0) > 0
    || event.amount > 0
    || event.costCents > 0;
}
