import type { Document } from "../models.js";
import { documentArtifactRoot } from "./artifact-root.js";

/**
 * An uploaded image's pages are never decoded in the worker process. The OCR boundary (a VM, or the customer-owned local
 * sandbox) writes a bounded, normalized PNG rendition of each frame; the worker stores it here and page-image embedding
 * reads only this. Caps: long edge (the embedder's 1024 px input) and encoded size.
 */
export const PAGE_RENDITION = Object.freeze({ maxLongEdge: 1024, maxBytes: 4 * 1024 * 1024 });

export function pageRenditionKey(document: Pick<Document, "id" | "userId" | "runId" | "artifactRoot">, pageNumber: number): string {
  return `${documentArtifactRoot(document)}/images/${document.id}/rendition/page-${pageNumber}.png`;
}
