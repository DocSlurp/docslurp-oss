import type { PerformanceEvent } from "../models.js";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments, } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { resolveNativePdfEngine } from "../native-pdf/engine.js";
import type { CommandRunner, CommandPlan } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { maxInt } from "./utils.js";
import { runArtifactRoot } from "../lib/artifact-root.js";

export class PdfToolingStage implements Stage {
  readonly name = "pdf-tooling";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore
  ) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    await runDocuments(healthyDocuments(state), state.docConcurrency, async (document) => {
      const key = `${runArtifactRoot(state.run, document.userId)}/pdf-tooling/${document.id}.json`;
      const artifactSlot = `${document.id}:pdf-tooling`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "pdf tooling manifest ready",
        async () => {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
          }

          const startedAt = Date.now();
          const toolchains = await this.buildToolchains(document, state.run.id);
          const { availableCommands, totalCommands } = commandAvailability(toolchains);
          const pageCount = maxInt(1, document.pageCount);

          // Table policy is decided after extraction evidence exists. Running
          // pdftohtml here used to force an unconditional full-document pass.
          const tableDetection = {
            status: "deferred-to-page-triage",
            hasTablePages: null,
            tablePageCount: null,
          } as const;
          const recommendedExtractor = "policy-selected";

          await this.storage.putJson(key, {
            documentId: document.id,
            source: {
              mimeType: document.mimeType,
              sourceKey: document.sourceKey,
              pageCount,
              pageImagesKey: `${runArtifactRoot(state.run, document.userId)}/images/${document.id}/manifest.json`,
              pageManifestKey: `${runArtifactRoot(state.run, document.userId)}/pages/${document.id}/manifest.json`
            },
            tableDetection: {
              hasTablePages: tableDetection.hasTablePages,
              tablePageCount: tableDetection.tablePageCount,
              recommendedExtractor
            },
            profiles: [
              {
                id: "fast-text-layer",
                summary: "Prefer native PDF text-layer tools for born-digital files.",
                tools: ["pdfinfo", "pdftotext", "pdftohtml", "native-pdf"]
              },
              {
                id: "layout-aware-markdown",
                summary: "Use layout-preserving extractors when markdown fidelity matters.",
                tools: ["native-pdf", "unstructured"]
              },
              {
                id: "ocr-rescue",
                summary: "Escalate to OCR only for scans, faxed pages, or broken text layers.",
                tools: ["ocrmypdf", "native-pdf-ocr", "unstructured-hi-res", "florence-2"]
              },
              {
                id: "cheap-local-multimodal",
                summary: "Use rendered page images plus local models for triage before hosted vision LLMs.",
                tools: ["transformers.js-clip", "florence-2", "vision-llm"]
              }
            ],
            toolchains,
            availableCommands,
            totalCommands
          });

          const durationMs = Date.now() - startedAt;
          pushPerformanceEvents(state.pendingPerformance, {
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "pdf-command-availability",
            value: availableCommands,
            unit: "command",
            tags: ["document", "pdf", "availability"],
            metadata: {
              totalCommands,
              artifact: this.storage.uri(key)
            }
          });
          pushPerformanceEvents(state.pendingPerformance, {
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "pdf-toolchain-count",
            value: toolchains.length,
            unit: "toolchain",
            tags: ["document", "pdf", "inventory"],
            metadata: {
              availableCommands
            }
          });
          pushPerformanceEvents(state.pendingPerformance, {
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "manifest-build-duration",
            value: durationMs,
            unit: "ms",
            tags: ["document", "pdf", "latency"],
            metadata: {
              availableCommands,
              totalCommands
            }
          });

          pushPerformanceEvents(state.pendingPerformance, {
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "table-page-count",
            value: tableDetection.tablePageCount ?? 0,
            unit: "page",
            tags: ["document", "table", "detection"],
            metadata: {
              status: tableDetection.status,
              hasTablePages: tableDetection.hasTablePages,
              recommendedExtractor,
            }
          });

          const perPageDuration = durationMs / pageCount;
          for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            pushPerformanceEvents(state.pendingPerformance, {
              documentId: document.id,
              scope: "page",
              stageName: this.name,
              metric: "manifest-build-duration-share",
              pageNumber,
              value: perPageDuration,
              unit: "ms",
              tags: ["page", "pdf", "latency"],
              metadata: {
                availableCommands,
                totalCommands,
                pageCount
              }
            });
            pushPerformanceEvents(state.pendingPerformance, {
              documentId: document.id,
              scope: "page",
              stageName: this.name,
              metric: "page-command-availability",
              pageNumber,
              value: availableCommands,
              unit: "command",
              tags: ["page", "pdf", "availability"],
              metadata: {
                totalCommands,
                pageCount
              }
            });
          }

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              availableCommands,
              totalCommands,
              pageCount
            }
          };
        },
        signal
      );
    });
  }

  /** The in-process native-pdf engine as a command plan: available when the private binding loads. */
  private async nativePdfPlan(): Promise<CommandPlan> {
    const engine = await resolveNativePdfEngine(this.runner);
    return { binary: "in-process:native-pdf", args: [], available: engine !== null };
  }

  private async buildToolchains(document: import("../models.js").Document, runId: string): Promise<ToolchainManifest[]> {
    const [
      pdfInfo,
      extractText,
      extractHtml,
      extractImages,
      splitPages,
      renderImages,
      ocrPdf,
      unstructuredFast,
      unstructuredHiRes,
      nativePdf,
      unpdfExtract,
      transformersJsClip,
      florence2
    ] = await Promise.all([
      this.runner.pdfInfo(document.sourceKey),
      this.runner.extractText(document.sourceKey),
      this.runner.extractHtml(document.sourceKey),
      this.runner.extractImages(document.sourceKey, "page"),
      this.runner.splitPages(document.sourceKey, "page-%d.pdf"),
      this.runner.renderPageImages(document.sourceKey, "page"),
      this.runner.ocrPdf(document.sourceKey, "ocr-output.pdf"),
      this.runner.unstructuredPartition(document.sourceKey, "unstructured-fast.json", "fast"),
      this.runner.unstructuredPartition(document.sourceKey, "unstructured-hi-res.json", "hi_res"),
      this.nativePdfPlan(),
      this.runner.unpdfExtract(document.sourceKey, "unpdf.json"),
      this.runner.transformersJsClip(
        "page-1.png",
        "clip.json",
        "document,text-heavy,table-heavy,form,photo,scan"
      ),
      this.runner.florence2("page-1.png", "florence2.json", "<OCR>")
    ]);

    return [
      {
        id: "poppler-utils",
        tier: "cheap-fast",
        kind: "native-cli",
        bestFor: ["born-digital PDFs", "page splitting", "text-layer extraction", "page rendering"],
        tradeoffs: ["weak OCR", "limited semantic markdown"],
        commands: {
          pdfinfo: pdfInfo,
          pdftotext: extractText,
          pdftohtml: extractHtml,
          pdfimages: extractImages,
          pdfseparate: splitPages,
          pdftoppm: renderImages
        }
      },
      {
        id: "ocrmypdf",
        tier: "scan-rescue",
        kind: "native-cli",
        bestFor: ["repairing scanned PDFs", "adding searchable text layers"],
        tradeoffs: ["slower than text-layer extraction", "depends on OCR runtime and language packs"],
        commands: {
          ocrmypdf: ocrPdf
        }
      },
      {
        id: "unstructured",
        tier: "layout-ocr",
        kind: "python-wrapper",
        bestFor: ["element-level extraction", "tables", "OCR-aware partitioning"],
        tradeoffs: ["heavier dependency set", "slower than poppler on clean PDFs"],
        commands: {
          "partition-fast": unstructuredFast,
          "partition-hi-res": unstructuredHiRes
        }
      },
      {
        id: "native-pdf",
        tier: "cheap-layout",
        kind: "in-process",
        bestFor: ["per-page Markdown with tables, links and image placements", "reading-order repair on multi-column pages", "in-process page rendering and OCR fill"],
        tradeoffs: ["private optional engine (DOCSLURP_NATIVE_PDF=1 images); unavailable in the public tree, which falls back to Kreuzberg and Poppler", "documents past its page limit fall back to Kreuzberg"],
        commands: {
          markdown: nativePdf,
          text: nativePdf,
          render: nativePdf
        }
      },
      {
        id: "unpdf",
        tier: "cheap-js",
        kind: "node-wrapper",
        bestFor: ["JS-only deployments", "quick text extraction without Python"],
        tradeoffs: ["smaller ecosystem than Python PDF stacks", "less capable on scans without extra OCR"],
        commands: {
          extract: unpdfExtract
        }
      },
      {
        id: "transformers.js-clip",
        tier: "cheap-vision-triage",
        kind: "node-wrapper",
        bestFor: ["local page-image triage", "document routing", "figure detection heuristics"],
        tradeoffs: ["works on rendered page images, not PDFs directly", "classification only unless paired with another extractor"],
        commands: {
          classify: transformersJsClip
        }
      },
      {
        id: "florence-2",
        tier: "local-vlm",
        kind: "python-wrapper",
        bestFor: ["OCR-style prompting", "captioning", "page-level vision extraction"],
        tradeoffs: ["slower and heavier than CLIP", "best used on rendered pages after cheap extraction fails"],
        commands: {
          "ocr-prompt": florence2
        }
      }
    ];
  }
}

interface ToolchainManifest {
  id: string;
  tier: string;
  kind: string;
  bestFor: string[];
  tradeoffs: string[];
  commands: Record<string, CommandPlan>;
}

function commandAvailability(toolchains: ToolchainManifest[]) {
  let availableCommands = 0;
  let totalCommands = 0;

  for (const toolchain of toolchains) {
    for (const plan of Object.values(toolchain.commands)) {
      totalCommands += 1;
      if (plan.available) {
        availableCommands += 1;
      }
    }
  }

  return { availableCommands, totalCommands };
}

function pushPerformanceEvents(events: PerformanceEvent[], event: PerformanceEvent) {
  events.push(event);
}
