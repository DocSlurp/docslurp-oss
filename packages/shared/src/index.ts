// index.ts — thin re-export hub.
// All concrete definitions live in focused sub-modules; this file
// re-exports everything so existing imports from "@docslurp/shared" continue to work.

export * from "./layout.js";
export * from "./citation-locator.js";
export * from "./media-summary.js";
export * from "./anthropic-models.js";
export * from "./billing.js";
export * from "./pricing-provider.js";
export { OPEN_PRICING, OPEN_CREDITS_PER_PAGE, openStoredBytes } from "./pricing-open.js";
export * from "./file-profile.js";
export * from "./estimate-quote.js";
export { assembleEstimateQuote, profiledPageArea, profiledTextChars, type StoredBytesModel } from "./estimate-assembly.js";
export { installTestPricing, DISTINCT_TEST_PRICING } from "./pricing-testing.js";
export * from "./quality.js";
export * from "./credit-leases.js";
export * from "./chat-reserve.js";
export * from "./rate-limits.js";
// duplicate export removed (was listed twice in original)
export * from "./extraction.js";
export * from "./extractors.js";
export * from "./extractor-aliases.js";
export * from "./visual-artifacts.js";
export * from "./chart-export.js";
export * from "./chart-export-estimate.js";
export * from "./chart-export-render.js";
export * from "./visual-intent.js";
export * from "./media-map.js";
export * from "./ocr-result.js";
export * from "./image-routing.js";
export * from "./image-anchors.js";
export * from "./doppler-figures.js";
export * from "./structured.js";
export * from "./connectors.js";
export * from "./artifacts.js";
export * from "./pii.js";
export * from "./temporal-connection.js";
export * from "./vector-namespace.js";

// Sub-modules created during refactor
export * from "./embedding.js";
export * from "./perplexity-embeddings.js";
export * from "./deferred-indexing.js";
export * from "./page-vectors.js";
export * from "./pipeline.js";
export * from "./document-versions.js";
export * from "./jobs.js";
export * from "./media-upload-estimate.js";
export * from "./page-equivalents.js";
export * from "./page-table-routing.js";
export * from "./file-formats.js";
export * from "./file-sniff.js";
export * from "./page-raster-routing.js";
export * from "./text-layer-quality.js";
export { buildProfilerRules, type ProfilerRules } from "./estimate-profiler-rules.js";
export * from "./upload-quote.js";
export * from "./config-change.js";
export * from "./privacy.js";
export * from "./private-endpoints.js";
export * from "./model-uri.js";
export * from "./live-model-prices.js";
export * from "./graph.js";
export * from "./run.js";
export * from "./run-failure.js";
export * from "./project.js";
export * from "./project-slug.js";
export * from "./connection-uri.js";
export * from "./chunks.js";
export * from "./search.js";
export * from "./usage.js";
export * from "./text-normalization.js";
export * from "./document-title.js";

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
export * from "./openrouter-routing.js";
export * from "./provider-regions.js";
export * from "./chat-model-prices.js";

export * from "./project-state.js";
export * from "./ingest-report.js";
export * from "./organization-management.js";
export * from "./worker-autoscale.js";
export * from "./worker-capabilities.js";
export * from "./model-license.js";
export * from "./page-routing.js";
export * from "./routing-targets.js";
export * from "./public-errors.js";
export * from "./api-error.js";
export * from "./frontend-api.js";

export { documentTagsSchema } from "./document-tags.js";

export * from "./page-render.js";
export * from "./document-export.js";
export * from "./extract-mode.js";

export * from "./project-settings-proposal.js";

export * from "./geo.js";
export * from "./geo-projection-contract.js";

export * from "./realtime.js";
