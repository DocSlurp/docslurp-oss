import {
  adaptiveRoutingDecisionSurfaceSchema,
  canonicalDocumentSchema,
  qualityAllowsPageReading,
  type AdaptiveRoutingDecisionSurface,
  type CanonicalDocument,
} from "@docslurp/shared";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments, skipCompletedPages, completeDocumentPages } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { PdfRasterCache, type RasterPageArtifact } from "../pipeline/pdf-asset-cache.js";
import { type ArtifactStore, keyFromStorageUri } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import type { Config } from "../config.js";
import { loadActiveRoutePlan } from "../routing/active-plan.js";
import { pagesNeedingPixels } from "../routing/runtime.js";
import { prioritizePagesWithoutNativeText } from "./classify-route.js";
import { visionAllowedForDocument } from "../lib/vision-page-budget.js";
import { pageInRanges, type DocumentPageRanges } from "../pipeline/page-ranges.js";
import { applyPageImageReferences, pagesKeptAsImage } from "../lib/page-image-references.js";
import { recordPageFacts } from "../pipeline/page-facts.js";

export class RenderImagesStage implements Stage {
  readonly name = "render-images";

  constructor(
    private readonly rasters: PdfRasterCache,
    private readonly storage: ArtifactStore,
    private readonly cfg?: Pick<Config, "pageRouterMode">,
  ) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    await runDocuments(healthyDocuments(state), state.docConcurrency, async (document) => {
      const key = `${runArtifactRoot(state.run, document.userId)}/images/${document.id}/manifest.json`;
      const artifactSlot = `${document.id}:images`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "selected-page raster cache manifest ready",
        async () => {
          const pageCount = Math.max(1, document.pageCount);
          const allPages = Array.from({ length: pageCount }, (_, index) => index + 1);
          const completedPages = state.store
            ? await state.store.getCompletedPages(state.run.id, document.id, this.name)
            : new Set<number>();
          const remaining = skipCompletedPages(completedPages, allPages);
          const { pageNumbers, request, routed, keptAsImage } = await this.selectPages(state, document);
          const pages = await this.rasters.renderSelectedPages({
            document,
            runId: state.run.id,
            pageNumbers,
            signal,
          });
          for (const page of pages) {
            state.artifactLedger.recordDocument(document.id, `page-${page.pageNumber}`, page.artifactUri);
          }
          // Fast: pages without a text layer are kept as their stored page image, never read. Only pages whose
          // image rendered get a reference, so every reference resolves.
          const rendered = new Set(pages.map((page) => page.pageNumber));
          const keptPages = keptAsImage.filter((pageNumber) => rendered.has(pageNumber));
          // A retried stage finds the references already in place (no change) and still reports the pages.
          await applyPageImageReferences({
            state, document, storage: this.storage, pages: keptPages, manifestUri: this.storage.uri(key),
          });
          const referencedPages = keptPages;
          if (referencedPages.length > 0) {
            await recordPageFacts(state.store, referencedPages.map((pageNumber) => ({
              documentId: document.id, runId: state.run.id, pageNumber, visionStatus: "kept-as-image" as const,
            })));
          }

          await this.storage.putJson(key, {
            documentId: document.id,
            status: pages.length > 0 ? "ready" : "on-demand",
            selectionSource: routed ? "page-router" : request?.status === "ready" ? "page-triage" : "none",
            supportsScans: true,
            render: {
              engine: pages.find((page) => page.engine)?.engine ?? this.rasters.requestedEngine,
              dpi: pages.find((page) => page.dpi)?.dpi ?? 150,
              policy: "selected-pages-only",
              sourceCoordinateSpace: "page-top-left-points",
              imageCoordinateSpace: "image-pixels-top-left",
              pageCount,
              pages,
            },
            resumedFrom: completedPages.size > 0 ? completedPages.size : undefined,
            ...(keptAsImage.length > 0 ? { keptAsImagePages: referencedPages } : {}),
          });

          await completeDocumentPages(state, document, this.name, remaining, pageCount, false);

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              rasterPolicy: "selected-pages-only",
              requestedPages: pageNumbers.length,
              renderedPages: pages.filter((page) => !page.cacheHit).length,
              reusedPages: pages.filter((page) => page.cacheHit).length,
              onDemand: pages.length === 0,
              rasterEngine: pages.find((page) => page.engine)?.engine ?? null,
              skippedPages: completedPages.size,
              processedPages: remaining.length,
              ...(keptAsImage.length > 0 ? { keptAsImagePages: referencedPages.length } : {}),
            },
          };
        },
        signal,
      );
    });
  }

  /** Pages this document renders, chosen the same way for whole documents and page-range shards. */
  private async selectPages(state: import("../pipeline/pipeline.js").WorkflowState, document: import("../models.js").Document) {
    const request = await this.loadRasterRequest(state, document.id);
    const mimeType = document.mimeType ?? "";
    const isPdf = mimeType === "application/pdf";
    const isImage = mimeType.startsWith("image/");
    // Fast never reads a page: render exactly the pages without a text layer, which keep their page image.
    if (!qualityAllowsPageReading(state.run.pipeline.quality)) {
      const keptAsImage = isPdf || isImage
        ? pagesKeptAsImage({
            canonicalDocument: await this.loadCanonicalDocument(state, document.id),
            pageCount: Math.max(1, document.pageCount),
            isImage,
            routing: request,
          })
        : [];
      return { pageNumbers: keptAsImage, request, routed: null, keptAsImage };
    }
    // Native text-only runs leave previews on demand. Classification can
    // suggest images, but must not override the workspace feature choices.
    const wantsRasters = state.run.pipeline.preserveImages || state.run.pipeline.visionFallback;
    // Only PDFs and images have a raster form. HTML, text and other
    // split documents keep on-demand previews instead of failing here
    // ("Native image documents only support page 1").
    // Active page router: render exactly the pages whose plan needs pixels (accept-text
    // pages need none). Off/shadow, or no plan for this document: the classification path.
    const routed = wantsRasters && isPdf ? await loadActiveRoutePlan(state, this.storage, document.id, this.cfg) : null;
    const selected = routed
      ? pagesNeedingPixels(routed)
      : wantsRasters && (isPdf || isImage)
        ? selectRasterPagesFromClassification(
            request,
            // With vision on but disallowed for this document (playbook), pre-render nothing; vision renders
            // any further page it needs on demand, and previews render on demand.
            state.run.pipeline.visionFallback &&
              !visionAllowedForDocument(state.run.pipeline, state.artifactLedger.readDocument(document.id, "parser-playbook"))
              ? { maxPages: 0 }
              : {},
          )
        : [];
    const pageNumbers = isImage ? selected.filter((pageNumber) => pageNumber === 1) : selected;
    return { pageNumbers, request, routed, keptAsImage: [] as number[] };
  }

  /**
   * Page-range shard: renders this shard's share of the selected pages into the content-keyed
   * raster cache and nothing else. The unsharded pass that follows writes the manifest, ledger
   * entries and checkpoints, and finds these pages as cache hits.
   */
  async runPageRanges(
    state: import("../pipeline/pipeline.js").WorkflowState,
    ranges: DocumentPageRanges,
    signal?: AbortSignal,
  ): Promise<void> {
    const documents = healthyDocuments(state).filter((document) => ranges.has(document.id)
      && state.documentStages?.get(document.id)?.get(this.name)?.status !== "completed");
    await runDocuments(documents, state.docConcurrency, async (document) => {
      signal?.throwIfAborted();
      const { pageNumbers } = await this.selectPages(state, document);
      const mine = pageNumbers.filter((pageNumber) => pageInRanges(pageNumber, ranges.get(document.id)));
      if (mine.length === 0) return;
      await this.rasters.renderSelectedPages({ document, runId: state.run.id, pageNumbers: mine, signal });
    });
  }

  private async loadCanonicalDocument(
    state: import("../pipeline/pipeline.js").WorkflowState,
    documentId: string,
  ): Promise<CanonicalDocument | null> {
    const uri = state.artifactLedger.readDocument(documentId, "canonical-document");
    const key = uri ? keyFromStorageUri(uri, this.storage.bucket) : null;
    if (!key) return null;
    try {
      const parsed = canonicalDocumentSchema.safeParse(await this.storage.getJson<unknown>(key));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async loadRasterRequest(
    state: import("../pipeline/pipeline.js").WorkflowState,
    documentId: string,
  ): Promise<AdaptiveRoutingDecisionSurface | null> {
    const uri = state.artifactLedger.readDocument(documentId, "classification");
    if (!uri) return null;
    const key = keyFromStorageUri(uri, this.storage.bucket);
    if (!key) return null;
    try {
      const parsed = adaptiveRoutingDecisionSurfaceSchema.safeParse(
        await this.storage.getJson<unknown>(key),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

export function selectRasterPagesFromClassification(
  input: unknown,
  options: { maxPages?: number } = {},
): number[] {
  const parsed = adaptiveRoutingDecisionSurfaceSchema.safeParse(input);
  const artifact = parsed.success ? parsed.data : null;
  if (artifact?.status !== "ready" || !Array.isArray(artifact.pages)) return [];
  const maxPages = options.maxPages === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.maxPages));
  return [...new Set(prioritizePagesWithoutNativeText(artifact.pages)
    .filter((page) =>
      page.extractorHint === "vision-rescue"
      || (typeof page.confidence === "number" && page.confidence < 0.65)
      || page.route === "handwriting-or-degraded"
      || page.route === "chart-or-figure"
      || page.route === "image-heavy",
    )
    .map((page) => page.pageNumber)
    .filter((pageNumber): pageNumber is number => Number.isInteger(pageNumber) && (pageNumber ?? 0) > 0))]
    .slice(0, maxPages)
    .sort((left, right) => left - right);
}

export type { RasterPageArtifact };
