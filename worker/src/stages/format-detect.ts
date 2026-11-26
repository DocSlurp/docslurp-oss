import { firstPassDefersPageCount } from "../pipeline/first-pass.js";
import type { Document } from "../models.js";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { cleanupTempFile, type ArtifactStore } from "../tools/storage.js";
import { readSourceBytes, stageSourceFile } from "../sandbox/source-integrity.js";
import type { CommandRunner } from "../tools/runner.js";
import { recordMeasuredPdfPageCount } from "../lib/pdf-page-count.js";
import { hostTextEvidenceOfFile, recordMeasuredTextPageCount, TEXT_MEASURE_MAX_BYTES, TextPageCountUnavailableError } from "../lib/text-page-count.js";
import { inspectTextPages, type TextPagesInspection, type TextPagesRequest } from "../lib/text-pages-guest.js";
import { inspectQuarantine, type QuarantinePolicy } from "../lib/quarantine.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { detectDocumentFormat } from "../lib/document-format.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { resolvePdfMode } from "@docslurp/shared";
import { sniffedPdf } from "../lib/sniffed-pdf.js";


export class FormatDetectStage implements Stage {
  readonly name = "format-detect";

  constructor(
    private readonly storage: ArtifactStore,
    private readonly runner?: Pick<CommandRunner, "pdfPageCount" | "pdfPopplerAcceptance" | "run">,
    /** The quarantine inspection's limits, for the rare re-inspection that only wants its text answer. */
    private readonly config?: QuarantinePolicy,
  ) {}

  /**
   * The text answer for a document quarantine did not count. Under the VM-only floor: the same in-VM inspection on the
   * hash-verified staged source, its count bounded by this host's byte facts of that file; never a host decode. In
   * development: the shared rule in-process.
   */
  private async measureText(document: Document, request: TextPagesRequest, signal?: AbortSignal): Promise<TextPagesInspection | null | undefined> {
    if (!vmOnlyParsing()) {
      const bytes = await readSourceBytes(this.storage, document, { maxBytes: TEXT_MEASURE_MAX_BYTES });
      if (bytes.length > TEXT_MEASURE_MAX_BYTES) throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
      const encoding = document.fileFacts?.encoding ?? null;
      return inspectTextPages(bytes, { mimeType: document.fileFacts?.sniffedMimeType ?? null, encoding }, request);
    }
    if (!this.runner || !this.config) throw new TextPageCountUnavailableError("text page count unavailable: no parser VM runner is configured, so no host decoder runs");
    const temp = await stageSourceFile(this.storage, document, trustedTempDownloadPattern("docslurp-text-pages-", document), { maxBytes: TEXT_MEASURE_MAX_BYTES });
    try {
      const evidence = await hostTextEvidenceOfFile(temp);
      const inspection = await inspectQuarantine({
        bytes: Buffer.alloc(0), filename: document.filename, tempFile: temp, runner: this.runner as CommandRunner, policy: this.config,
        text: request, textEvidence: evidence, ...(signal ? { signal } : {}),
      });
      return inspection.text;
    } finally {
      await cleanupTempFile(temp);
    }
  }

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    for (const document of healthyDocuments(state)) {
      const key = `${runArtifactRoot(state.run, document.userId)}/format-detect/${document.id}.json`;
      const artifactSlot = `${document.id}:format-detect`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "format detected",
        async () => {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
          }

          const { format: normalizedFormat, detectedBy } = detectDocumentFormat(document);

          await this.storage.putJson(key, {
            documentId: document.id,
            filename: document.filename,
            declaredMimeType: document.mimeType,
            normalizedFormat,
            detectedBy,
            fileFacts: document.fileFacts ?? null,
          });

          state.artifactLedger.recordDocument(document.id, "normalizedFormat", normalizedFormat);
          // With no PDF mode (neither a VM provider nor customer-owned local mode) extraction refuses every PDF: refuse it here,
          // before split-pages, render-images, routing evidence or any other stage runs host Poppler on its bytes.
          if (sniffedPdf(document) && resolvePdfMode(process.env) === "off") {
            console.error(`[format-detect] refused document=${document.id}: a PDF with no PDF mode configured (DOCSLURP_PDF_MODE); no host parser runs`);
            throw new Error("PDF extraction unavailable: no PDF mode is configured (DOCSLURP_PDF_MODE), so this PDF is refused before any parser runs");
          }
          // A PDF's page count from intake is an estimate (the API never parses it): measure it in the PDF boundary now,
          // before any stage uses it or anything bills.
          let temp: string | null = null;
          const pdfPages = this.runner ? await recordMeasuredPdfPageCount({
            state, document, runner: this.runner, signal, deferToFirstPass: firstPassDefersPageCount(state, document),
            // Hash-bound like every parser read (council R7-L2): bytes that are not the decided parse source are refused.
            sourcePath: async () => (temp ??= await stageSourceFile(this.storage, document, trustedTempDownloadPattern("docslurp-pdf-pages-", document))),
          }).finally(async () => { if (temp) await cleanupTempFile(temp); }) : null;
          // A text file quarantine's inspection did not count (quarantine off in development, a checkpoint from an older
          // build, HTML recognised only by that inspection): the text rule over the whole text, in the parser VM under the
          // VM-only floor, in-process only in development. Rare: quarantine counts every other one in the inspection it runs.
          const textPages = await recordMeasuredTextPageCount({
            state, document, format: normalizedFormat,
            measure: (request) => this.measureText(document, request, signal),
          });
          // Every attempt, including a retry that finds the measurement already persisted: authorize the measured pages above
          // what admission priced, from durable state (intake_page_count), before any later stage runs.
          await state.pageBasis.authorize(document);

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              normalizedFormat,
              detectedBy,
              mimeVerdict: document.fileFacts?.mismatch ?? null,
              ...(pdfPages ? { pdfPages: pdfPages.pages, pdfPagesEstimate: pdfPages.estimate, pdfPagesMethod: pdfPages.method } : {}),
              ...(textPages ? { textPages: textPages.pages, textPagesEstimate: textPages.estimate } : {}),
            },
          };
        },
        signal
      );
    }
  }
}
