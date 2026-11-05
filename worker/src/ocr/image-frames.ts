/*
 * The page basis of a multi-frame image (a TIFF). Intake counts every image as one page; the OCR engine reads each frame as
 * a page (up to IMAGE_MAX_FRAMES) and bills each one Rich. The frames read become the document's page count, so page rows,
 * citations, strict page splitting and the completion charge agree with the Markdown (one form-feed page per frame) and the bill.
 */
import { DOCUMENT_FAILURE_MARKERS, IMAGE_MAX_FRAMES, pageCredits, speedBoostMultiplier } from "@docslurp/shared";

import { RunPolicyError } from "../lib/document-failure.js";
import { extraCreditsForMeasuredPages } from "../lib/office-page-count.js";
import { emitDocumentPageProgress, isCostCapExceeded } from "../pipeline/checkpoints.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { OcrRefusedError } from "./mode.js";

/** An image with more frames than one file may hold: refused before anything is charged, never read in part. */
export function imageTooManyFramesError(documentId: string): OcrRefusedError {
  console.error(`[ocr] image-frames-refused document=${documentId} max=${IMAGE_MAX_FRAMES}: the image holds more frames than one file may`);
  return new OcrRefusedError(`${DOCUMENT_FAILURE_MARKERS.imageTooManyFrames} (${IMAGE_MAX_FRAMES})`, "too-many-frames");
}

/**
 * Before an uploaded image's OCR read starts a VM: the run's cost cap, then the balance for the image's first Rich page plus the
 * run's charges still buffered in this activity. Admission checked the org once for the whole run; this holds for each read.
 * Fails closed: an unfunded run is paused and stopped here (a run-policy stop: the image stays unread, not failed, and runs again
 * once the run resumes), and a check that cannot decide throws SpendCheckUnavailableError (retryable). No VM cost is incurred
 * on either path.
 */
export async function authorizeImageRead(state: WorkflowState, documentId: string): Promise<void> {
  if (isCostCapExceeded(state)) {
    console.warn(`[ocr] image-read-refused run=${state.run.id} document=${documentId} reason=cost-cap`);
    throw new RunPolicyError(`Run cost cap reached before the OCR read of image ${documentId}`);
  }
  const store = state.store;
  if (!store?.enforceSpendForCharge || !state.run.userId) return;
  const credits = pageCredits("rich", 1) * speedBoostMultiplier(state.run.pipeline.speedBoost === true) + state.usageLedger.pendingBillableCents;
  const outcome = await store.enforceSpendForCharge({ id: state.run.id, orgId: state.run.orgId ?? null, workspaceId: state.run.workspaceId, userId: state.run.userId }, credits);
  if (outcome.paused || outcome.blocked) {
    console.warn(`[ocr] image-read-refused run=${state.run.id} document=${documentId} reason=unfunded credits=${credits.toFixed(2)}`);
    throw new RunPolicyError(`Credits do not cover the OCR read of image ${documentId}; run paused`);
  }
}

/**
 * After the boundary counted an image's frames and before any is charged or escalated: record them as the page basis, report
 * progress over them, and check the balance for the Rich frames admission never priced (intake counted one page). The check adds
 * the uncharged frames of every TIFF of the run (the store's rows, this document's included once recorded), as the measured
 * Office page check does, so concurrent documents cannot each fit alone and together overdraw. When they no longer fit the run
 * is paused and the image is refused before anything is charged. The count itself needs the boundary's read: the host never
 * parses the file.
 */
export async function authorizeImageFrames(state: WorkflowState, documentId: string, stageName: string, frames: number): Promise<void> {
  const document = state.documents.find((candidate) => candidate.id === documentId);
  if (!document) return;
  const intake = Math.max(1, Math.trunc(document.pageCount) || 1);
  await recordImageFramePages(state, documentId, frames);
  if (frames <= intake) return;
  // The run's page total counted the image as one page; progress counts every frame.
  state.run.pagesTotal = Math.max(0, Number(state.run.pagesTotal) || 0) + frames - intake;
  await emitDocumentPageProgress(state, document, stageName, 1, frames, "processing");
  const store = state.store;
  if (!store?.enforceSpendForCharge || !state.run.userId) return;
  const pipeline = state.run.pipeline;
  const own = extraCreditsForMeasuredPages(pipeline, intake, frames, null, { mode: "rich" });
  if (!(own > 0)) return;
  const ownRich = extraCreditsForMeasuredPages(pipeline, intake, frames, null, { mode: "rich", features: false });
  const rows = store.countedImageFrames ? await store.countedImageFrames(state.run.id) : [];
  // Frames of the run's TIFFs no Rich charge covers yet (page 1 was priced at admission).
  const runRich = rows.reduce((sum, row) => sum + extraCreditsForMeasuredPages(pipeline, Math.max(1, row.chargedPages), row.pageCount, null, { mode: "rich", features: false }), 0);
  const extra = own - ownRich + Math.max(ownRich, runRich);
  // Fails closed: a check that cannot decide throws SpendCheckUnavailableError (retryable) out of the stage, before any charge.
  const outcome = await store.enforceSpendForCharge({ id: state.run.id, orgId: state.run.orgId ?? null, workspaceId: state.run.workspaceId, userId: state.run.userId }, extra);
  if (!outcome.paused && !outcome.blocked) return;
  console.warn(`[ocr] image-frames-unfunded run=${state.run.id} document=${documentId} frames=${frames} intake=${intake} owes=${extra.toFixed(2)}: run paused, image refused before any charge`);
  throw new OcrRefusedError(`${DOCUMENT_FAILURE_MARKERS.imageFramesUnfunded} (${frames} frames)`, "spend-paused");
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
