import path from "node:path";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";

type CanonicalStrategy =
  | "already-pdf"
  | "passthrough"
  | "trafilatura-extract"
  | "office-to-pdf"
  | "pptx-extract"
  | "structured-passthrough"
  | "json-extract"
  | "epub-extract"
  | "latex-to-markdown"
  | "mammoth-markdown"
  | "xlsx-to-csv"
  | "rtf-to-html"
  | "doc-to-text"
  | "tesseract-ocr"
  | "tiff-split-ocr"
  | "passthrough-unsupported"
  | "passthrough-unknown";

function pickStrategy(normalizedFormat: string): CanonicalStrategy {
  switch (normalizedFormat) {
    case "pdf":
      return "already-pdf";
    case "markdown":
    case "plain-text":
      return "passthrough";
    case "html":
      return "trafilatura-extract";
    case "office-word":
      return "mammoth-markdown";
    case "office-excel":
      return "xlsx-to-csv";
    case "office-other":
      return "office-to-pdf";
    case "office-pptx":
      return "pptx-extract";
    case "structured-csv":
      return "structured-passthrough";
    case "structured-json":
      return "json-extract";
    case "epub":
      return "epub-extract";
    case "latex":
      return "latex-to-markdown";
    case "image":
      return "tesseract-ocr";
    default:
      return "passthrough-unknown";
  }
}

export class ToCanonicalStage implements Stage {
  readonly name = "to-canonical";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore
  ) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    for (const document of healthyDocuments(state)) {
      const key = `${runArtifactRoot(state.run, document.userId)}/to-canonical/${document.id}.json`;
      const artifactSlot = `${document.id}:to-canonical`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "canonical form resolved",
        async () => {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
          }

          const normalizedFormat = state.artifactLedger.readDocument(document.id, "normalizedFormat") ?? "unknown";
          let strategy = pickStrategy(normalizedFormat);

          const ext = path.extname(document.filename).toLowerCase();
          if (strategy === "office-to-pdf" && normalizedFormat === "office-other") {
            if (ext === ".rtf") strategy = "rtf-to-html";
            else if (ext === ".doc") strategy = "doc-to-text";
          }
          if (strategy === "tesseract-ocr" && (ext === ".tiff" || ext === ".tif")) {
            strategy = "tiff-split-ocr";
          }

          const artifact: Record<string, unknown> = {
            documentId: document.id,
            normalizedFormat,
            strategy,
          };

          if (strategy === "already-pdf") {
            artifact.canonicalKey = document.sourceKey;
          } else if (strategy === "office-to-pdf") {
            const plan = await this.runner.officeToPdf(document.sourceKey, ".");
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
          } else if (strategy === "trafilatura-extract") {
            const output = `${document.sourceKey}.trafilatura.json`;
            const plan = await this.runner.trafilaturaExtract(document.sourceKey, output);
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
          } else if (strategy === "latex-to-markdown") {
            const plan = await this.runner.latexToMarkdown(document.sourceKey);
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
          } else if (strategy === "epub-extract") {
            const output = `${document.sourceKey}.epub.json`;
            const plan = await this.runner.epubExtract(document.sourceKey, output);
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
          } else if (strategy === "pptx-extract") {
            const output = `${document.sourceKey}.pptx.json`;
            const plan = await this.runner.pptxExtract(document.sourceKey, output);
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
          } else if (strategy === "mammoth-markdown") {
            const output = `${document.sourceKey}.mammoth.json`;
            const primaryPlan = await this.runner.mammothMarkdown(document.sourceKey, output);
            const fallbackPlan = await this.runner.officeToPdf(document.sourceKey, ".");
            artifact.plan = {
              binary: primaryPlan.binary,
              args: primaryPlan.args,
              available: primaryPlan.available,
            };
            artifact.fallbackPlan = {
              binary: fallbackPlan.binary,
              args: fallbackPlan.args,
              available: fallbackPlan.available,
            };
          } else if (strategy === "xlsx-to-csv") {
            const output = `${document.sourceKey}.xlsx-csv`;
            const primaryPlan = await this.runner.xlsxToCsv(document.sourceKey, output);
            const fallbackPlan = await this.runner.xlsxExtractPy(document.sourceKey, `${document.sourceKey}.xlsx.json`);
            artifact.plan = {
              binary: primaryPlan.binary,
              args: primaryPlan.args,
              available: primaryPlan.available,
            };
            artifact.fallbackPlan = {
              binary: fallbackPlan.binary,
              args: fallbackPlan.args,
              available: fallbackPlan.available,
            };
          } else if (strategy === "rtf-to-html") {
            const plan = await this.runner.rtfToHtml(document.sourceKey);
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
          } else if (strategy === "doc-to-text") {
            const plan = await this.runner.docToText(document.sourceKey);
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
          } else if (strategy === "json-extract") {
            const output = `${document.sourceKey}.json-extract.json`;
            const plan = await this.runner.jsonExtract(document.sourceKey, output);
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
            artifact.outputKey = output;
          } else if (strategy === "tiff-split-ocr") {
            const splitPlan = await this.runner.tiffSplit(document.sourceKey, "page-%04d.tiff");
            const ocrPlan = await this.runner.tesseractOcr("page-0001.tiff", "ocr-output");
            artifact.splitPlan = { binary: splitPlan.binary, args: splitPlan.args, available: splitPlan.available };
            artifact.ocrPlan = { binary: ocrPlan.binary, args: ocrPlan.args, available: ocrPlan.available };
          } else if (strategy === "tesseract-ocr") {
            const plan = await this.runner.tesseractOcr(document.sourceKey, "ocr-output");
            artifact.plan = {
              binary: plan.binary,
              args: plan.args,
              available: plan.available,
            };
          }

          await this.storage.putJson(key, artifact);

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              strategy,
              normalizedFormat,
            },
          };
        },
        signal
      );
    }
  }
}
