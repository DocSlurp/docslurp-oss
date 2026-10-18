# Completed

- Audit public API and SDK references: feature canonical upload/search/chat interfaces, label OpenAPI compatibility aliases deprecated, document the 0.3.0 SDK methods, and correct progress, workspace and webhook examples. Align browser/CLI adapters with the documented routes.

- Stream worker source downloads to disk with size checks and partial-file cleanup; classify interrupted storage bodies as infrastructure failures and stream-parse embedding artifacts for indexing beyond JavaScript's single-string limit.

- Add explicit native Perplexity embedding routes for ingestion and search with signed INT8 decoding, full-width validation, bounded requests, privacy enforcement and actual usage recording.

- Preserve terminal run status, stage and lease timestamps when late activity checkpoints settle paid usage; explicit retries still resume through queued state.

- Honor the resolved workspace chat retrieval budget (up to 12 passages) when forwarding evidence to answer generation instead of silently capping it at six.

- Trace PostgreSQL, S3, provider transports and vector-search adapters through the shared SigNoz and Langfuse exporters; retain dependency attributes, request-chain correlation and separately labeled usage costs, with real exporter, SDK and database regressions.
- Serialize superseded-document graph cleanup with graph extraction to prevent the production graph-refresh deadlock, using a nonblocking workspace lock when document rows are already held.

- Add opt-in candidate depth and relevance/prompt ordering controls across search GET/POST/batch, workspace/chat retrieval settings, SDK types and MCP-derived contracts. Keep omitted defaults stable; validate actual SQL/LanceDB retrieval in an isolated migrated database without model calls.
