/** Exact bounded rendering. The worker rechecks DPI against the owning organization's policy. */
export type PageRenderQuality = "reader" | "export";
export type PageRenderDpi = 120 | 250;
export interface RenderDocumentPageInput {
  documentId: string;
  runId: string;
  pageNumber: number;
  quality?: PageRenderQuality;
  /** Server-approved policy snapshot; never an arbitrary renderer setting. */
  dpi?: PageRenderDpi;
}
export const PAGE_RENDER_WORKFLOW = "renderDocumentPage";
export const DEFAULT_PAGE_RENDER_TASK_QUEUE = "docslurp-page-render";
export function pageRenderDpi(quality: PageRenderQuality, funded: boolean): PageRenderDpi {
  return quality === "export" && funded ? 250 : 120;
}
export function pageRenderCapabilities(funded: boolean) {
  return { sharperImage: funded, exportDpi: pageRenderDpi("export", funded) };
}
export function pageRenderWorkflowId(input: RenderDocumentPageInput): string {
  return `page-render:v3:${input.runId}:${input.documentId}:${input.pageNumber}:${input.quality ?? "reader"}:${input.dpi ?? 120}dpi`;
}
export function pageRenderSlot(documentId: string, pageNumber: number, quality: PageRenderQuality = "reader", dpi: PageRenderDpi = 120): string {
  return `${documentId}:raster-v3-${quality}-${dpi}dpi-page-${pageNumber}`;
}
