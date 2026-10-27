/** A reprocess request the source run cannot satisfy (4xx, nothing created). */
export class ReprocessRejectedError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409,
    readonly code: "no_stages_to_run" | "source_not_reusable" | "missing_stage_artifacts" | "extract_not_reprocessable",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ReprocessRejectedError";
  }
}

export function isReprocessRejectedError(error: unknown): error is ReprocessRejectedError {
  return error instanceof ReprocessRejectedError;
}

/**
 * Extract documents expire with their extract; a new version would outlive it
 * while pointing at sources and artifacts its expiry deletes.
 */
export function extractNotReprocessable(): ReprocessRejectedError {
  return new ReprocessRejectedError("Extract documents can't be reprocessed: they are deleted when the extract expires. Run the extract again instead.", 409, "extract_not_reprocessable");
}
