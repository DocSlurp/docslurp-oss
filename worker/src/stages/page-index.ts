import type { Sql } from "postgres";
import { deferredProfilesEnabled, splitTextIntoPages } from "@docslurp/shared";
import { ensurePageRows } from "../deferred/page-ledger.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { extractTextForEmbedding, estimateTokens } from "./embedding-runtime.js";
import { indexableDocuments } from "../pipeline/pii-gate.js";
import { runArtifactRoot } from "../lib/artifact-root.js";

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
    private readonly storage: ArtifactStore,
    private readonly sql?: () => Sql<Record<string, unknown>>
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
            signal,
            state.artifactLedger.readDocument(document.id, "canonical-document"),
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

          if (this.sql && deferredProfilesEnabled()) {
            await markPagesIngestedIfDeferred(this.sql(), document.id, pageRows.length, state.run.kind === "full-index" ? "full-index" : "ingest");
          }

          const key = `${runArtifactRoot(state.run, document.userId)}/page-index/${document.id}.json`;
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

/**
 * Ledger rows exist only for documents that defer indexing (`indexing_mode <> 'full'`): readers treat a
 * `full` document as hot without consulting the ledger, so full-index runs of deferred documents
 * (which produce new `full` versions) and ordinary uploads write nothing here.
 */
export async function markPagesIngestedIfDeferred(sql: Sql<Record<string, unknown>>, documentId: string, pageCount: number, materializedBy: "ingest" | "full-index" = "ingest"): Promise<boolean> {
  const [row] = await sql<{ deferred: boolean }[]>`select indexing_mode <> 'full' as deferred from documents where id = ${documentId}`;
  if (!row?.deferred) return false;
  await markPagesIngested(sql, documentId, pageCount, materializedBy);
  return true;
}

/**
 * Pages written by the ingest pipeline are searchable, so the deferred-indexing
 * ledger records them as `indexed` and a query never re-materializes them.
 * `materialized_by` follows the run kind: 'full-index' for full-index runs, else 'ingest'.
 * Never touches `blocked-pii` pages or pages under a live claim.
 */
export async function markPagesIngested(sql: Sql<Record<string, unknown>>, documentId: string, pageCount: number, materializedBy: "ingest" | "full-index" = "ingest"): Promise<void> {
  await ensurePageRows(sql, documentId, pageCount);
  await sql`
    update document_page_states
    set state = 'indexed', materialized_by = ${materializedBy},
        claimed_by_run = null, claim_expires_at = null, failure_reason = null, read_text = null, updated_at = now()
    where document_id = ${documentId} and page_number <= ${pageCount}
      and (state in ('unseen', 'failed', 'parsed')
           or (state in ('claimed', 'pii-checked') and (claim_expires_at is null or claim_expires_at <= now())))
  `;
}

function splitByPages(text: string, pageCount: number): string[] {
  const pages = splitTextIntoPages(text, pageCount);
  return pages.length > 0 ? pages : [text];
}
