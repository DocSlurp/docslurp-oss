import type postgres from "postgres";
import sharp from "sharp";
import { l2Normalize, packSignBits, pageCredits, qualityAllowsPageReading, quantizeInt8 } from "@docslurp/shared";

import { ensurePageRows, markPagesEmbedded } from "../deferred/page-ledger.js";
import {
  resolvePageImageEmbedder,
  type PageImageEmbedder,
} from "../deferred/page-image-embedders.js";
import type { Document, WorkspaceRun } from "../models.js";
import { completeDocumentPages, runDocumentStage, runDocuments, runSpentCents, skipCompletedPages } from "../pipeline/checkpoints.js";
import type { PdfRasterCache } from "../pipeline/pdf-asset-cache.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import type { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import type { ArtifactStore } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";

type Sql = postgres.Sql<Record<string, unknown>>;

export const PAGE_EMBED_WINDOW = 16;
/** Visual Pages: long edge in pixels (never upscaled) and JPEG quality. */
export const PAGE_IMAGE_MAX_EDGE = 1024;
export const PAGE_IMAGE_JPEG_QUALITY = 85;
/** Render density; 96 dpi gives >= 1024 px on the long edge for letter/A4, then sharp downsizes. */
const RENDER_DPI = 96;

export interface PageEmbedDeps {
  sql: Sql;
  rasters: Pick<PdfRasterCache, "renderSelectedPages">;
  storage: Pick<ArtifactStore, "getBytes" | "deleteKeys">;
  embedder: PageImageEmbedder;
  usage: PipelineUsageEventLedger;
}

export interface EmbedPageImagesResult {
  embeddedPages: number[];
  /** Set when the call stopped early; pages after the stop were not embedded. */
  stoppedBy?: "cost-cap" | "quality-fast";
  inputTokens: number;
  costCents: number;
}


/** Downscales to <= 1024 px on the long edge (never upscaling) and encodes JPEG q85. */
export async function toPageJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(bytes)
      .rotate()
      .resize({ width: PAGE_IMAGE_MAX_EDGE, height: PAGE_IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: PAGE_IMAGE_JPEG_QUALITY })
      .toBuffer(),
  );
}

interface RenderedWindow {
  pages: number[];
  jpegs: Uint8Array[];
}

/**
 * Per-window render -> embed -> store pipeline, reusable for any page subset. Rendering of window
 * N+1 overlaps with embedding of window N; raster artifacts this call created are deleted as soon
 * as their JPEG exists (cache hits belong to other stages and are left alone).
 */
export async function embedPageImages(
  deps: PageEmbedDeps,
  args: {
    document: Document;
    pages: number[];
    run: Pick<WorkspaceRun, "id" | "orgId" | "workspaceId"> & { pipeline?: Pick<WorkspaceRun["pipeline"], "quality"> };
    signal?: AbortSignal;
    windowSize?: number;
    onWindow?: (info: { embedded: number[]; windowIndex: number; windows: number }) => Promise<void> | void;
    /** Called before each window with its estimated cost in cents; return false to stop cleanly. */
    canAfford?: (estimatedCents: number) => boolean;
  },
): Promise<EmbedPageImagesResult> {
  const { document, run, signal } = args;
  const size = Math.max(1, args.windowSize ?? PAGE_EMBED_WINDOW);
  const pages = [...new Set(args.pages)].filter((p) => Number.isInteger(p) && p >= 1).sort((a, b) => a - b);
  const windows: number[][] = [];
  for (let i = 0; i < pages.length; i += size) windows.push(pages.slice(i, i + size));
  const result: EmbedPageImagesResult = { embeddedPages: [], inputTokens: 0, costCents: 0 };
  if (windows.length === 0) return result;
  // Fast reads no page: embedding a page image is a model read that bills Rich. The server refuses Fast with visual
  // indexing; this is the backstop, so nothing is rendered, embedded or charged.
  if (!qualityAllowsPageReading(run.pipeline?.quality)) {
    console.error(`[page-embed] refused under quality fast run=${run.id} document=${document.id} pages=${pages.length}`);
    result.stoppedBy = "quality-fast";
    return result;
  }
  if (!run.workspaceId) throw new Error("page-embed requires a workspace-scoped run");
  const workspaceId = run.workspaceId;
  await ensurePageRows(deps.sql, document.id, document.pageCount);

  const renderWindow = async (windowPages: number[]): Promise<RenderedWindow> => {
    const rasters = await deps.rasters.renderSelectedPages({
      document,
      runId: run.id,
      pageNumbers: windowPages,
      dpi: RENDER_DPI,
      signal,
    });
    const transient = rasters.filter((r) => !r.cacheHit).map((r) => r.artifactKey);
    try {
      const out: RenderedWindow = { pages: [], jpegs: [] };
      for (const raster of [...rasters].sort((a, b) => a.pageNumber - b.pageNumber)) {
        out.jpegs.push(await toPageJpeg(await deps.storage.getBytes(raster.artifactKey)));
        out.pages.push(raster.pageNumber);
      }
      return out;
    } finally {
      await deps.storage.deleteKeys(transient).catch(() => undefined);
    }
  };

  // Customer credits: a page embedded as an image is read by a model, so it bills as a Rich page (PRICE_CARD).
  const estimate = (windowPages: number) => pageCredits("rich", windowPages);
  if (args.canAfford && !args.canAfford(estimate(windows[0]!.length))) {
    result.stoppedBy = "cost-cap";
    return result;
  }
  let next: Promise<RenderedWindow> | null = renderWindow(windows[0]!);
  for (let index = 0; index < windows.length; index++) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    if (index > 0 && args.canAfford && !args.canAfford(estimate(windows[index]!.length))) {
      result.stoppedBy = "cost-cap";
      await next?.catch(() => undefined); // let the prefetched render clean up its rasters
      break;
    }
    const current = next!;
    next = null;
    const currentWindow = await current;
    if (index + 1 < windows.length) {
      next = renderWindow(windows[index + 1]!);
      next.catch(() => undefined); // surfaced when awaited; avoids unhandled rejection if embedding throws first
    }
    if (currentWindow.pages.length === 0) continue;

    const embedded = await deps.embedder.embedImages(currentWindow.jpegs.map((jpeg) => ({ jpeg })), signal);
    if (embedded.vectors.length !== currentWindow.pages.length) {
      throw new Error(`Embedder returned ${embedded.vectors.length} vectors for ${currentWindow.pages.length} pages`);
    }
    deps.usage.record({
        provider: deps.embedder.provider,
        model: deps.embedder.model,
        metric: "page-image-embedding",
        amount: embedded.inputTokens,
        unit: "token",
        inputTokens: embedded.inputTokens,
        costCents: embedded.costCents,
        metadata: { documentId: document.id, pages: currentWindow.pages.length, dims: deps.embedder.dims, tokenSource: "api" },
      }
    );
    for (const pageNumber of currentWindow.pages) {
      deps.usage.chargeRichPage({ documentId: document.id, pageNumber, readBy: "page-image-embedding", model: deps.embedder.model });
    }

    const rows = currentWindow.pages.map((pageNumber, i) => {
      const unit = l2Normalize(embedded.vectors[i]!);
      const bits = packSignBits(unit);
      const q = quantizeInt8(unit);
      return {
        document_id: document.id,
        page_number: pageNumber,
        model: deps.embedder.model,
        dims: unit.length,
        bits: Buffer.from(bits),
        int8: Buffer.from(q.values.buffer, q.values.byteOffset, q.values.byteLength),
        scale: q.scale,
        workspace_id: workspaceId,
        org_id: run.orgId ?? null,
      };
    });
    await deps.sql`
      insert into document_page_vectors ${deps.sql(rows)}
      on conflict (document_id, page_number, model) do update
      set dims = excluded.dims, bits = excluded.bits, int8 = excluded.int8, scale = excluded.scale
    `;
    await markPagesEmbedded(deps.sql, document.id, currentWindow.pages, deps.embedder.model);
    result.embeddedPages.push(...currentWindow.pages);
    result.inputTokens += embedded.inputTokens;
    result.costCents += embedded.costCents;
    await args.onWindow?.({ embedded: currentWindow.pages, windowIndex: index, windows: windows.length });
  }
  return result;
}

/** True when spending `estimatedCents` more keeps the run within `maxCostCents` (no cap: always). */
export function withinCostCap(state: WorkflowState, estimatedCents: number): boolean {
  const cap = state.run.pipeline.maxCostCents;
  if (cap === null || cap === undefined || cap <= 0) return true;
  return runSpentCents(state) + estimatedCents <= cap;
}

export class PageEmbedStage implements Stage {
  readonly name = "page-embed";

  constructor(
    private readonly rasters: Pick<PdfRasterCache, "renderSelectedPages">,
    private readonly storage: ArtifactStore,
    private readonly sql: () => Sql,
    private readonly embedderOverride?: PageImageEmbedder,
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const pipeline = state.run.pipeline;
    // Fast reads no page (no Rich charge): skip visual embedding entirely; text indexing still runs.
    if (!qualityAllowsPageReading(pipeline.quality)) {
      console.error(`[page-embed] skipped: quality fast does not embed page images run=${state.run.id} documents=${state.documents.length}`);
      return;
    }
    const embedder =
      this.embedderOverride ??
      resolvePageImageEmbedder({ route: pipeline.visualPages?.route ?? "auto", privacyMode: pipeline.privacyMode });
    if (!embedder) {
      throw new Error(
        "Visual indexing needs a page-image embedder: register a Jina v5 omni nano private endpoint " +
          "(DOCSLURP_PRIVATE_MODEL_ENDPOINTS) or set GOOGLE_GENERATIVE_AI_API_KEY (not allowed in strict privacy modes)",
      );
    }
    const deps: PageEmbedDeps = {
      sql: this.sql(),
      rasters: this.rasters,
      storage: this.storage,
      embedder,
      usage: state.usageLedger,
    };
    await runDocuments(state.documents, state.docConcurrency, async (document) => {
      await runDocumentStage(
        state,
        document,
        this.name,
        `${document.id}:page-embed`,
        "page image vectors stored",
        async () => {
          const pageCount = Math.max(1, document.pageCount);
          const allPages = Array.from({ length: pageCount }, (_, i) => i + 1);
          const done = await deps.sql<{ page_number: number }[]>`
            select page_number from document_page_vectors
            where document_id = ${document.id} and model = ${embedder.model}
          `;
          const todo = skipCompletedPages(new Set(done.map((r) => r.page_number)), allPages);
          const outcome = await embedPageImages(deps, {
            document,
            pages: todo,
            run: state.run,
            signal,
            canAfford: (estimatedCents) => withinCostCap(state, estimatedCents),
          });
          if (outcome.stoppedBy) {
            console.warn(`[page-embed] document=${document.id} stopped by ${outcome.stoppedBy} after ${outcome.embeddedPages.length}/${todo.length} pages`);
          }
          await completeDocumentPages(state, document, this.name, outcome.embeddedPages, pageCount, false);
          const key = `${runArtifactRoot(state.run, document.userId)}/page-embed/${document.id}/manifest.json`;
          await this.storage.putJson(key, {
            documentId: document.id,
            model: embedder.model,
            dims: embedder.dims,
            embeddedPages: outcome.embeddedPages.length,
            reusedPages: pageCount - todo.length,
            stoppedBy: outcome.stoppedBy ?? null,
            remainingPages: todo.length - outcome.embeddedPages.length,
            inputTokens: outcome.inputTokens,
            costCents: outcome.costCents,
          });
          return {
            artifactUri: this.storage.uri(key),
            stats: {
              embeddingModel: embedder.model,
              dims: embedder.dims,
              embeddedPages: outcome.embeddedPages.length,
              reusedPages: pageCount - todo.length,
              stoppedBy: outcome.stoppedBy ?? null,
              remainingPages: todo.length - outcome.embeddedPages.length,
              inputTokens: outcome.inputTokens,
              costCents: outcome.costCents,
            },
          };
        },
        signal,
      );
    });
  }
}
