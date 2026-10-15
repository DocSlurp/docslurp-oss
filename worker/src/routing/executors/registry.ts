/**
 * Executor registry: maps a RoutingTarget to the code that really runs it. A target with no
 * executor (unknown id, unconfigured engine) is reported as unexecutable so the caller can
 * fall back instead of silently dropping the page.
 */

import { resolveTargetLicense, type RoutingTarget } from "@docslurp/shared";

import { readRoutingFlags } from "../flags.js";

import { baseOutput, type ExecutorDeps, type ExecutorOutput, type TargetExecutor } from "./types.js";
import { nativeExtractor, nativePdfExecutors } from "./native-pdf.js";

const base = baseOutput;

/** Uses the page text the cheap native pass already put in the canonical document. No model. */
const acceptTextLayer: TargetExecutor = {
  id: "native:accept-text-layer",
  needsRaster: false,
  async run(request, deps) {
    const text = await deps.pageText(request.assignment.pageNumber);
    if (text === null) return null;
    return { ...base(request), text, model: "text-layer", runtime: "native", latencyMs: 0 };
  },
};

const tesseract: TargetExecutor = {
  id: "ocr:tesseract",
  needsRaster: true,
  async run(request, deps, signal) {
    const raster = request.raster;
    if (!raster) return null;
    const result = await deps.ocr(raster, { pageNumber: request.assignment.pageNumber, signal });
    return { ...base(request), text: result.text, model: result.model, runtime: "tesseract", latencyMs: result.latencyMs };
  },
};

const florenceLabeler: TargetExecutor = {
  id: "local:florence-2-small",
  needsRaster: true,
  async run(request, deps, signal) {
    const raster = request.raster;
    if (!raster) return null;
    const result = await deps.label(raster, { pageNumber: request.assignment.pageNumber, signal });
    return { ...base(request), text: result.text, model: result.model, runtime: "local-cli", latencyMs: result.latencyMs };
  },
};

const vlm: TargetExecutor = {
  id: "kind:vlm",
  needsRaster: true,
  async run(request, deps, signal) {
    const raster = request.raster;
    if (!raster) return null;
    const out = await deps.vlm({
      target: request.target,
      role: request.assignment.role,
      raster,
      pageNumber: request.assignment.pageNumber,
      signal,
    });
    return {
      ...base(request),
      text: out.text,
      model: out.model,
      runtime: out.runtime,
      latencyMs: out.latencyMs,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      costCents: out.costCents,
      finishReason: out.finishReason ?? null,
    };
  },
};

const skip: TargetExecutor = {
  id: "skip",
  needsRaster: false,
  async run() {
    return null;
  },
};

const BY_ID = new Map<string, TargetExecutor>([
  [acceptTextLayer.id, acceptTextLayer],
  ["native:kreuzberg", nativeExtractor("native:kreuzberg", "kreuzberg")],
  ...nativePdfExecutors.map((e): [string, TargetExecutor] => [e.id, e]),
  [tesseract.id, tesseract],
  [florenceLabeler.id, florenceLabeler],
  [skip.id, skip],
]);

/** The executor for a target, or null when nothing can run it. */
export function executorFor(target: RoutingTarget | undefined): TargetExecutor | null {
  if (!target) return null;
  // Defense in depth behind catalog admission: with DISABLE_NON_FREE_SOFTWARE a non-free target never runs.
  if (readRoutingFlags().disableNonFreeSoftware && resolveTargetLicense(target).licenseClass === "non-free") return null;
  const byId = BY_ID.get(target.id);
  if (byId) return byId;
  if ((target.kind === "hosted-vlm" || target.kind === "private-vlm") && target.ref.modelUri) return vlm;
  return null;
}

export type { ExecutorDeps, ExecutorOutput };
