import type { Document } from "../models.js";

/**
 * Whether the document's bytes are a PDF, by what intake sniffed (documents.file_facts), never by its file name or declared
 * type: a polyglot named x.pdf or declared application/pdf that sniffed as HTML must not reach a PDF parser (the in-process
 * engine finds `%PDF-` anywhere in a file). Documents ingested before intake sniffed fall back to the stored MIME type.
 */
export function sniffedPdf(document: Pick<Document, "mimeType" | "fileFacts">): boolean {
  if (document.fileFacts) return document.fileFacts.format === "pdf";
  return document.mimeType === "application/pdf";
}
