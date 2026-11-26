import { detectFileFormat, type NormalizedFormat } from "@docslurp/shared";

import type { Document } from "../models.js";

/**
 * The format of a document: the one its file facts record (intake's, replaced by quarantine's full inspection) when there
 * is one; otherwise the stored MIME type and extension, for documents ingested before intake sniffed. Format-detect records
 * it; quarantine reads it to decide whether the inspection counts text pages.
 */
export function detectDocumentFormat(document: Pick<Document, "fileFacts" | "filename" | "mimeType">): { format: NormalizedFormat; detectedBy: "intake-file-facts" | "mime-and-extension" } {
  const persisted = document.fileFacts?.format;
  if (persisted && persisted !== "unknown") return { format: persisted, detectedBy: "intake-file-facts" };
  return { format: detectFileFormat({ filename: document.filename, mimeType: document.mimeType }), detectedBy: "mime-and-extension" };
}
