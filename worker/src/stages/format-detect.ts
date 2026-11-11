import { firstPassDefersPageCount } from "../pipeline/first-pass.js";
import type { Document } from "../models.js";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { cleanupTempFile, sourceStorageKey, type ArtifactStore } from "../tools/storage.js";
import type { CommandRunner } from "../tools/runner.js";
import { recordMeasuredPdfPageCount } from "../lib/pdf-page-count.js";
import { recordMeasuredTextPageCount } from "../lib/text-page-count.js";
import { authorizeMeasuredPages } from "../lib/measured-page-authorization.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { detectFileFormat, resolvePdfMode, type NormalizedFormat } from "@docslurp/shared";
import { sniffedPdf } from "../lib/sniffed-pdf.js";

/**
 * The format intake persisted from the sniffed bytes (documents.file_facts) when there is one; otherwise the stored MIME type
 * and extension, for documents ingested before intake sniffed.
 */
function detectFormat(document: Document): { format: NormalizedFormat; detectedBy: "intake-file-facts" | "mime-and-extension" } {
  const persisted = document.fileFacts?.format;
  if (persisted && persisted !== "unknown") return { format: persisted, detectedBy: "intake-file-facts" };
  return { format: detectFileFormat({ filename: document.filename, mimeType: document.mimeType }), detectedBy: "mime-and-extension" };
}

export class FormatDetectStage implements Stage {
  readonly name = "format-detect";

  constructor(private readonly storage: ArtifactStore, private readonly runner?: Pick<CommandRunner, "pdfPageCount" | "pdfPopplerAcceptance" | "run">) {}

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

          const { format: normalizedFormat, detectedBy } = detectFormat(document);

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
            sourcePath: async () => (temp ??= await this.storage.downloadSourceToTempFile(sourceStorageKey(document.sourceKey), trustedTempDownloadPattern("docslurp-pdf-pages-", document))),
          }).finally(async () => { if (temp) await cleanupTempFile(temp); }) : null;
          // A text file intake could not count in full (sampled over 2 MB, or no evidence): the same text rule over the whole text.
          const textPages = await recordMeasuredTextPageCount({
            state, document, format: normalizedFormat,
            readSource: (maxBytes) => this.storage.getBytes(sourceStorageKey(document.sourceKey), { maxBytes }),
          });
          // Every attempt, including a retry that finds the measurement already persisted: authorize the measured pages above
          // what admission priced, from durable state (intake_page_count), before any later stage runs.
          await authorizeMeasuredPages(state, document);

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
