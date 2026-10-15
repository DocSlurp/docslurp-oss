import type { PolicyPack, RoutingTarget } from "@docslurp/shared";

import { findProviderRetryableError } from "../../lib/provider-retry.js";
import { isContentRefusal } from "../cascade.js";
import { rankRefusalFallbacks, vendorOfTarget } from "../refusal-fallback.js";
import { executorFor } from "./registry.js";
import type { ExecutionRequest, ExecutorDeps, ExecutorOutput, RasterRef } from "./types.js";

export interface ExecutorFailure {
  assignmentIndex: number;
  pageNumber: number;
  targetId: string;
  reason: string;
}

export interface ExecuteAssignmentsResult {
  outputs: ExecutorOutput[];
  failures: ExecutorFailure[];
  skipped: Array<{ assignmentIndex: number; pageNumber: number; targetId: string; reason: "cost-cap" }>;
  /** Non-fatal notes, e.g. a crop refusal that kept its original outcome because no fallback could serve it. */
  warnings: string[];
}

export interface ExecuteAssignmentsOptions {
  signal?: AbortSignal;
  /** False once the run's cost cap is reached; model-calling executors are skipped. */
  canContinue?: () => boolean;
  /** Pages processed at once (default 2). */
  concurrency?: number;
  /**
   * Retry a region/image-scoped (or image-label) VLM call the provider refused (deterministic content filter) once on
   * the next-best target of another vendor (see refusal-fallback.ts). Absent: refusals are kept as they are.
   */
  refusalFallback?: { catalog: readonly RoutingTarget[]; pack?: PolicyPack | null };
}

/** Crop-scoped VLM work the page-scope escalation path never sees: region/image scopes and image labels. */
function isCropScoped(request: ExecutionRequest): boolean {
  return request.assignment.scope.kind !== "page" || request.assignment.role === "image-label";
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Runs assignments through the executor registry, one page at a time per worker: the page
 * raster is fetched once, region/image-scoped assignments get a crop of it, and a failing
 * assignment is reported (never thrown) so the caller can fall back. Retryable provider
 * errors and aborts propagate so the activity retries rather than skipping the page.
 */
export async function executeAssignments(
  requests: readonly ExecutionRequest[],
  deps: ExecutorDeps,
  options: ExecuteAssignmentsOptions = {},
): Promise<ExecuteAssignmentsResult> {
  const result: ExecuteAssignmentsResult = { outputs: [], failures: [], skipped: [], warnings: [] };
  const byPage = new Map<number, ExecutionRequest[]>();
  for (const request of requests) {
    const list = byPage.get(request.assignment.pageNumber) ?? [];
    list.push(request);
    byPage.set(request.assignment.pageNumber, list);
  }

  const fail = (request: ExecutionRequest, reason: string): void => {
    result.failures.push({
      assignmentIndex: request.index,
      pageNumber: request.assignment.pageNumber,
      targetId: request.assignment.targetId,
      reason,
    });
  };

  /**
   * One retry of a refused crop on the next-best other-vendor target. The output keeps the assignment's target id (cost
   * attribution stays on the planned assignment), sums both calls' usage and records the leg in `refusalFallback`.
   * With no eligible fallback, a cost cap, or a failing leg the original outcome is kept and a warning is recorded.
   */
  const retryRefusal = async (request: ExecutionRequest, refused: ExecutorOutput, raster: RasterRef): Promise<ExecutorOutput> => {
    const where = `page ${request.assignment.pageNumber} assignment ${request.index} (${request.target.id})`;
    const next = rankRefusalFallbacks({
      assignment: { role: request.assignment.role, targetId: request.target.id },
      catalog: options.refusalFallback!.catalog,
      pack: options.refusalFallback!.pack,
      refusedVendors: new Set([vendorOfTarget(request.target)]),
    })[0];
    if (!next) {
      result.warnings.push(`refusal-no-fallback: ${where} refused with no eligible other-vendor target`);
      return refused;
    }
    if (options.canContinue && !options.canContinue()) {
      result.warnings.push(`refusal-fallback-skipped: ${where} refused, cost cap reached before ${next.id}`);
      return refused;
    }
    let leg;
    try {
      leg = await deps.vlm({ target: next, role: request.assignment.role, raster, pageNumber: request.assignment.pageNumber, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      result.warnings.push(`refusal-fallback-failed: ${where} -> ${next.id}: ${error instanceof Error ? error.message : String(error)}`);
      return refused;
    }
    const usable = leg.text.trim() !== "" && !isContentRefusal(leg);
    if (!usable) result.warnings.push(`refusal-fallback-unusable: ${where} -> ${next.id} returned no usable text`);
    return {
      ...refused,
      ...(usable ? { text: leg.text, model: leg.model, runtime: leg.runtime, finishReason: leg.finishReason ?? null } : {}),
      latencyMs: refused.latencyMs + leg.latencyMs,
      inputTokens: refused.inputTokens + leg.inputTokens,
      outputTokens: refused.outputTokens + leg.outputTokens,
      costCents: refused.costCents + leg.costCents,
      refusalFallback: { fromTargetId: request.target.id, toTargetId: next.id, served: usable },
    };
  };

  const runOne = async (request: ExecutionRequest, raster: RasterRef | null, clipped?: RasterRef): Promise<void> => {
    const executor = executorFor(request.target);
    if (!executor) {
      fail(request, "no-executor");
      return;
    }
    if (executor.id === "kind:vlm" && options.canContinue && !options.canContinue()) {
      result.skipped.push({
        assignmentIndex: request.index,
        pageNumber: request.assignment.pageNumber,
        targetId: request.assignment.targetId,
        reason: "cost-cap",
      });
      return;
    }
    const execute = async (input: RasterRef | undefined) => {
      try {
        let output = await executor.run({ ...request, ...(input ? { raster: input } : {}) }, deps, options.signal);
        if (output && input && executor.id === "kind:vlm" && options.refusalFallback && isCropScoped(request) && isContentRefusal(output)) {
          output = await retryRefusal(request, output, input);
        }
        if (output) result.outputs.push(output);
      } catch (error) {
        if (options.signal?.aborted || findProviderRetryableError(error)) throw error;
        fail(request, error instanceof Error ? error.message : String(error));
      }
    };
    if (!executor.needsRaster) {
      await execute(undefined);
      return;
    }
    if (clipped) {
      await execute(clipped);
      return;
    }
    if (!raster) {
      fail(request, "no-raster");
      return;
    }
    const scope = request.assignment.scope;
    const bbox = scope.kind === "region" ? scope.bbox : scope.kind === "image" ? scope.bbox : undefined;
    if (bbox && bbox.width > 0 && bbox.height > 0) {
      try {
        await deps.withCrop(raster, bbox, async (crop) => await execute(crop));
      } catch (error) {
        if (options.signal?.aborted || findProviderRetryableError(error)) throw error;
        fail(request, `crop-failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    await execute(raster);
  };

  await pool([...byPage.entries()], options.concurrency ?? 2, async ([pageNumber, pageRequests]) => {
    const rasterRequests = pageRequests.filter((r) => executorFor(r.target)?.needsRaster);
    const needsRaster = rasterRequests.length > 0;
    const bboxOf = (r: ExecutionRequest) => {
      const scope = r.assignment.scope;
      const box = scope.kind === "region" ? scope.bbox : scope.kind === "image" ? scope.bbox : undefined;
      return box && box.width > 0 && box.height > 0 ? box : undefined;
    };
    // Crop-only pages: render just each clip with the native raster engine and skip the full-page raster.
    // Requests the engine cannot serve (it resolves null) take the normal raster + crop path below.
    if (needsRaster && deps.withPageClip && rasterRequests.every((r) => bboxOf(r))) {
      const unserved = new Set<ExecutionRequest>();
      for (const request of pageRequests) {
        if (!rasterRequests.includes(request)) {
          await runOne(request, null);
          continue;
        }
        const served = await deps.withPageClip(pageNumber, bboxOf(request)!, async (crop) => {
          await runOne(request, null, crop);
          return true;
        });
        if (served === null) unserved.add(request);
      }
      if (unserved.size === 0) return;
      const ranFallback = await deps.withRaster(pageNumber, async (raster) => {
        for (const request of unserved) await runOne(request, raster);
        return true;
      });
      if (ranFallback === null) for (const request of unserved) await runOne(request, null);
      return;
    }
    if (!needsRaster) {
      for (const request of pageRequests) await runOne(request, null);
      return;
    }
    const ran = await deps.withRaster(pageNumber, async (raster) => {
      for (const request of pageRequests) await runOne(request, raster);
      return true;
    });
    if (ran === null) {
      // No raster for the page: raster-free requests still run, the rest are reported.
      for (const request of pageRequests) await runOne(request, null);
    }
  });

  result.outputs.sort((a, b) => a.pageNumber - b.pageNumber || a.assignmentIndex - b.assignmentIndex);
  return result;
}
