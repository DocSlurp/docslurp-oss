import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

export class FormatToolingStage implements Stage {
  readonly name = "format-tooling";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore
  ) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    await runDocuments(state.documents, state.docConcurrency, async (document) => {
      const normalizedFormat = state.artifactLedger.readDocument(document.id, "normalizedFormat") ?? "unknown";
      const key = `${document.userId}/${state.run.id}/format-tooling/${document.id}.json`;
      const artifactSlot = `${document.id}:format-tooling`;

      await runDocumentStage(state, document, this.name, artifactSlot, "format toolchain manifest ready", async () => {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");

        const toolchains = await this.buildFormatToolchains(normalizedFormat, document.sourceKey);
        const available = toolchains.filter(t => t.available).length;
        const total = toolchains.length;

        await this.storage.putJson(key, {
          documentId: document.id,
          normalizedFormat,
          toolchains,
          availableTools: available,
          totalTools: total
        });

        state.artifactLedger.recordDocument(document.id, "format-tooling", this.storage.uri(key));

        return {
          artifactUri: this.storage.uri(key),
          stats: { normalizedFormat, availableTools: available, totalTools: total }
        };
      }, signal);
    });
  }

  private async buildFormatToolchains(
    format: string,
    sourceKey: string
  ): Promise<Array<{ tool: string; available: boolean; profile: string }>> {
    const checks: Array<{ tool: string; profile: string; plan: () => Promise<{ available: boolean }> }> = [];

    if (format === "pdf") {
      checks.push(
        { tool: "pdftotext", profile: "fast-text-layer", plan: () => this.runner.extractText(sourceKey) },
        { tool: "pdftohtml", profile: "fast-text-layer", plan: () => this.runner.extractHtml(sourceKey) },
        { tool: "pymupdf", profile: "layout-aware-markdown", plan: () => this.runner.pyMuPdfText(sourceKey, "out.txt") },
        { tool: "docling", profile: "layout-aware-markdown", plan: () => this.runner.doclingMarkdown(sourceKey, ".") },
        { tool: "ocrmypdf", profile: "ocr-rescue", plan: () => this.runner.ocrPdf(sourceKey, "out.pdf") }
      );
    } else if (format === "office-word" || format === "office-other") {
      checks.push(
        { tool: "mammoth", profile: "fast", plan: () => this.runner.mammothMarkdown(sourceKey, "out.json") },
        { tool: "soffice", profile: "fallback", plan: () => this.runner.officeToPdf(sourceKey, ".") },
        { tool: "catdoc", profile: "legacy-doc", plan: () => this.runner.docToText(sourceKey) },
        { tool: "unrtf", profile: "rtf", plan: () => this.runner.rtfToHtml(sourceKey) }
      );
    } else if (format === "office-excel") {
      checks.push(
        { tool: "xlsx2csv", profile: "fast", plan: () => this.runner.xlsxToCsv(sourceKey, "out.csv") },
        { tool: "openpyxl", profile: "python", plan: () => this.runner.xlsxExtractPy(sourceKey, "out.json") }
      );
    } else if (format === "office-pptx") {
      checks.push(
        { tool: "python-pptx", profile: "fast", plan: () => this.runner.pptxExtract(sourceKey, "out.json") },
        { tool: "soffice", profile: "fallback", plan: () => this.runner.officeToPdf(sourceKey, ".") }
      );
    } else if (format === "html") {
      checks.push(
        { tool: "trafilatura", profile: "fast", plan: () => this.runner.trafilaturaExtract(sourceKey, "out.json") }
      );
    } else if (format === "epub") {
      checks.push(
        { tool: "ebooklib", profile: "fast", plan: () => this.runner.epubExtract(sourceKey, "out.json") }
      );
    } else if (format === "latex") {
      checks.push(
        { tool: "pandoc", profile: "fast", plan: () => this.runner.latexToMarkdown(sourceKey) }
      );
    } else if (format === "image") {
      checks.push(
        { tool: "tesseract", profile: "ocr", plan: () => this.runner.tesseractOcr(sourceKey, "out") },
        { tool: "tiffcp", profile: "tiff-split", plan: () => this.runner.tiffSplit(sourceKey, "page-%04d.tiff") }
      );
    } else if (format === "structured-json" || format === "structured-csv" || format === "markdown" || format === "plain-text") {
      checks.push(
        { tool: "native-passthrough", profile: "fast", plan: async () => ({ available: true }) }
      );
    }

    const results = await Promise.all(checks.map(async (c) => {
      try {
        const plan = await c.plan();
        return { tool: c.tool, available: plan.available, profile: c.profile };
      } catch {
        return { tool: c.tool, available: false, profile: c.profile };
      }
    }));

    return results;
  }
}
