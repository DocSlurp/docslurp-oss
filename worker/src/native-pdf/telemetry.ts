import { emitTelemetryLog, setActiveSpanAttributes } from "@docslurp/shared/observability";

import { currentPerfContext } from "../lib/perf-context.js";
import type { PerformanceEvent } from "../models.js";
import type { NativePdfMode } from "./mode.js";

/**
 * Every decision about the private native-pdf engine is reported three ways, so none is silent:
 * a stdout line (Fly logs and the log shipper), an OTLP log record (SigNoz without the shipper)
 * and attributes on the active span (the per-document `worker.document.<stage>` span).
 */

type Severity = "info" | "warn" | "error";
type AttributeValue = string | number | boolean;

/** Raw error text is kept whole in structured attributes; this bound only stops runaway payloads. */
const MAX_REASON_CHARS = 4000;

/**
 * One physical line for stdout: control characters (newline, carriage return, escapes, U+2028/9) become spaces,
 * so text from a hostile file cannot forge a second log line or `key=value` pairs. Structured attributes keep
 * the raw text.
 */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ");
}

function definedAttributes(attributes: Record<string, AttributeValue | null | undefined>): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(attributes).filter((entry): entry is [string, AttributeValue] => entry[1] !== null && entry[1] !== undefined));
}

/** Telemetry never changes a document's or the process's outcome. */
function report(severity: Severity, eventName: string, line: string, attributes: Record<string, AttributeValue | null | undefined>): void {
  try {
    // Correlate with the run and document being processed, so a fallback can be joined to the file that caused it
    // even though documents run concurrently.
    const perf = currentPerfContext();
    const scoped = perf ? `run=${perf.runId}${perf.documentId ? ` document=${perf.documentId}` : ""} stage=${perf.stageName} ` : "";
    const safeLine = oneLine(scoped && !line.includes(`document=${perf?.documentId}`) ? line.replace(/^(\[[^\]]+\] )/, `$1${scoped}`) : line);
    attributes = {
      ...(perf ? { "docslurp.runId": perf.runId, "docslurp.documentId": perf.documentId, "docslurp.stageName": perf.stageName } : {}),
      ...attributes,
    };
    (severity === "error" ? console.error : severity === "warn" ? console.warn : console.log)(safeLine);
    emitTelemetryLog({ severityText: severity, eventName, body: safeLine.slice(0, 1000), attributes: definedAttributes(attributes) });
  } catch {
    /* best effort */
  }
}

/** Process-level engine load result, reported once when the loader settles. */
export function reportNativePdfEngineLoad(
  result: { ok: true; source: string; version: string; features: string[] } | { ok: false; reason: string },
  required: boolean,
): void {
  if (result.ok) {
    report("info", "docslurp.native_pdf.engine", `[native-pdf] engine loaded source=${result.source} version=${result.version} features=${result.features.join(",")}`, {
      "docslurp.native_pdf.status": "loaded",
      "docslurp.native_pdf.source": result.source,
      "docslurp.native_pdf.version": result.version,
      "docslurp.native_pdf.features": result.features.join(","),
    });
    return;
  }
  // An image that ships the engine (or a mode that needs it) must not lose it quietly.
  report(required ? "error" : "warn", "docslurp.native_pdf.engine", `[native-pdf] engine unavailable required=${required} reason=${result.reason}`, {
    "docslurp.native_pdf.status": "unavailable",
    "docslurp.native_pdf.required": required,
    "docslurp.native_pdf.reason": result.reason.slice(0, MAX_REASON_CHARS),
  });
}

/** One native-pdf fallback (extraction, OCR page, parser payload, raster). */
export function reportNativePdfFallback(args: {
  context: string;
  code: string;
  kind: string;
  next: string;
  reason: string;
  engineCode?: string;
  limit?: string;
}): void {
  const detail = [
    `code=${args.code}`,
    args.engineCode && args.engineCode !== args.code ? `engineCode=${args.engineCode}` : "",
    args.limit ? `limit=${args.limit}` : "",
    `kind=${args.kind}`,
    `next=${args.next}`,
  ].filter(Boolean).join(" ");
  report(args.kind === "unexpected" ? "warn" : "info", "docslurp.native_pdf.fallback",
    `[native-pdf] ${args.context} fell back ${detail} reason=${args.reason.split("\n")[0]!.slice(0, 200)}`, {
      "docslurp.native_pdf.context": args.context,
      "docslurp.native_pdf.code": args.code,
      "docslurp.native_pdf.kind": args.kind,
      "docslurp.native_pdf.next": args.next,
      "docslurp.native_pdf.engine_code": args.engineCode,
      "docslurp.native_pdf.limit": args.limit,
      "docslurp.native_pdf.reason": args.reason.slice(0, MAX_REASON_CHARS),
    });
}

export type NativePdfShadowStatus = "ran" | "failed" | "skipped" | "not-applicable";

/** Native-pdf participation for one document, persisted in the extract-markdown stage stats. */
export type NativePdfExtractionStatus = "served" | "failed" | "lost-vote" | "unavailable" | "not-planned";

export interface NativePdfStageStats {
  mode: NativePdfMode;
  /** `degraded`: the binding is missing and DOCSLURP_NATIVE_PDF_POPPLER serves the poppler text subset instead. */
  engine: "loaded" | "degraded" | "unavailable";
  engineSource: string | null;
  engineVersion: string | null;
  engineUnavailableReason: string | null;
  /** native-pdf as an extraction candidate (primary or voting), across every retry attempt of the stage. */
  extraction: { status: NativePdfExtractionStatus; code: string | null; reason: string | null };
  shadow: { status: NativePdfShadowStatus; reason: string | null; agreement: number | null; nativeMs: number | null };
  parserPayload: { status: "native" | "none"; reason: string | null };
}

/** Summarise the shadow comparison rows into the stage stats shape. */
export function summarizeNativePdfShadow(rows: PerformanceEvent[]): NativePdfStageStats["shadow"] {
  const documentRow = rows.find((row) => row.scope === "document") ?? rows[0];
  if (!documentRow) return { status: "failed", reason: "shadow returned no rows", agreement: null, nativeMs: null };
  const metadata = (documentRow.metadata ?? {}) as Record<string, unknown>;
  if (documentRow.unit === "error") {
    return { status: "failed", reason: `${String(metadata.code ?? "error")}: ${String(metadata.reason ?? "")}`.slice(0, MAX_REASON_CHARS), agreement: null, nativeMs: null };
  }
  return {
    status: "ran",
    reason: null,
    agreement: Number.isFinite(documentRow.value) ? Number(documentRow.value) : null,
    nativeMs: typeof metadata.nativeMs === "number" ? metadata.nativeMs : null,
  };
}

/** The per-document extraction decision: which extractor served it, what was tried and how native-pdf took part. */
export interface ExtractionDecision {
  documentId: string;
  format: string;
  extractor: string;
  strategy: string;
  extractorOrder: string[];
  attempted: string[];
  unavailable: string[];
  nativePdf: NativePdfStageStats | null;
}

export function reportExtractionDecision(decision: ExtractionDecision): void {
  try {
    reportExtractionDecisionUnsafe(decision);
  } catch {
    /* Telemetry never fails a document. */
  }
}

function reportExtractionDecisionUnsafe(decision: ExtractionDecision): void {
  const native = decision.nativePdf;
  // Native-pdf was expected (engine on, PDF) but did not serve or shadow the document: say so loudly.
  const nativeMissed = native !== null && native.mode !== "off" && native.shadow.status !== "ran"
    && native.extraction.status !== "served" && native.extraction.status !== "lost-vote";
  const attributes: Record<string, AttributeValue | null | undefined> = {
    "docslurp.extraction.document_id": decision.documentId,
    "docslurp.extraction.format": decision.format,
    "docslurp.extraction.extractor": decision.extractor,
    "docslurp.extraction.strategy": decision.strategy,
    "docslurp.extraction.order": decision.extractorOrder.join(","),
    "docslurp.extraction.attempted": decision.attempted.join(","),
    "docslurp.extraction.unavailable": decision.unavailable.join(","),
    "docslurp.native_pdf.mode": native?.mode,
    "docslurp.native_pdf.status": native?.engine,
    "docslurp.native_pdf.version": native?.engineVersion,
    "docslurp.native_pdf.unavailable_reason": native?.engineUnavailableReason,
    "docslurp.native_pdf.extraction": native?.extraction.status,
    "docslurp.native_pdf.extraction_code": native?.extraction.code,
    "docslurp.native_pdf.extraction_reason": native?.extraction.reason,
    "docslurp.native_pdf.shadow": native?.shadow.status,
    "docslurp.native_pdf.shadow_reason": native?.shadow.reason,
    "docslurp.native_pdf.shadow_agreement": native?.shadow.agreement,
    "docslurp.native_pdf.parser_payload": native?.parserPayload.status,
    "docslurp.native_pdf.parser_payload_reason": native?.parserPayload.reason,
  };
  const clean = definedAttributes(attributes);
  setActiveSpanAttributes(clean);
  const nativePart = native
    ? ` nativePdf=${native.engine}${native.engineVersion ? `@${native.engineVersion}` : ""} mode=${native.mode} ` +
      `nativeExtraction=${native.extraction.status}${native.extraction.code ? `(${native.extraction.code})` : ""} shadow=${native.shadow.status}` +
      `${native.shadow.reason ? `(${native.shadow.reason})` : ""} parserPayload=${native.parserPayload.status}`
    : "";
  report(nativeMissed ? "warn" : "info", "docslurp.extraction.decision",
    `[extract] document=${decision.documentId} format=${decision.format} extractor=${decision.extractor} strategy=${decision.strategy} ` +
      `order=${decision.extractorOrder.join(",")} attempted=${decision.attempted.join(",")} unavailable=${decision.unavailable.join(",") || "none"}${nativePart}`,
    clean);
}
