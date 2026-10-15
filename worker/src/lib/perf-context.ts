import { withObservation } from "@docslurp/shared/observability";
import { AsyncLocalStorage } from "node:async_hooks";

import type { JsonMap, PerformanceEvent, UsageEvent } from "../models.js";

type PerformanceSink = (event: PerformanceEvent) => void;

interface WorkerPerfContext {
  runId: string;
  scope: string;
  stageName: string;
  documentId?: string;
  /** Pages of the document being processed: scales subprocess wall-clock budgets. */
  pageCount?: number;
  pushPerformance: PerformanceSink;
  pushUsage?: (event: UsageEvent) => void;
}

const workerPerfStorage = new AsyncLocalStorage<WorkerPerfContext>();

export function runWithPerfContext<T>(context: WorkerPerfContext, fn: () => Promise<T>): Promise<T> {
  return workerPerfStorage.run(context, () => withObservation({
    name: `worker.${context.scope}.${context.stageName}`,
    metadata: { runId: context.runId, documentId: context.documentId, stage: context.stageName, scope: context.scope },
  }, fn));
}

export function currentPerfContext(): WorkerPerfContext | undefined {
  return workerPerfStorage.getStore();
}

export function pushPerfMetric(args: {
  metric: string;
  value: number;
  unit: string;
  tags?: string[];
  metadata?: JsonMap;
}): void {
  const context = workerPerfStorage.getStore();
  if (!context) {
    return;
  }

  context.pushPerformance({
    documentId: context.documentId,
    scope: context.scope,
    stageName: context.stageName,
    metric: args.metric,
    value: args.value,
    unit: args.unit,
    tags: args.tags ?? [],
    metadata: args.metadata
  });
}

export function pushUsageEvent(event: UsageEvent): void {
  workerPerfStorage.getStore()?.pushUsage?.(event);
}

/**
 * Runs `fn`, pushes a latency metric named `metric` (in ms), then returns the result.
 * No-ops gracefully if there is no perf context.
 */
export async function measureOp<T>(
  metric: string,
  fn: () => Promise<T>,
  opts?: { tags?: string[]; metadata?: JsonMap }
): Promise<T> {
  const startedAt = Date.now();
  const result = await fn();
  pushPerfMetric({
    metric,
    value: Date.now() - startedAt,
    unit: "ms",
    tags: opts?.tags,
    metadata: opts?.metadata,
  });
  return result;
}

export interface ProcessStats {
  cpuUserMs: number;
  cpuSystemMs: number;
  rssBytes: number;
}

/**
 * Capture current process CPU and memory usage.
 */
export function captureProcessStats(): ProcessStats {
  const cpu = process.cpuUsage();
  const mem = process.memoryUsage();
  return {
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    rssBytes: mem.rss,
  };
}

/**
 * Compute delta between two process stat snapshots and push perf metrics:
 * `stage-cpu-user`/`stage-cpu-system` (ms, summable), `stage-rss-delta`
 * (growth in bytes) and, when peakRss is provided, `stage-rss-peak` (the
 * absolute RSS high-water mark in bytes; take the max, never the sum).
 */
export function pushProcessStatsDelta(
  start: ProcessStats,
  end: ProcessStats,
  tags?: string[],
  metadata?: JsonMap,
  peakRssBytes?: number,
): void {
  pushPerfMetric({
    metric: "stage-cpu-user",
    value: Math.max(0, end.cpuUserMs - start.cpuUserMs),
    unit: "ms",
    tags: [...(tags ?? []), "cpu", "user"],
    metadata,
  });
  pushPerfMetric({
    metric: "stage-cpu-system",
    value: Math.max(0, end.cpuSystemMs - start.cpuSystemMs),
    unit: "ms",
    tags: [...(tags ?? []), "cpu", "system"],
    metadata,
  });
  pushPerfMetric({
    metric: "stage-rss-delta",
    value: Math.max(0, end.rssBytes - start.rssBytes),
    unit: "byte",
    tags: [...(tags ?? []), "memory", "rss"],
    metadata,
  });
  if (typeof peakRssBytes === "number") {
    // Absolute process RSS high-water mark for the stage. Readers take the max
    // across stages; a per-stage growth delta can't be summed into a peak.
    pushPerfMetric({
      metric: "stage-rss-peak",
      value: Math.max(0, peakRssBytes, start.rssBytes, end.rssBytes),
      unit: "byte",
      tags: [...(tags ?? []), "memory", "rss", "peak"],
      metadata,
    });
  }
}
