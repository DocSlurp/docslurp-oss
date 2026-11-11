/**
 * Chart & diagram export charges: one billable unit event (`BILLABLE_UNIT_METRICS.chartExport`) per visual the
 * generator model read, that is per candidate for which the provider answered at least one generator call, priced by
 * the pricing provider (`visualExportCredits`) by the formats requested when the call was made (at least one call's
 * worth). Estimates use the same unit: candidates a model reads (deterministic ones are free).
 *
 * - Charged on calls answered, whatever the outcome: exported from the model's answer, fell back to a deterministic
 *   spec (security M3), answered `none`, invalid after the repair, or read as a diagram while the project exports no
 *   diagrams (council round 2, N1). A candidate exported from a free deterministic spec with no model call is free.
 * - A call that threw before the provider answered (`responded: false`) is not a paid call.
 * - Charged as soon as a candidate's model work completes (the session calls back), so the run's cost cap and credit
 *   lease see the spend while the document is still exporting; the stage sweeps anything left in `finally`.
 * - Idempotent: the event id is `chart-export:<run>:<document>:<visual>`, and one artifact-ledger slot per document
 *   (`chart-export-charges:<document>`, a JSON map of charged visual ids) remembers what was charged, so a retried
 *   document stage or a replayed checkpoint never charges a visual twice. The slot does not start with `<document>:`,
 *   so a partial reprocess does not seed it and a new run charges its own reads.
 * - Provider token cost is recorded separately by the generator (`metric: chart-export`, billed 0 credits).
 */
import {
  BILLABLE_UNIT_METRICS,
  chartExportModelCallsPerVisual,
  UNIT_CHARGE_PROVIDER,
  unitChargeMetadata,
  visualExportCredits,
  type ChartExportConfig,
  type ChartExportFormat,
  type VisualExportModes,
} from "@docslurp/shared";

import type { UsageEvent } from "../models.js";
import { isCostCapExceeded } from "../pipeline/checkpoints.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { formatsFor } from "./config.js";
import type { ChartExportCallRecord, VisualKind } from "./types.js";

/** A candidate that went through the model rungs (exported or not). */
export interface ChartExportAttempt {
  id: string;
  pageNumber: number;
  /**
   * The candidate's kind when the generator was called (null: unknown, priced with every requested format). The read
   * is priced by the formats requested for that call, never by the kind the model answered.
   */
  kind: VisualKind | null;
  exported: boolean;
}

export interface ChartExportCharge {
  visualId: string;
  pageNumber: number;
  credits: number;
  /** Generator calls the provider answered for this visual. */
  paidCalls: number;
  exported: boolean;
}

/**
 * The formats a read is priced with: those requested for the candidate's kind when the call was made, with a floor of
 * one generator call, so every answered read is charged at least one unit (a kind with no requested format, such as a
 * diagram on a project that asks only for chart data formats, is priced as one call).
 */
export function chargedFormats(
  config: Pick<ChartExportConfig, "formats">,
  kind: VisualKind | null,
  modes?: VisualExportModes,
): ChartExportFormat[] {
  const requested = formatsFor({ formats: config.formats } as ChartExportConfig, kind);
  return chartExportModelCallsPerVisual(requested, modes) > 0 ? requested : [ONE_CALL_FORMAT];
}

/** A format generated from the shared spec (one call): the floor price of an answered read. */
const ONE_CALL_FORMAT: ChartExportFormat = "description";

/** Pure: the charge owed for each attempted candidate with at least one answered generator call. */
export function chartExportCharges(args: {
  attempts: readonly ChartExportAttempt[];
  calls: readonly Pick<ChartExportCallRecord, "visualId" | "responded">[];
  config: Pick<ChartExportConfig, "formats">;
  modes?: VisualExportModes;
}): ChartExportCharge[] {
  const paid = new Map<string, number>();
  for (const call of args.calls) {
    if (call.responded) paid.set(call.visualId, (paid.get(call.visualId) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const out: ChartExportCharge[] = [];
  for (const attempt of args.attempts) {
    const paidCalls = paid.get(attempt.id) ?? 0;
    if (paidCalls === 0 || seen.has(attempt.id)) continue;
    seen.add(attempt.id);
    const credits = visualExportCredits({
      visuals: 1,
      source: "vision",
      formats: chargedFormats(args.config, attempt.kind, args.modes),
      ...(args.modes ? { modes: args.modes } : {}),
    });
    out.push({ visualId: attempt.id, pageNumber: attempt.pageNumber, credits, paidCalls, exported: attempt.exported });
  }
  return out;
}

/** The document's charge slot: one per document, holding `{ <visualId>: credits }`. */
export const chartExportChargeSlot = (documentId: string) => `chart-export-charges:${documentId}`;

function chargedVisuals(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

/**
 * Enqueue the unit charges owed for one document's attempted candidates. Safe to call any number of times (after each
 * candidate and again at the end of the document): already charged visuals are skipped. Returns the credits newly
 * enqueued.
 */
export function chargeChartExports(
  state: Pick<WorkflowState, "run" | "usageLedger" | "artifactLedger">,
  args: {
    documentId: string;
    attempts: readonly ChartExportAttempt[];
    calls: readonly Pick<ChartExportCallRecord, "visualId" | "responded">[];
    config: Pick<ChartExportConfig, "formats">;
    modes?: VisualExportModes;
  },
): number {
  const slot = chartExportChargeSlot(args.documentId);
  const charged = chargedVisuals(state.artifactLedger.read(slot));
  let total = 0;
  let added = false;
  for (const charge of chartExportCharges(args)) {
    if (Object.hasOwn(charged, charge.visualId)) continue;
    const event: UsageEvent = {
      id: `chart-export:${state.run.id}:${args.documentId}:${charge.visualId}`,
      provider: UNIT_CHARGE_PROVIDER,
      model: "price-card",
      metric: BILLABLE_UNIT_METRICS.chartExport,
      amount: 1,
      unit: "visual",
      costCents: charge.credits,
      inputTokens: 0,
      outputTokens: 0,
      metadata: unitChargeMetadata({
        documentId: args.documentId, pageNumber: charge.pageNumber, visualId: charge.visualId, paidCalls: charge.paidCalls,
        outcome: charge.exported ? "exported" : "not-exported",
      }),
    };
    state.usageLedger.enqueue(event);
    charged[charge.visualId] = charge.credits;
    added = true;
    total += charge.credits;
  }
  if (added) state.artifactLedger.record(slot, JSON.stringify(charged));
  return total;
}

/**
 * The worker's pre-spend check for a generator call: false once the run's cost cap is reached or the run's credit
 * lease would be exhausted (the worker's counterpart of the server's `assertCanSpend`). Pass it as the session's
 * `canCallModel`; the generator checks it before every call, the first one of a document included.
 */
export function chartExportCanSpend(state: WorkflowState): boolean {
  if (isCostCapExceeded(state)) return false;
  return !(state.store?.creditLeaseWouldExhaust?.(state) ?? false);
}
