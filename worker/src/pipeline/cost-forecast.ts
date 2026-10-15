import type { Document } from "../models.js";
import { visionModelCatalogByUri, type PipelineFeatures } from "@docslurp/shared";
import {
  calculateLocalComputeCost,
  resolveWorkerDeploymentProfile,
  type WorkerDeploymentProfile,
} from "./local-compute-cost.js";

export interface CostForecast {
  minCents: number;
  maxCents: number;
  breakdown: Record<string, number>;
  deploymentProfile: string;
}

const EMBEDDING_COST_PER_PAGE = 0.002;
const FIXED_OVERHEAD_PER_DOC = 0.01;
const BASELINE_CPU_SECONDS_PER_PAGE = 0.15;
const BASELINE_MEMORY_GB_SECONDS_PER_PAGE = 0.05;
const ESCALATED_CPU_SECONDS_PER_PAGE = 2;
const ESCALATED_MEMORY_GB_SECONDS_PER_PAGE = 2;
const ARTIFACT_BYTES_PER_PAGE = 64 * 1024;
const ARTIFACT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export function forecastRunCost(
  documents: Document[],
  pipeline: PipelineFeatures,
  profile: WorkerDeploymentProfile = resolveWorkerDeploymentProfile(),
): CostForecast {
  const totalPages = documents.reduce((sum, doc) => sum + Math.max(doc.pageCount, 1), 0);
  const docCount = documents.length;

  const embeddingCost = pipeline.embed ? totalPages * EMBEDDING_COST_PER_PAGE : 0;
  const configuredVisionCostPerPage =
    visionModelCatalogByUri[pipeline.vision.modelUri]?.estimatedCostPerPageCents ?? 0.3;
  const fallbackVisionCostPerPage = pipeline.vision.remoteFallbackModelUri
    ? (visionModelCatalogByUri[pipeline.vision.remoteFallbackModelUri]?.estimatedCostPerPageCents ?? configuredVisionCostPerPage)
    : configuredVisionCostPerPage;
  const visionCost = pipeline.visionFallback ? totalPages * configuredVisionCostPerPage : 0;
  const overheadCost = docCount * FIXED_OVERHEAD_PER_DOC;
  const baselineLocalCost = calculateLocalComputeCost({
    cpuSeconds: totalPages * BASELINE_CPU_SECONDS_PER_PAGE,
    memoryGbSeconds: totalPages * BASELINE_MEMORY_GB_SECONDS_PER_PAGE,
    storageBytes: totalPages * ARTIFACT_BYTES_PER_PAGE,
    storageDurationSeconds: ARTIFACT_RETENTION_SECONDS,
  }, profile.rates).totalCents;
  const escalatedLocalCost = calculateLocalComputeCost({
    cpuSeconds: totalPages * ESCALATED_CPU_SECONDS_PER_PAGE,
    memoryGbSeconds: totalPages * ESCALATED_MEMORY_GB_SECONDS_PER_PAGE,
    storageBytes: totalPages * ARTIFACT_BYTES_PER_PAGE,
    storageDurationSeconds: ARTIFACT_RETENTION_SECONDS,
  }, profile.rates).totalCents;

  const breakdown: Record<string, number> = {
    embedding: Math.ceil(embeddingCost * 100) / 100,
    vision: Math.ceil(visionCost * 100) / 100,
    overhead: Math.ceil(overheadCost * 100) / 100,
    localCompute: roundForecast(escalatedLocalCost),
  };

  // Min assumes no vision fallback needed, max assumes all pages need vision
  const minCents = roundForecast(embeddingCost + overheadCost + baselineLocalCost);
  const maxVisionCost = pipeline.visionFallback ? totalPages * Math.max(configuredVisionCostPerPage, fallbackVisionCostPerPage) : 0;
  const maxCents = roundForecast(
    embeddingCost + maxVisionCost + overheadCost + escalatedLocalCost,
  );

  return { minCents, maxCents, breakdown, deploymentProfile: profile.id };
}

function roundForecast(value: number): number {
  return Math.ceil(value * 100_000) / 100_000;
}
