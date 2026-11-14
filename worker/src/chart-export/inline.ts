import { chartExportInlineEnabled as sharedChartExportInlineEnabled } from "@docslurp/shared";
import { chartExportActive, chartExportModelsActive } from "./config.js";
import { extractDeterministicVisuals as guestExtract } from "./extractors/index.js";
import { validateDeterministicResult } from "./extractors/host.js";
import type { DeterministicVisualResult as GuestResult } from "./extractors/types.js";
import { INLINE_CHART_KINDS, INLINE_CHART_LIMITS, INLINE_REFUSE_REASONS, INLINE_SKIP_REASONS, inlineChartPlan, type InlineChartKind, type InlineInspectionView } from "./inline-guest.js";

/*
 * Inline chart extraction, host half (`DOCSLURP_CHART_EXPORT_INLINE=1`). The free chart rungs ride in the quarantine
 * inspection command every document already runs in the parser VM (inline-guest.ts, scripts/chart-inline.mjs). The host
 * asks for it with the kind the document was declared as, validates the guest's answer field by field (the same
 * validator as the standalone guest), keeps it on the quarantine artifact of an accepted document only, and
 * vision-extract reads it from there: no parser VM run of its own for the document's source.
 */

/** Document artifact slot recorded by quarantine when the inline answer has work (points at the quarantine artifact). */
export const CHART_INLINE_SLOT = "chart-inline";

/** The slot's value: the quarantine artifact's URI plus whether the inline answer has work. */
export function chartInlineSlotValue(artifactUri: string, work: boolean): string {
  return `${artifactUri}#chart-inline=${work ? "work" : "none"}`;
}

/** Whether a recorded slot value says the free pass has work. */
export function chartInlineSlotHasWork(value: string | undefined): boolean {
  return typeof value === "string" && value.endsWith("#chart-inline=work");
}

export function chartExportInlineEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return sharedChartExportInlineEnabled(env);
}

/**
 * Free tier in inline mode: chart export active without model reads, and inline extraction on. Then a document the
 * free rungs cannot export from does no chart work at all; render-images records its free candidate stats, as with
 * export off.
 */
export function freeInlineMode(pipeline: unknown, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return chartExportInlineEnabled(env) && chartExportActive(pipeline, env) && !chartExportModelsActive(pipeline, env);
}

export interface InlineChartRequest { kind: InlineChartKind; diagrams: boolean }

export type InlineCharts =
  | { status: "ok"; ms: number; result: GuestResult }
  | { status: "skipped"; reason: (typeof INLINE_SKIP_REASONS)[number] }
  | { status: "refused"; reason: (typeof INLINE_REFUSE_REASONS)[number]; ms: number };

/** What the quarantine artifact keeps: the answer plus the kind it was asked for. */
export type StoredInlineCharts = InlineCharts & { kind: InlineChartKind };

const MAX_MS = 600_000;
const validMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_MS;
const keys = (o: object) => Object.keys(o).sort().join(",");

/**
 * The guest's `charts` answer, or a refusal when it is malformed. Never throws: a bad chart answer must not fail the
 * inspection it rode in on.
 */
export function validateInlineCharts(raw: unknown): InlineCharts {
  const invalid: InlineCharts = { status: "refused", reason: "result-invalid", ms: 0 };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid;
  const o = raw as Record<string, unknown>;
  if (o.status === "skipped") {
    return keys(o) === "reason,status" && (INLINE_SKIP_REASONS as readonly unknown[]).includes(o.reason) ? { status: "skipped", reason: o.reason as (typeof INLINE_SKIP_REASONS)[number] } : invalid;
  }
  if (o.status === "refused") {
    return keys(o) === "ms,reason,status" && (INLINE_REFUSE_REASONS as readonly unknown[]).includes(o.reason) && validMs(o.ms)
      ? { status: "refused", reason: o.reason as (typeof INLINE_REFUSE_REASONS)[number], ms: o.ms } : invalid;
  }
  if (o.status === "ok" && keys(o) === "ms,result,status" && validMs(o.ms)) {
    try {
      return { status: "ok", ms: o.ms, result: validateDeterministicResult(o.result) };
    } catch {
      return invalid;
    }
  }
  return invalid;
}

/** A stored answer read back from the quarantine artifact (validated again: storage is not trusted either). */
export function readStoredInlineCharts(raw: unknown): StoredInlineCharts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { kind, ...rest } = raw as Record<string, unknown>;
  if (!(INLINE_CHART_KINDS as readonly unknown[]).includes(kind)) return null;
  // A malformed stored answer reads as `refused result-invalid`: no export and no standalone retry (fail closed).
  return { ...validateInlineCharts(rest), kind: kind as InlineChartKind };
}

/** Whether the standalone VM run should still try the source: only when the inline answer was too big to carry. */
/**
 * Refusals the standalone guest (#363's path) takes over: an answer too big to carry inline, and an answer the image did
 * not give at all (answer-missing: a parser image older than the inline guest, council r4 M3). Every other refusal is
 * recorded as a loss (vm-extractor).
 */
export function inlineNeedsStandalone(charts: InlineCharts): boolean {
  return charts.status === "refused" && (charts.reason === "result-too-large" || charts.reason === "answer-missing");
}

/**
 * Whether the inline answer gives the free tier anything to export, retry or record (council #369/#510 r4 M2): visuals,
 * counted losses (deferrals, an overflow count), or a refusal (recorded as a deferral by vm-extractor, L4). Only a clean
 * answer with nothing in it, or a skip, is no work.
 */
export function inlineHasWork(charts: InlineCharts | null): boolean {
  if (!charts) return false;
  if (charts.status === "refused") return true;
  if (charts.status !== "ok") return false;
  return charts.result.visuals.length > 0 || (charts.result.deferred?.length ?? 0) > 0 || (charts.result.overflow ?? 0) > 0;
}

/**
 * The same plan and extractor in process, for local development and tests (production runs the guest in the VM; see
 * quarantine.ts `inspectQuarantine`). Synchronous: no deadline or heap limit applies here.
 */
export function inlineChartsInProcess(bytes: Buffer, request: InlineChartRequest, inspection: InlineInspectionView): InlineCharts {
  let text: string | undefined;
  const plan = inlineChartPlan(request.kind, inspection, bytes.length, () => (text ??= bytes.toString("utf8")));
  if (!plan.run) return { status: "skipped", reason: plan.reason };
  const started = performance.now();
  const input = plan.packaged
    ? { kind: request.kind as "office" | "epub", bytes }
    : { kind: request.kind as "svg" | "html" | "json", text: text ?? bytes.toString("utf8") };
  const result = validateDeterministicResult(guestExtract(input, { diagrams: request.diagrams, outputBudget: INLINE_CHART_LIMITS.outputBudget }));
  return { status: "ok", ms: Math.round(performance.now() - started), result };
}
