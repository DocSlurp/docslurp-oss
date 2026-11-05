import { decodeTextBytes, measuredTextPages, pageCredits, speedBoostMultiplier, type NormalizedFormat } from "@docslurp/shared";

import type { Document } from "../models.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { sha256Bytes, verifyStagedSource } from "../sandbox/source-integrity.js";
import { StorageObjectTooLargeError } from "../tools/storage.js";
import { RunPolicyError } from "./document-failure.js";

/** Text formats whose pages are the text rule's (shared measuredTextPages); Office, RTF and EPUB are measured from their extractor. */
const TEXT_RULE_FORMATS: ReadonlySet<NormalizedFormat> = new Set<NormalizedFormat>(["plain-text", "markdown", "html", "structured-csv", "structured-json", "latex"]);

/**
 * Largest text source the worker measures in full: the whole decoded text is held once in memory. A larger text file is refused
 * (failed, never billed) rather than billed on an estimate.
 */
export const TEXT_MEASURE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * A text file whose intake count is not `counted` (the API sampled a file over 2 MB and scaled the count, or had no evidence):
 * count its pages with the same text rule over the whole decoded text, record that as the document's `counted` page count
 * before any stage uses it or anything bills, and re-check the balance for pages above intake's. Decoding is the shared pure
 * TypeScript decoder (the encoding intake sniffed); no parser runs. Billing reads only this count: a document still `assumed`
 * with no measured pages never bills (db/page-base-fee.ts).
 */
export async function recordMeasuredTextPageCount(args: {
  state: WorkflowState;
  document: Document;
  format: NormalizedFormat;
  readSource: (maxBytes: number) => Promise<Uint8Array>;
}): Promise<{ pages: number; estimate: number } | null> {
  const { state, document, format } = args;
  if (!TEXT_RULE_FORMATS.has(format) || document.pageCountSource !== "assumed") return null;
  const estimate = Math.max(1, Math.trunc(document.pageCount) || 1);
  let bytes: Uint8Array;
  try {
    bytes = await args.readSource(TEXT_MEASURE_MAX_BYTES);
  } catch (error) {
    if (error instanceof StorageObjectTooLargeError) {
      console.error(`[text-pages] refused document=${document.id}: over ${TEXT_MEASURE_MAX_BYTES} bytes, too large to measure; not billed on an estimate`);
      throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
    }
    throw error;
  }
  if (bytes.length > TEXT_MEASURE_MAX_BYTES) throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
  verifyStagedSource(document, sha256Bytes(bytes));
  const pages = bytes.length === 0 ? 1 : measuredTextPages(decodeTextBytes(bytes, document.fileFacts?.encoding ?? undefined), { markup: format === "html" });
  if (!state.store?.setDocumentPageCount) throw new Error("text page count measured but the store cannot persist it");
  await state.store.setDocumentPageCount(state.run.id, document.id, pages);
  document.pageCount = pages;
  document.pageCountSource = "counted";
  state.run.pagesTotal = Math.max(0, (Number(state.run.pagesTotal) || 0) + pages - estimate);
  console.log(`[text-pages] document=${document.id} measured=${pages} estimate=${estimate} bytes=${bytes.length}`);
  // Admission priced the estimate: pages above it owe a Fast base fee admission never saw.
  if (pages > estimate && state.store.enforceSpendForCharge && state.run.userId) {
    const credits = pageCredits("fast", pages - estimate) * speedBoostMultiplier(state.run.pipeline.speedBoost === true);
    const outcome = await state.store.enforceSpendForCharge({ id: state.run.id, orgId: state.run.orgId ?? null, workspaceId: state.run.workspaceId, userId: state.run.userId }, credits);
    if (outcome.paused || outcome.blocked) {
      console.warn(`[text-pages] run=${state.run.id} document=${document.id} paused: ${pages} measured pages (estimate ${estimate}) owe ${credits.toFixed(2)} credits more than the balance holds`);
      throw new RunPolicyError(`Credits do not cover the measured pages of text file ${document.id}; run paused`);
    }
  }
  return { pages, estimate };
}
