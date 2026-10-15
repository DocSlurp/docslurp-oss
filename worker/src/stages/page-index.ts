import { splitTextIntoPages } from "@docslurp/shared";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { extractTextForEmbedding, estimateTokens } from "./embedding-runtime.js";
import { indexableDocuments } from "../pipeline/pii-gate.js";

export function buildPageIndexSearchMetadata(pageCount: number): {
  mode: "page-index";
  searchablePages: number;
  fullyIndexed: false;
} {
  return {
    mode: "page-index",
    searchablePages: pageCount,
    fullyIndexed: false
  };
}

export class PageIndexStage implements Stage {
  readonly name = "page-index";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    if (!state.run.pipeline.pageIndex) {
      return;
    }

    await runDocuments(indexableDocuments(state), state.docConcurrency, async (document) => {
      const artifactSlot = `${document.id}:page-index`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "page index ready",
        async () => {
          const extracted = await extractTextForEmbedding(
            document,
            this.runner,
            this.storage,
            state.artifactLedger.readDocument(document.id, "markdown"),
            signal
          );
          const pageTexts = splitByPages(extracted.text, document.pageCount);

          const pageRows: Array<{
            id: string;
            documentId: string;
            runId: string;
            userId: string;
            pageNumber: number;
            text: string;
            tokenEstimate: number;
          }> = pageTexts.map((text, i) => ({
            id: `${document.id}-page-${(i + 1).toString().padStart(4, "0")}`,
            documentId: document.id,
            runId: state.run.id,
            userId: document.userId,
            pageNumber: i + 1,
            text,
            tokenEstimate: estimateTokens(text),
          }));

          if (state.store && "insertPages" in state.store) {
            await (state.store as { insertPages: (pages: typeof pageRows) => Promise<void> }).insertPages(pageRows);
          }

          if (state.store && "linkChunksToPages" in state.store) {
            await (state.store as { linkChunksToPages: (documentId: string, runId: string) => Promise<void> }).linkChunksToPages(document.id, state.run.id);
          }

          const key = `${document.userId}/${state.run.id}/page-index/${document.id}.json`;
          const search = buildPageIndexSearchMetadata(pageRows.length);
          await this.storage.putJson(key, {
            documentId: document.id,
            pages: pageRows.length,
            search
          });

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              pages: pageRows.length,
              search
            },
          };
        },
        signal
      );
    });
  }
}

function splitByPages(text: string, pageCount: number): string[] {
  const pages = splitTextIntoPages(text, pageCount);
  return pages.length > 0 ? pages : [text];
}
