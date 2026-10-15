import type { Stage } from "../pipeline/pipeline.js";
import {
  DocumentStageError,
  emitDocumentPageProgress,
  runDocumentStage,
  runDocuments,
} from "../pipeline/checkpoints.js";
import type { CommandRunner } from "../tools/runner.js";
import { type ArtifactStore } from "../tools/storage.js";
import { PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { readFile } from "node:fs/promises";
import { detectHtmlEmbeds } from "../routing/html-embeds.js";

export class ExtractHtmlStage implements Stage {
  readonly name = "extract-html";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly sources = new PdfSourceCache(storage),
  ) {}

  async run(
    state: import("../pipeline/pipeline.js").WorkflowState,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!state.run.pipeline.htmlExtraction) {
      return;
    }

    await runDocuments(
      state.documents,
      state.docConcurrency,
      async (document) => {
        const htmlKey = `${document.userId}/${state.run.id}/html/${document.id}.html`;
        const manifestKey = `${document.userId}/${state.run.id}/html/${document.id}.json`;
        const artifactSlot = `${document.id}:html`;

        console.log(
          `[extract-debug] stage=${this.name} document=${document.id} ` +
            `filename=${document.filename} pages=${document.pageCount}`,
        );

        await runDocumentStage(
          state,
          document,
          this.name,
          artifactSlot,
          "html extraction ready",
          async () => {
            const pageCount = Math.max(1, document.pageCount);

            if (document.mimeType === "text/html") {
              // H9: embedded / script-rendered content is not extracted; record it instead of dropping it silently.
              const source = await this.sources.get(document);
              const report = detectHtmlEmbeds(await readFile(source.path, "utf8"));
              const embedsKey = `${document.userId}/${state.run.id}/html/${document.id}.embeds.json`;
              if (report.needsAttention) {
                await this.storage.putJson(embedsKey, { documentId: document.id, ...report });
                state.artifactLedger.recordDocument(document.id, "html-embeds", this.storage.uri(embedsKey));
              }
              await emitDocumentPageProgress(state, document, this.name, pageCount, pageCount, "completed");
              console.log(
                `[extract-debug] document=${document.id} html-embeds=${JSON.stringify(report.counts)} needsAttention=${report.needsAttention}`,
              );
              return {
                ...(report.needsAttention ? { artifactUri: this.storage.uri(embedsKey) } : {}),
                stats: {
                  skipped: true,
                  reason: "html-source",
                  needsAttention: report.needsAttention,
                  embeddedContentNotExtracted: report.counts,
                  embeddedContentItems: report.items.length,
                },
              };
            }

            if (document.mimeType !== "application/pdf") {
              await emitDocumentPageProgress(
                state,
                document,
                this.name,
                pageCount,
                pageCount,
                "completed",
              );

              console.log(
                `[extract-debug] document=${document.id} skipped=non-pdf mimeType=${document.mimeType}`,
              );

              return {
                stats: {
                  skipped: true,
                  reason: "non-pdf",
                },
              };
            }

            await emitDocumentPageProgress(
              state,
              document,
              this.name,
              1,
              pageCount,
              "processing",
            );

            const cachedSource = await this.sources.get(document);
            const tempFile = cachedSource.path;

            let partialArtifactUri = "";
            let htmlUploaded = false;

            try {
              const plan = await this.runner.extractHtml(tempFile);
              console.log(
                `[extract-debug] document=${document.id} planAvailable=${plan.available} tool=${plan.binary}`,
              );

              const upload = this.storage.createMultipartUploadStream(
                htmlKey,
                "text/html; charset=utf-8",
              );
              try {
                await this.runner.runToWritable(plan, upload.writable, signal);
                await upload.done;
                htmlUploaded = true;
                partialArtifactUri = this.storage.uri(htmlKey);
                console.log(
                  `[extract-debug] document=${document.id} htmlUploaded=true uri=${partialArtifactUri}`,
                );
              } catch (error) {
                await upload.done.catch(() => undefined);
                throw error;
              }

              await this.storage.putJson(manifestKey, {
                documentId: document.id,
                mode: "layout-preserving",
                htmlArtifactUri: this.storage.uri(htmlKey),
                plan,
              });

              const manifestUri = this.storage.uri(manifestKey);
              state.artifactLedger.recordDocument(document.id, "html-manifest", manifestUri);

              await emitDocumentPageProgress(
                state,
                document,
                this.name,
                pageCount,
                pageCount,
                "completed",
              );

              console.log(
                `[extract-debug] document=${document.id} completed ` +
                  `artifactUri=${partialArtifactUri}`,
              );

              return {
                artifactUri: this.storage.uri(htmlKey),
                stats: {
                  mode: "layout-preserving",
                  sourceCacheHit: cachedSource.cacheHit,
                  manifestUri,
                },
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(
                `[extract-error] stage=${this.name} document=${document.id} ` +
                  `message=${message} htmlUploaded=${htmlUploaded} partialArtifact=${partialArtifactUri || "none"}`,
              );
              if (partialArtifactUri) {
                throw new DocumentStageError(message, {
                  artifactUri: partialArtifactUri,
                  stats: { failedAt: "extract-html", htmlUploaded, error: message },
                });
              }
              throw error;
            }
          },
          signal,
        );
      },
    );
  }
}
