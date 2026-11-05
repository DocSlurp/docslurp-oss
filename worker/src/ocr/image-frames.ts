/*
 * The page basis of a multi-frame image (a TIFF). Intake counts every image as one page; the OCR engine reads each frame as
 * a page (up to IMAGE_MAX_FRAMES) and bills each one Rich. The frames read become the document's page count, so page rows,
 * citations, strict page splitting and the completion charge agree with the Markdown (one form-feed page per frame) and the bill.
 */
import { DOCUMENT_FAILURE_MARKERS, IMAGE_MAX_FRAMES } from "@docslurp/shared";

import type { WorkflowState } from "../pipeline/pipeline.js";
import { OcrRefusedError } from "./mode.js";

/** An image with more frames than one file may hold: refused before anything is charged, never read in part. */
export function imageTooManyFramesError(documentId: string): OcrRefusedError {
  console.error(`[ocr] image-frames-refused document=${documentId} max=${IMAGE_MAX_FRAMES}: the image holds more frames than one file may`);
  return new OcrRefusedError(`${DOCUMENT_FAILURE_MARKERS.imageTooManyFrames} (${IMAGE_MAX_FRAMES})`, "too-many-frames");
}

/** Record the frames read as the document's page count, persisted before anything downstream reads it. */
export async function recordImageFramePages(
  state: Pick<WorkflowState, "documents" | "run" | "store">,
  documentId: string,
  frames: number,
): Promise<void> {
  const document = state.documents.find((candidate) => candidate.id === documentId);
  if (!document || !Number.isSafeInteger(frames) || frames < 1 || document.pageCount === frames) return;
  if (state.store) {
    if (!state.store.setDocumentPageCount) throw new Error("image frames read but the store cannot persist the page count");
    await state.store.setDocumentPageCount(state.run.id, documentId, frames);
  }
  console.log(`[ocr] image-frames document=${documentId} pages=${frames} intake=${document.pageCount}`);
  document.pageCount = frames;
}
