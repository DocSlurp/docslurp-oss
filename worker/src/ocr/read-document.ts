/*
 * OCR of one document's pages for a pipeline stage: the configured boundary's read (engine.ts), billed per page
 * (ledger.ts), then the escalation reads (escalation.ts). In `hosted` mode, a stored image's bytes go to the hosted reader
 * as uploaded. Every refusal throws; the caller fails the page or document and never substitutes another reader.
 */
import { lstat } from "node:fs/promises";

import type { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import { readWithOcr, type OcrReadOutcome } from "./engine.js";
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
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface OcrDocumentPage {
  pageNumber: number;
  text: string;
  reader: string;
}

export interface OcrDocumentResult {
  mode: "vm" | "local" | "hosted";
  pages: OcrDocumentPage[];
  /** Pages charged as Rich reads by this call. */
  chargedPages: number[];
  truncatedFrames: boolean;
  escalation: EscalationSummary | null;
}

export async function ocrDocument(input: OcrDocumentInput): Promise<OcrDocumentResult> {
  const env = input.env ?? process.env;
  const mode = resolveOcrMode(env);
  if (mode === "off") throw new OcrRefusedError("OCR is off (DOCSLURP_OCR_MODE=off)", "off");
  if (mode === "hosted") return await hostedDocument(input);
  let outcome: OcrReadOutcome | null = null;
  try {
    outcome = await readWithOcr(input.runner, {
      source: input.source,
      kind: input.kind,
      ...(input.pages ? { pages: input.pages } : {}),
      ...(input.languageSetting ? { languageSetting: input.languageSetting } : {}),
      escalation: Boolean(input.hostedReader) && ocrEscalationEnabled(env),
      ...(input.signal ? { signal: input.signal } : {}),
      env,
    });
    // An image with more frames than one file may hold is refused before anything is charged: reading its first frames would
    // publish part of it under a bill that claims the whole file.
    if (input.kind === "image" && outcome.truncatedFrames) throw imageTooManyFramesError(input.documentId);
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
    return {
      mode: outcome.mode,
      pages: outcome.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text, reader: page.recogniser })),
      chargedPages,
      truncatedFrames: outcome.truncatedFrames,
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
    return { mode: "hosted", pages: [{ pageNumber: 1, text: read.text, reader: `hosted:${read.model}` }], chargedPages: [1], truncatedFrames: false, escalation: null };
  } catch (error) {
    if (error instanceof HostedOcrSkipped) throw new OcrRefusedError(`hosted OCR refused: ${error.message}`, `hosted-${error.reason}`);
    throw error;
  }
}
