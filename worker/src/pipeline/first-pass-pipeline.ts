/*
 * The pipeline the first pass runs its document shards with, and whether a run's own pipeline extracts PDFs differently.
 * Kept apart from pipeline/first-pass.ts so the stage runtime can use it without importing the batch machinery.
 */
import type { PipelineFeatures } from "@docslurp/shared";

/** The pipeline the first pass runs its stages with: PDFs through the sandboxed PDF route only, no vision fallback. */
export function firstPassPipeline(pipeline: PipelineFeatures): PipelineFeatures {
  return {
    ...pipeline,
    visionFallback: false,
    documentExtraction: {
      ...pipeline.documentExtraction,
      order: { ...pipeline.documentExtraction?.order, pdf: ["vm-pdf"] },
    },
  } as PipelineFeatures;
}

/** Stable JSON (sorted keys) for comparing configuration objects. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Whether the run's own pipeline extracts a PDF differently from the first pass (council #340 C1): vision fallback (page
 * image evidence, textless pages read by vision) or a PDF extractor order or options other than the first pass's. Then
 * the ordinary loop runs extract-markdown again for the first pass's documents, served from the persisted batch result.
 */
export function firstPassExtractionDiffers(pipeline: PipelineFeatures): boolean {
  const first = firstPassPipeline(pipeline);
  return Boolean(pipeline.visionFallback) !== Boolean(first.visionFallback)
    || stable(pipeline.documentExtraction ?? null) !== stable(first.documentExtraction ?? null);
}
