/** Exact, bounded page rendering; no arbitrary source keys or renderer options cross the API. */
export interface RenderDocumentPageInput {
  documentId: string;
  runId: string;
  pageNumber: number;
}
export const PAGE_RENDER_WORKFLOW = "renderDocumentPage";
export const DEFAULT_PAGE_RENDER_TASK_QUEUE = "docslurp-page-render";
export function pageRenderWorkflowId(input: RenderDocumentPageInput): string {
  return `page-render:${input.runId}:${input.documentId}:${input.pageNumber}`;
}
