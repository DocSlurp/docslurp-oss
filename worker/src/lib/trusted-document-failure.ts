import { PdfPageCountError } from "./pdf-page-count.js";
import type { DocumentFailure } from "@docslurp/shared";
import { OcrRefusedError, OcrDeterministicFailure, OcrInfrastructureError } from "../ocr/mode.js";
import { findArtifactReadError } from "./artifact-read-error.js";

/** Only typed worker evidence supplies retry policy. Text and arbitrary `retryable` fields are not evidence. */
export function trustedDocumentFailure(error: unknown): DocumentFailure {
  if (error instanceof PdfPageCountError) {
    if (error.outcome === "unavailable") return { code: "infrastructure_unavailable", retryable: true };
    return { code: error.outcome === "encrypted" ? "source_encrypted" : "source_rejected", retryable: false };
  }
  if (error instanceof OcrRefusedError) return { code: "capability_unavailable", retryable: false };
  if (error instanceof OcrDeterministicFailure) return { code: "source_rejected", retryable: false };
  if (error instanceof OcrInfrastructureError) return { code: "infrastructure_unavailable", retryable: true };
  const artifact = findArtifactReadError(error);
  if (artifact) return artifact.retryable ? { code: "infrastructure_unavailable", retryable: true } : { code: "source_rejected", retryable: false };
  return { code: "processing_failed", retryable: null };
}
