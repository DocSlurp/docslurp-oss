// index.ts — thin re-export hub.
// All concrete definitions live in focused sub-modules; this file
// re-exports everything so existing imports from "@docslurp/shared" continue to work.

export * from "./layout.js";
export * from "./citation-locator.js";
export * from "./media-summary.js";
export * from "./anthropic-models.js";
export * from "./billing.js";
export * from "./credit-leases.js";
export * from "./chat-reserve.js";
export * from "./extract-pricing.js";
export * from "./infra-costs.js";
export * from "./rate-limits.js";
// duplicate export removed (was listed twice in original)
export * from "./extraction.js";
export * from "./extractors.js";
export * from "./visual-artifacts.js";
export * from "./structured.js";
export * from "./connectors.js";
export * from "./artifacts.js";
export * from "./pii.js";
export * from "./temporal-connection.js";
export * from "./vector-namespace.js";

// Sub-modules created during refactor
export * from "./embedding.js";
export * from "./pipeline.js";
export * from "./privacy.js";
export * from "./private-endpoints.js";
export * from "./graph.js";
export * from "./run.js";
export * from "./run-failure.js";
export * from "./workspace.js";
export * from "./workspace-slug.js";
export * from "./connection-uri.js";
export * from "./chunks.js";
export * from "./search.js";
export * from "./usage.js";
export * from "./text-normalization.js";

// Explicit named re-exports that were originally inlined in index.ts to satisfy
// any consumer that imports them by name from @docslurp/shared.
export {
  layoutPolygonPointSchema,
  layoutRegionSchema,
  sourceTraceSchema,
} from "./layout.js";
export type {
  LayoutPolygonPoint,
  LayoutRegion,
  SourceTrace,
} from "./layout.js";

export * from "./openrouter-usage.js";

export * from "./workspace-state.js";
export * from "./ingest-report.js";
export * from "./organization-management.js";
export * from "./worker-autoscale.js";
export * from "./worker-capabilities.js";
export * from "./model-license.js";
export * from "./page-routing.js";
export * from "./routing-targets.js";
export * from "./public-errors.js";
export * from "./frontend-api.js";
