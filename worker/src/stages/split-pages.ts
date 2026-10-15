import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments, skipCompletedPages, completeDocumentPages } from "../pipeline/checkpoints.js";
import { PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import type { ArtifactStore } from "../tools/storage.js";
import { maxInt } from "./utils.js";

/**
 * Builds a reusable virtual-page index without eagerly writing N single-page
 * PDFs. Consumers that truly need page files can materialize selected ranges.
 */
export class SplitPagesStage implements Stage {
  readonly name = "split-pages";

  constructor(
    private readonly sources: PdfSourceCache,
    private readonly storage: ArtifactStore,
  ) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    let pagesTotal = 0;

    await runDocuments(state.documents, state.docConcurrency, async (document) => {
      const pageCount = maxInt(1, document.pageCount);
      pagesTotal += pageCount;
      const key = `${document.userId}/${state.run.id}/pages/${document.id}/manifest.json`;
      const artifactSlot = `${document.id}:pages`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "virtual page index ready",
        async () => {
          if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
          const allPages = Array.from({ length: pageCount }, (_, index) => index + 1);
          const completedPages = state.store
            ? await state.store.getCompletedPages(state.run.id, document.id, this.name)
            : new Set<number>();
          const remaining = skipCompletedPages(completedPages, allPages);
          const source = await this.sources.get(document);

          await this.storage.putJson(key, {
            documentId: document.id,
            mode: "virtual-page-index",
            pageCount,
            source: {
              sourceKey: document.sourceKey,
              sha256: source.sha256,
              sizeBytes: source.sizeBytes,
              cacheHit: source.cacheHit,
            },
            pages: allPages.map((pageNumber) => ({
              pageNumber,
              materialization: "on-demand",
            })),
            resumedFrom: completedPages.size > 0 ? completedPages.size : undefined,
          });

          await completeDocumentPages(state, document, this.name, remaining, pageCount, false);

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              mode: "virtual-page-index",
              pageCount,
              sourceCacheHit: source.cacheHit,
              sourceBytes: source.sizeBytes,
              skippedPages: completedPages.size,
              processedPages: remaining.length,
            },
          };
        },
        signal,
      );
    });

    state.run.pagesTotal = pagesTotal;
  }
}
