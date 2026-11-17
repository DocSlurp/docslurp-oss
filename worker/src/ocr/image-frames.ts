/*
 * The page basis of a multi-frame image (a TIFF). Intake counts every image as one page; the OCR engine reads each frame as
 * a page (up to IMAGE_MAX_FRAMES) and bills each one OCR. The frames read become the document's page count, so page rows,
 * citations, strict page splitting and the completion charge agree with the Markdown (one form-feed page per frame) and the bill.
 */
import { DOCUMENT_FAILURE_MARKERS, IMAGE_MAX_FRAMES } from "@docslurp/shared";

import { RunPolicyError } from "../lib/document-failure.js";
import { emitDocumentPageProgress, isCostCapExceeded } from "../pipeline/checkpoints.js";
import { UnfundedPagesError } from "../pipeline/page-basis.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { OcrRefusedError } from "./mode.js";

/** An image with more frames than one file may hold: refused before anything is charged, never read in part. */
export function imageTooManyFramesError(documentId: string): OcrRefusedError {
  console.error(`[ocr] image-frames-refused document=${documentId} max=${IMAGE_MAX_FRAMES}: the image holds more frames than one file may`);
  return new OcrRefusedError(`${DOCUMENT_FAILURE_MARKERS.imageTooManyFrames} (${IMAGE_MAX_FRAMES})`, "too-many-frames");
}

/**
 * Before an uploaded image's OCR read starts a VM: the run's cost cap, then the balance for the image's first OCR page plus the
 * run's charges still buffered in this activity. Admission checked the org once for the whole run; this holds for each read.
 * Fails closed: an unfunded run is paused and stopped here (a run-policy stop: the image stays unread, not failed, and runs again
 * once the run resumes), and a check that cannot decide throws SpendCheckUnavailableError (retryable). No VM cost is incurred
 * on either path.
 */
export async function authorizeImageRead(state: WorkflowState, documentId: string): Promise<void> {
  await authorizeOcrRead(state, documentId, 1, "image");
}

/**
 * Before an OCR read starts a VM for `pages` OCR pages of a document (an image's first frame, a batch of a scanned PDF's
 * pages): the run's cost cap, then the balance for those pages plus the run's charges still buffered in this activity (the
 * pages earlier batches read included), through the page basis. Fails closed like authorizeImageRead: an unfunded run is
 * paused and stopped here (RunPolicyError, before any VM cost), and a check that cannot decide throws
 * SpendCheckUnavailableError (retryable).
 */
export async function authorizeOcrRead(state: WorkflowState, documentId: string, pages: number, what: "image" | "pdf-batch"): Promise<void> {
  const label = what === "image" ? "image-read-refused" : "pdf-batch-refused";
  const subject = what === "image" ? `image ${documentId}` : `${pages} scanned page(s) of document ${documentId}`;
  if (isCostCapExceeded(state)) {
    console.warn(`[ocr] ${label} run=${state.run.id} document=${documentId} pages=${pages} reason=cost-cap`);
    throw new RunPolicyError(`Run cost cap reached before the OCR read of ${subject}`);
  }
  const decision = await state.pageBasis.fund({ kind: "page-read", mode: "ocr", pages });
  if (!decision.funded) {
    console.warn(`[ocr] ${label} run=${state.run.id} document=${documentId} pages=${pages} reason=unfunded credits=${decision.credits.toFixed(2)}`);
    throw new RunPolicyError(`Credits do not cover the OCR read of ${subject}; run paused`);
  }
}

/**
 * Before an image's OCR read starts a VM: how many frames the run can pay for (the page basis sizes them with every other
 * image of the run's uncharged frames and this activity's buffered charges), so the read never covers frames the org could not
 * afford (the boundary stops at this cap; ocr/read-document.ts refuses the image if it had more). At least 1 (authorizeImageRead
 * already covered the first frame) and at most `max`.
 */
export async function affordableImageFrames(state: WorkflowState, documentId: string, max: number): Promise<number> {
  const document = state.documents.find((candidate) => candidate.id === documentId);
  if (!document) throw new Error(`image ${documentId} is not a document of run ${state.run.id}`);
  return await state.pageBasis.affordable({ kind: "image-frames", document }, max);
}

/**
 * After the boundary counted an image's frames and before any is charged or escalated: record them as the page basis (the page
 * basis checks the frames admission never priced with the uncharged frames of every image of the run, so concurrent documents
 * cannot each fit alone and together overdraw), and report progress over them. When they no longer fit the run is paused and
 * the image is refused before anything is charged. The count itself needs the boundary's read: the host never parses the file.
 */
export async function authorizeImageFrames(state: WorkflowState, documentId: string, stageName: string, frames: number): Promise<void> {
  const document = state.documents.find((candidate) => candidate.id === documentId);
  if (!document) return;
  const recorded = Math.max(1, Math.trunc(document.pageCount) || 1);
  let failure: unknown = null;
  try {
    await state.pageBasis.record(document, { kind: "image-frames", frames });
  } catch (error) {
    failure = error;
  }
  // Progress counts every frame once the count is recorded, whatever the spend check decided.
  if (frames !== recorded && document.pageCount === frames) await emitDocumentPageProgress(state, document, stageName, 1, frames, "processing");
  if (failure instanceof UnfundedPagesError) {
    throw unfundedFramesError(state, documentId, frames, failure.paused, `owes=${failure.credits.toFixed(2)} intake=${failure.intakePages}`);
  }
  if (failure) throw failure;
}

/**
 * The image is refused for funds: `spend-paused` only when the run is paused (this check paused it); `spend-blocked` when the
 * balance check found the run already paused or stopped by something else. The image fails either way, with nothing charged.
 */
function unfundedFramesError(state: WorkflowState, documentId: string, frames: number, paused: boolean, detail: string): OcrRefusedError {
  const reason = paused ? "spend-paused" : "spend-blocked";
  console.warn(`[ocr] image-frames-unfunded run=${state.run.id} document=${documentId} frames=${frames} ${detail} outcome=${reason}: image refused before any charge`);
  return new OcrRefusedError(`${DOCUMENT_FAILURE_MARKERS.imageFramesUnfunded} (${frames} frames)`, reason);
}

/**
 * The boundary stopped at the frames affordableImageFrames funded and the image has more: refuse it, and always leave the run
 * paused for funds, so the reported outcome and the run's state agree whatever the balance did since the read was sized.
 *  - The frame check (authorizeImageFrames with one frame past the budget) pauses the run when the balance still does not cover
 *    it: refused as `spend-paused`.
 *  - When the balance changed in between and now covers that check, the run is paused explicitly (`credit_exhausted`, which
 *    resumes by itself once the organization may spend) and the image is refused as `spend-paused` all the same: its frames past
 *    the budget were never read, so it cannot be completed from this read.
 *  - When no pause can be made, the refusal is SpendCheckUnavailableError (retryable): never a `spend-paused` without a pause.
 * Nothing is charged on any path; the VM's provider cost is already in the ledger.
 */
export async function refuseUnfundedImageFrames(state: WorkflowState, documentId: string, stageName: string, budget: number): Promise<never> {
  await authorizeImageFrames(state, documentId, stageName, budget + 1);
  // Throws SpendCheckUnavailableError (retryable) when no pause can be made: never a `spend-paused` without a pause.
  const outcome = await state.pageBasis.pauseForFunds("credit_exhausted");
  throw unfundedFramesError(state, documentId, budget + 1, outcome.paused, `budget=${budget} balance-changed-before-check`);
}
