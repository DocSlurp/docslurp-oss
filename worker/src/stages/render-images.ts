import {
  adaptiveRoutingDecisionSurfaceSchema,
  type AdaptiveRoutingDecisionSurface,
} from "@docslurp/shared";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments, skipCompletedPages, completeDocumentPages } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { PdfRasterCache, type RasterPageArtifact } from "../pipeline/pdf-asset-cache.js";
import { type ArtifactStore, keyFromStorageUri } from "../tools/storage.js";
import type { Config } from "../config.js";
import { loadActiveRoutePlan } from "../routing/active-plan.js";
import { pagesNeedingPixels } from "../routing/runtime.js";
import { prioritizePagesWithoutNativeText } from "./classify-route.js";
import { resolveVisionPageBudget } from "../lib/vision-page-budget.js";

export class RenderImagesStage implements Stage {
  readonly name = "render-images";

  constructor(
    private readonly rasters: PdfRasterCache,
    private readonly storage: ArtifactStore,
    private readonly cfg?: Pick<Config, "pageRouterMode">,
  ) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    await runDocuments(healthyDocuments(state), state.docConcurrency, async (document) => {
      const key = `${document.userId}/${state.run.id}/images/${document.id}/manifest.json`;
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
          const request = await this.loadRasterRequest(state, document.id);
          // Native text-only runs leave previews on demand. Classification can
          // suggest images, but must not override the workspace feature choices.
          const wantsRasters = state.run.pipeline.preserveImages || state.run.pipeline.visionFallback;
          // Only PDFs and images have a raster form. HTML, text and other
          // split documents keep on-demand previews instead of failing here
          // ("Native image documents only support page 1").
          const mimeType = document.mimeType ?? "";
          const isPdf = mimeType === "application/pdf";
          const isImage = mimeType.startsWith("image/");
          // Active page router: render exactly the pages whose plan needs pixels (accept-text
          // pages need none). Off/shadow, or no plan for this document: the classification path.
          const routed = wantsRasters && isPdf ? await loadActiveRoutePlan(state, this.storage, document.id, this.cfg) : null;
          const selected = routed
            ? pagesNeedingPixels(routed)
            : wantsRasters && (isPdf || isImage)
              ? selectRasterPagesFromClassification(
                  request,
                  // With vision on, pre-render only what vision can use; vision renders any
                  // further page it needs on demand, and previews render on demand.
                  state.run.pipeline.visionFallback
                    ? { maxPages: resolveVisionPageBudget(state.run.pipeline, state.artifactLedger.readDocument(document.id, "parser-playbook")) }
                    : {},
                )
              : [];
          const pageNumbers = isImage ? selected.filter((pageNumber) => pageNumber === 1) : selected;
          const pages = await this.rasters.renderSelectedPages({
            document,
            runId: state.run.id,
            pageNumbers,
            signal,
          });
          for (const page of pages) {
            state.artifactLedger.recordDocument(document.id, `page-${page.pageNumber}`, page.artifactUri);
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
            },
          };
        },
        signal,
      );
    });
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
