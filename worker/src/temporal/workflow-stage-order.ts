/**
 * Workflow-safe copy of the runnable pipeline stage order.
 *
 * Keep this file free of package imports: Temporal bundles it into the
 * deterministic workflow sandbox, where Node built-ins are unavailable.
 */
export const WORKFLOW_STAGE_ORDER = [
  "quarantine",
  "format-detect",
  "to-canonical",
  "format-tooling",
  "normalize",
  "pdf-tooling",
  "split-pages",
  "document-map",
  "page-embed",
  "extract-markdown",
  "extract-html",
  "classify-route",
  "route-pages",
  "render-images",
  "vision-extract",
  "pii-detect",
  "document-summary",
  "structured-extract",
  "embed",
  "graph-enrich",
  "page-index",
  "proposition-index",
  "index",
] as const;
