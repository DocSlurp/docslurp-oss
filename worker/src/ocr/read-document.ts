/*
 * OCR of one document's pages for a pipeline stage: the configured boundary's read (engine.ts), billed per page
 * (ledger.ts), then the escalation reads (escalation.ts). In `hosted` mode, a stored image's bytes go to the hosted reader
 * as uploaded. Every refusal throws; the caller fails the page or document and never substitutes another reader.
 */
import { lstat, readFile } from "node:fs/promises";

import type { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import { OCR_DEFAULT_MAX_FRAMES, readWithOcr, type OcrReadOutcome } from "./engine.js";
import { escalateOcrPages, type EscalationSummary } from "./escalation.js";
import { HOSTED_OCR_MAX_BYTES, HOSTED_OCR_MIME_TYPES, HostedOcrSkipped, ocrEscalationEnabled, type HostedOcrReader } from "./hosted-reader.js";
import { imageTooManyFramesError } from "./image-frames.js";
import { recordOcrReads } from "./ledger.js";
import { OcrRefusedError, resolveOcrMode } from "./mode.js";

export interface OcrDocumentInput {
  runner: Pick<CommandRunner, "run" | "sandboxedOcrRead" | "localOcrRead">;
  state: Pick<WorkflowState, "usageLedger">;
  documentId: string;
  /** Stored file (private temp copy); never decoded on the host. */
  source: string;
  kind: "image" | "pdf";
  /** The stored file's MIME type, for hosted mode. */
  mimeType?: string | null;
  pages?: number[];
  languageSetting?: string;
  /** Hosted reader for escalation (vm/local) and for hosted mode; absent disables both. */
  hostedReader?: HostedOcrReader | null;
  stage: string;
  /**
   * Called with the frames the boundary read, after the frame cap check and before any page is charged or escalated: an
   * image's page basis and spend authorization (image-frames.ts). A throw refuses the document with nothing charged.
   */
  beforeCharging?: (frames: number) => Promise<void>;
  /**
   * An image's frames the run can pay for (image-frames.ts affordableImageFrames), asked before the read starts: the boundary
   * reads no more. When the image had more frames than that, refuseUnfundedFrames refuses it (the run left paused) and nothing
   * is charged.
   */
  frameBudget?: (max: number) => Promise<number>;
  /** Refuses an image with more frames than `frameBudget` funded (image-frames.ts refuseUnfundedImageFrames); never returns. */
  refuseUnfundedFrames?: (budget: number) => Promise<never>;
  /** Ask the boundary for a bounded rendition of every frame (visual indexing); returned as bytes on each page. */
  rendition?: { maxLongEdge: number; maxBytes: number };
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface OcrDocumentPage {
  pageNumber: number;
  text: string;
  reader: string;
  /** The boundary's validated rendition of the frame (raw RGB with its header), read before its scratch directory is removed. */
  rendition?: { bytes: Buffer; width: number; height: number };
  /** The frame's decoded pixel size (page area equivalents of an uploaded image). */
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface OcrDocumentResult {
  mode: "vm" | "local" | "hosted";
  pages: OcrDocumentPage[];
  /** Pages charged as Rich reads by this call. */
  chargedPages: number[];
  truncatedFrames: boolean;
  /** Requested pages the boundary did not reach (past its frame cap); the caller fails them. */
  unreadPages: number[];
  escalation: EscalationSummary | null;
}

export async function ocrDocument(input: OcrDocumentInput): Promise<OcrDocumentResult> {
  const env = input.env ?? process.env;
  const mode = resolveOcrMode(env);
  if (mode === "off") throw new OcrRefusedError("OCR is off (DOCSLURP_OCR_MODE=off)", "off");
  if (mode === "hosted") return await hostedDocument(input);
  let outcome: OcrReadOutcome | null = null;
  const budget = input.kind === "image" && input.frameBudget ? Math.max(1, Math.min(OCR_DEFAULT_MAX_FRAMES, await input.frameBudget(OCR_DEFAULT_MAX_FRAMES))) : null;
  try {
    outcome = await readWithOcr(input.runner, {
      ...(budget !== null && budget < OCR_DEFAULT_MAX_FRAMES ? { maxFrames: budget } : {}),
      source: input.source,
      kind: input.kind,
      ...(input.pages ? { pages: input.pages } : {}),
      ...(input.languageSetting ? { languageSetting: input.languageSetting } : {}),
      escalation: Boolean(input.hostedReader) && ocrEscalationEnabled(env),
      ...(input.rendition ? { rendition: input.rendition } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      env,
    });
    // An image with more frames than one file may hold is refused before anything is charged: reading its first frames would
    // publish part of it under a bill that claims the whole file.
    if (input.kind === "image" && outcome.truncatedFrames) {
      if (budget !== null && budget < OCR_DEFAULT_MAX_FRAMES) {
        // The image has more frames than the run can pay for: refused with the run paused, nothing charged.
        if (input.refuseUnfundedFrames) await input.refuseUnfundedFrames(budget);
        throw new Error(`image ${input.documentId} has more frames than the run's credits cover (${budget} funded) and no refusal path`);
      }
      throw imageTooManyFramesError(input.documentId);
    }
    await input.beforeCharging?.(outcome.pages.length);
    // The recogniser's reads are billed first; an escalation read of the same page is the same Rich page (the ledger sums
    // readers per page), with its own provider cost.
    const chargedPages = recordOcrReads(input.state.usageLedger, input.documentId, outcome, { stage: input.stage, kind: input.kind });
    const escalation = input.hostedReader && outcome.pages.some((page) => page.escalation)
      ? await escalateOcrPages(outcome, input.hostedReader, input.documentId, input.signal)
      : null;
    console.log(
      `[ocr] document=${input.documentId} stage=${input.stage} mode=${outcome.mode} engine=${outcome.engine} pages=${outcome.pages.length} ` +
        `charged=${chargedPages.length} wallMs=${outcome.wallMs} cpuMs=${outcome.cpuMs} peakRssKb=${outcome.peakRssKb} truncated=${outcome.truncatedFrames}`,
    );
    const pages: OcrDocumentPage[] = [];
    for (const page of outcome.pages) {
      // The rendition was validated by header and exact size (engine.ts); its bytes are carried as-is.
      const rendition = page.rendition ? { bytes: await readFile(page.rendition.imagePath), width: page.rendition.width, height: page.rendition.height } : undefined;
      if (rendition && input.rendition && rendition.bytes.length > input.rendition.maxBytes) throw new Error("OCR rendition grew past its cap");
      pages.push({ pageNumber: page.pageNumber, text: page.text, reader: page.recogniser, ...(rendition ? { rendition } : {}),
        ...(page.sourceWidth && page.sourceHeight ? { sourceWidth: page.sourceWidth, sourceHeight: page.sourceHeight } : {}) });
    }
    return {
      mode: outcome.mode,
      pages,
      chargedPages,
      truncatedFrames: outcome.truncatedFrames,
      unreadPages: outcome.unreadPages,
      escalation,
    };
  } finally {
    await outcome?.dispose();
  }
}

/** Hosted mode: the stored image, as uploaded, read by the hosted model. Anything needing host decoding is refused. */
async function hostedDocument(input: OcrDocumentInput): Promise<OcrDocumentResult> {
  const mimeType = (input.mimeType ?? "").toLowerCase();
  if (input.kind !== "image" || !HOSTED_OCR_MIME_TYPES.has(mimeType)) {
    console.error(`[ocr] hosted-refused document=${input.documentId} kind=${input.kind} mime=${mimeType || "unknown"}: hosted OCR sends stored PNG, JPEG or WebP only; nothing is rendered on the host`);
    throw new OcrRefusedError("DOCSLURP_OCR_MODE=hosted reads stored PNG, JPEG or WebP images only; this page would need host rendering", "hosted-format");
  }
  const size = (await lstat(input.source)).size;
  if (size > HOSTED_OCR_MAX_BYTES) throw new OcrRefusedError(`hosted OCR refuses images over ${HOSTED_OCR_MAX_BYTES} bytes`, "hosted-size");
  if (!input.hostedReader) throw new OcrRefusedError("DOCSLURP_OCR_MODE=hosted has no hosted reader here", "hosted-unavailable");
  try {
    const read = await input.hostedReader.read({ documentId: input.documentId, pageNumber: 1, imagePath: input.source, mimeType }, "hosted-ocr", input.signal);
    return { mode: "hosted", pages: [{ pageNumber: 1, text: read.text, reader: `hosted:${read.model}` }], chargedPages: [1], truncatedFrames: false, unreadPages: [], escalation: null };
  } catch (error) {
    if (error instanceof HostedOcrSkipped) throw new OcrRefusedError(`hosted OCR refused: ${error.message}`, `hosted-${error.reason}`);
    throw error;
  }
}
