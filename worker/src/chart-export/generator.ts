/**
 * The chart-export ladder for one visual: deterministic spec -> image + geometry digest (`svg-assisted`) -> image only
 * (`vision`). Derived formats come from one spec call rendered by code; direct formats get one call each. Every model
 * call is recorded through `recordUsage` with its actual tokens; provider errors go to logs only.
 */
import {
  visionListPriceCents,
  visualRenderIssue,
  visualSpecSchema,
  type ChartExportConfig,
  type ChartExportFormat,
  type ChartSpec,
  type ExportedVisual,
  type VisualSource,
  type VisualSpec,
} from "@docslurp/shared";

import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import {
  CHART_EXPORT_LIMITS,
  DETERMINISTIC_ASSISTED_MIN_CONFIDENCE,
  DETERMINISTIC_HIGH_CONFIDENCE,
  DETERMINISTIC_STANDALONE_MIN_CONFIDENCE,
  FORMAT_MODE,
  MODEL_CONFIDENCE,
  answerHitOutputCap,
  formatsFor,
  repairOutputTokenCap,
} from "./config.js";
import { assistedSpecPrompt, directPrompt, repairPrompt, specPrompt } from "./prompts.js";
import { renderVisual } from "./render-adapter.js";
import { sanitizeFormatOutput, unfence } from "./sanitize.js";
import type {
  ChartExportCallRecord,
  ChartModelClient,
  ChartModelPurpose,
  ChartModelResponse,
  DeterministicVisualPartial,
  ExportVisualResult,
  VisualCandidate,
  VisualImage,
  VisualKind,
} from "./types.js";

/** Usage metric for every generator call (not a Rich page read: export is billed per visual, S5). */
export const CHART_EXPORT_USAGE_METRIC = "chart-export";

export interface ExportVisualArgs {
  candidate: VisualCandidate;
  image: VisualImage | null;
  deterministic: DeterministicVisualPartial | null;
  config: ChartExportConfig;
  /** Admitted generator model, or null when none is admitted (model rungs are then skipped). */
  generatorModelUri: string | null;
  client: ChartModelClient | null;
  /** Persists one call's usage (production: `state.usageLedger.record`). */
  recordUsage: (input: WorkerAiUsageInput) => void;
  documentId: string;
  /** False when a cost cap or privacy gate forbids further model calls. */
  canCallModel?: () => boolean;
  modes?: Record<ChartExportFormat, "derived" | "direct">;
  signal?: AbortSignal;
}

/**
 * Provider cost of one answer in cents. A route that reports 0 (a BYOK OpenRouter route reports no router charge) is
 * priced from the model's list token prices instead, so usage rows never record a paid call as free.
 */
export function chartCallCostCents(response: Pick<ChartModelResponse, "model" | "inputTokens" | "outputTokens" | "costCents">, modelUri: string | null = null): number {
  const reported = Number.isFinite(response.costCents) ? Math.max(0, response.costCents) : 0;
  if (reported > 0) return reported;
  const tokens = { inputTokens: Math.max(0, response.inputTokens || 0), outputTokens: Math.max(0, response.outputTokens || 0) };
  if (tokens.inputTokens + tokens.outputTokens === 0) return 0;
  return visionListPriceCents(response.model, tokens) ?? (modelUri ? visionListPriceCents(modelUri, tokens) : null) ?? 0;
}

export function buildChartExportUsage(
  response: ChartModelResponse,
  context: { documentId: string; candidate: VisualCandidate; source: VisualSource; purpose: ChartModelPurpose; format: ChartExportFormat | null; ok: boolean; modelUri?: string | null },
): WorkerAiUsageInput {
  return {
    provider: response.provider,
    model: response.model,
    metric: CHART_EXPORT_USAGE_METRIC,
    amount: 1,
    unit: "request",
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costCents: chartCallCostCents(response, context.modelUri ?? null),
    metadata: {
      stage: "vision-extract",
      documentId: context.documentId,
      pageNumber: context.candidate.pageNumber,
      imageIndex: context.candidate.imageIndex,
      visualId: context.candidate.id,
      source: context.source,
      purpose: context.purpose,
      format: context.format,
      outcome: context.ok ? "completed" : "invalid-output",
      latencyMs: response.latencyMs,
      ...(response.finishReason ? { finishReason: response.finishReason } : {}),
      ...(response.cachedInputTokens ? { cachedInputTokens: response.cachedInputTokens } : {}),
      ...(response.cacheWriteInputTokens ? { cacheWriteInputTokens: response.cacheWriteInputTokens } : {}),
    },
  };
}

/** Parses a spec answer: a JSON object (fenced or not), validated against the contract's limits. */
export function parseSpecAnswer(text: string): { spec: VisualSpec } | { none: true } | { error: string; summary: string | null } {
  const body = unfence(text);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "no JSON object in the answer", summary: null };
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { error: "the answer is not valid JSON", summary: null };
  }
  if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "none") return { none: true };
  const parsed = visualSpecSchema.safeParse(raw);
  if (parsed.success) return { spec: parsed.data };
  const summary = raw && typeof raw === "object" && typeof (raw as { summary?: unknown }).summary === "string"
    ? ((raw as { summary: string }).summary.trim() || null)
    : null;
  // Our own schema text (field paths and messages), never provider error text.
  const issue = parsed.error.issues[0];
  return { error: `${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}`.slice(0, 300), summary };
}

/**
 * `svg-assisted`: numbers come from geometry. Where the model's series line up with the deterministic spec (same
 * series count and point count), the measured y values replace the model's readings.
 */
export function fixNumbersFromGeometry(model: VisualSpec, measured: VisualSpec | null): VisualSpec {
  if (!measured || model.kind !== "chart" || measured.kind !== "chart") return model;
  if (model.series.length !== measured.series.length) return model;
  const series = model.series.map((s, i) => {
    const m = measured.series[i]!;
    if (m.points.length !== s.points.length) return s;
    return { ...s, points: s.points.map((p, j) => ({ ...p, y: m.points[j]!.y })) };
  });
  return { ...model, series } satisfies ChartSpec;
}

function bboxTuple(candidate: VisualCandidate): [number, number, number, number] | null {
  const b = candidate.bbox;
  return b ? [b.x, b.y, b.width, b.height] : null;
}

/** Derived outputs from a spec, sanitized like model output (renderers are code, but labels came from the file/model). */
function renderDerived(spec: VisualSpec, formats: ChartExportFormat[]): { outputs: Partial<Record<ChartExportFormat, string>>; skipped: ExportedVisual["skipped"] } {
  const outputs: Partial<Record<ChartExportFormat, string>> = {};
  const skipped: ExportedVisual["skipped"] = [];
  for (const format of formats) {
    let rendered: string | null;
    try {
      rendered = renderVisual(spec, format);
    } catch (error) {
      console.warn(`[chart-export] render failed format=${format} error=${error instanceof Error ? error.message : String(error)}`);
      skipped.push({ format, reason: "render-failed" });
      continue;
    }
    if (rendered === null) {
      // A specific reason when the data cannot be shown faithfully (negative pie share, log axis with zero, ...).
      skipped.push({ format, reason: visualRenderIssue(spec, format) ?? "not-applicable" });
      continue;
    }
    const clean = sanitizeFormatOutput(format, rendered);
    if (clean.ok) outputs[format] = clean.text;
    else skipped.push({ format, reason: `render-${clean.reason}`.slice(0, 120) });
  }
  return { outputs, skipped };
}

function finish(
  args: ExportVisualArgs,
  kind: VisualKind,
  source: VisualSource,
  confidence: number,
  spec: VisualSpec | null,
  outputs: Partial<Record<ChartExportFormat, string>>,
  skipped: ExportedVisual["skipped"],
  model: string | null,
): ExportedVisual {
  return {
    id: args.candidate.id,
    pageNumber: args.candidate.unpaged ? null : args.candidate.pageNumber,
    imageIndex: args.candidate.imageIndex,
    bbox: bboxTuple(args.candidate),
    kind,
    source,
    confidence: Math.max(0, Math.min(1, confidence)),
    spec,
    outputs,
    model,
    skipped,
  };
}

function validDeterministic(partial: DeterministicVisualPartial | null): { partial: DeterministicVisualPartial; spec: VisualSpec | null } | null {
  if (!partial || !Number.isFinite(partial.confidence)) return null;
  // Guest output is untrusted: the spec is validated again here, and an invalid one is dropped (the digest may remain).
  const parsed = partial.spec ? visualSpecSchema.safeParse(partial.spec) : null;
  return { partial, spec: parsed?.success ? parsed.data : null };
}

export async function exportVisual(args: ExportVisualArgs): Promise<ExportVisualResult> {
  const calls: ChartExportCallRecord[] = [];
  const det = validDeterministic(args.deterministic);
  const modes = args.modes ?? FORMAT_MODE;

  // Rung 1: deterministic spec, confident enough to use as is.
  if (det?.spec && det.partial.confidence >= DETERMINISTIC_HIGH_CONFIDENCE) {
    const kind = det.spec.kind;
    const { outputs, skipped } = renderDerived(det.spec, formatsFor(args.config, kind));
    return { visual: finish(args, kind, det.partial.source, det.partial.confidence, det.spec, outputs, skipped, null), calls };
  }

  const canModel = !!(args.image && args.client && args.generatorModelUri) && (args.canCallModel?.() ?? true);
  if (!canModel) {
    // No image or no admitted model: a middling deterministic spec is still better than nothing.
    if (det?.spec && det.partial.confidence >= DETERMINISTIC_STANDALONE_MIN_CONFIDENCE) {
      const kind = det.spec.kind;
      const { outputs, skipped } = renderDerived(det.spec, formatsFor(args.config, kind));
      return { visual: finish(args, kind, det.partial.source, det.partial.confidence, det.spec, outputs, skipped, null), calls };
    }
    return { visual: null, calls };
  }

  const image = args.image!;
  const client = args.client!;
  const modelUri = args.generatorModelUri!;
  const digest = det?.partial.digest && det.partial.confidence >= DETERMINISTIC_ASSISTED_MIN_CONFIDENCE
    ? det.partial.digest.slice(0, CHART_EXPORT_LIMITS.maxDigestChars)
    : null;
  const source: VisualSource = digest ? "svg-assisted" : "vision";
  let kind: VisualKind | null = args.candidate.kind ?? det?.partial.kind ?? null;
  let servedModel: string | null = null;

  const call = async (
    purpose: ChartModelPurpose,
    prompt: string,
    format: ChartExportFormat | null,
    maxOutputTokens: number = CHART_EXPORT_LIMITS.maxOutputTokensPerCall,
  ): Promise<ChartModelResponse | null> => {
    if (args.canCallModel && !args.canCallModel()) return null;
    try {
      const response = await client.complete({
        modelUri, prompt, image, pageNumber: args.candidate.pageNumber, purpose, maxOutputTokens, ...(format ? { format } : {}), ...(args.signal ? { signal: args.signal } : {}),
      });
      servedModel = response.model;
      calls.push({
        visualId: args.candidate.id, responded: true, purpose, format, model: response.model,
        inputTokens: response.inputTokens, outputTokens: response.outputTokens, costCents: chartCallCostCents(response, modelUri), latencyMs: response.latencyMs, ok: true,
      });
      return response;
    } catch (error) {
      // Raw provider text stays in logs; the visual only records a machine reason.
      console.warn(`[chart-export] model call failed document=${args.documentId} visual=${args.candidate.id} purpose=${purpose} model=${modelUri} error=${error instanceof Error ? error.message : String(error)}`);
      calls.push({ visualId: args.candidate.id, responded: false, purpose, format, model: modelUri, inputTokens: 0, outputTokens: 0, costCents: 0, latencyMs: 0, ok: false });
      return null;
    }
  };
  const record = (response: ChartModelResponse, purpose: ChartModelPurpose, format: ChartExportFormat | null, ok: boolean) => {
    args.recordUsage(buildChartExportUsage(response, { documentId: args.documentId, candidate: args.candidate, source, purpose, format, ok, modelUri }));
    if (!ok) calls[calls.length - 1]!.ok = false;
  };

  const requested = formatsFor(args.config, kind);
  const derivedFormats = requested.filter((f) => modes[f] === "derived");
  const directFormats = requested.filter((f) => modes[f] === "direct");
  const outputs: Partial<Record<ChartExportFormat, string>> = {};
  const skipped: ExportedVisual["skipped"] = [];
  let spec: VisualSpec | null = null;
  let confidence = source === "svg-assisted" ? MODEL_CONFIDENCE["svg-assisted"] : MODEL_CONFIDENCE.vision;

  // Rungs 2/3, derived: one spec call (+ one bounded second call), rendered to every derived format. The second call is
  // either one retry at a larger output cap when the spec was cut off at its cap, or one repair of an invalid spec, never
  // both: a read makes at most two derived calls, each under its own output cap (CHART_EXPORT_LIMITS).
  if (derivedFormats.length > 0 || (directFormats.length > 0 && kind === null)) {
    // A project without diagrams asks for charts only, so a diagram is answered `none` instead of a full spec.
    const promptOptions = { chartsOnly: !args.config.diagrams };
    const prompt = digest ? assistedSpecPrompt(kind, digest, promptOptions) : specPrompt(kind, promptOptions);
    const first = await call("spec", prompt, null);
    let parsed = first ? parseSpecAnswer(first.text) : null;
    if (first) record(first, "spec", null, !!parsed && !("error" in parsed));
    if (parsed && "none" in parsed) return { visual: null, calls };
    let summary: string | null = parsed && "error" in parsed ? parsed.summary : null;
    if (first && parsed && "error" in parsed && answerHitOutputCap(first, CHART_EXPORT_LIMITS.maxOutputTokensPerCall)) {
      // Cut off at the cap: a repair would echo a truncated answer and be cut off the same way. One retry of the spec
      // at the larger cap instead, and no further call.
      const expanded = await call("expand", prompt, null, CHART_EXPORT_LIMITS.maxExpandedOutputTokens);
      parsed = expanded ? parseSpecAnswer(expanded.text) : parsed;
      if (expanded) record(expanded, "expand", null, !("error" in parsed));
      if ("none" in parsed) return { visual: null, calls };
      if ("error" in parsed) summary = parsed.summary ?? summary;
    } else if (first && parsed && "error" in parsed) {
      const repaired = await call("repair", repairPrompt(kind, first.text, parsed.error, promptOptions), null, repairOutputTokenCap(first.outputTokens));
      parsed = repaired ? parseSpecAnswer(repaired.text) : parsed;
      if (repaired) record(repaired, "repair", null, !("error" in parsed));
      if ("none" in parsed) return { visual: null, calls };
      if ("error" in parsed) summary = parsed.summary ?? summary;
      else confidence *= MODEL_CONFIDENCE.repairPenalty;
    }
    if (parsed && "spec" in parsed) {
      spec = source === "svg-assisted" ? fixNumbersFromGeometry(parsed.spec, det?.spec ?? null) : parsed.spec;
      kind = spec.kind;
      const rendered = renderDerived(spec, formatsFor(args.config, kind).filter((f) => modes[f] === "derived"));
      Object.assign(outputs, rendered.outputs);
      skipped.push(...rendered.skipped);
    } else {
      // Fallback: description only (the summary the model did return, if any); other derived formats are skipped.
      for (const format of derivedFormats) {
        if (format === "description" && summary) {
          const clean = sanitizeFormatOutput("description", summary);
          if (clean.ok) {
            outputs.description = clean.text;
            continue;
          }
        }
        skipped.push({ format, reason: first ? "invalid-spec" : "generator-failed" });
      }
    }
  }

  // Direct formats: one call each, validated per format.
  for (const format of formatsFor(args.config, kind).filter((f) => modes[f] === "direct")) {
    const response = await call("direct", directPrompt(format, kind), format);
    if (!response) {
      skipped.push({ format, reason: "generator-failed" });
      continue;
    }
    const clean = sanitizeFormatOutput(format, response.text);
    record(response, "direct", format, clean.ok);
    if (clean.ok) outputs[format] = clean.text;
    else skipped.push({ format, reason: clean.reason.slice(0, 120) });
  }

  if (Object.keys(outputs).length === 0 && spec === null) {
    // Nothing usable came back. A middling deterministic spec still beats an empty visual.
    if (det?.spec && det.partial.confidence >= DETERMINISTIC_STANDALONE_MIN_CONFIDENCE) {
      const detKind = det.spec.kind;
      const rendered = renderDerived(det.spec, formatsFor(args.config, detKind));
      return { visual: finish(args, detKind, det.partial.source, det.partial.confidence, det.spec, rendered.outputs, rendered.skipped, null), calls };
    }
    // Nothing to show: the caller keeps its usual reading of the visual (and counts it as not exported).
    return { visual: null, calls };
  }
  return { visual: finish(args, kind ?? "chart", source, confidence, spec, outputs, skipped, servedModel ?? modelUri), calls };
}
