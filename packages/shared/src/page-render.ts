/** Exact, bounded page rendering; no arbitrary source keys or renderer options cross the API. */
export interface RenderDocumentPageInput {
  documentId: string;
  runId: string;
  pageNumber: number;
  quality?: "reader" | "export";
}
export const PAGE_RENDER_WORKFLOW = "renderDocumentPage";
export const DEFAULT_PAGE_RENDER_TASK_QUEUE = "docslurp-page-render";
export function pageRenderWorkflowId(input: RenderDocumentPageInput): string {
  return `page-render:v2:${input.runId}:${input.documentId}:${input.pageNumber}:${input.quality ?? "reader"}`;
}

export function pageRenderSlot(documentId: string, pageNumber: number, quality: "reader" | "export" = "reader"): string {
  return `${documentId}:raster-v2-${quality}-page-${pageNumber}`;
}
