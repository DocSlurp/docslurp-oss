# Completed

- Refit the brand mark: the paper cup with an orange straw keeps its drawing but drops Slurp Blue for the product palette (paper cup on dark, ink cup on light, Deck app icon). Primary mark, lockup and `favicon.svg` follow the viewer's colour scheme. The wordmark is outlined Schibsted Grotesk (`outline-wordmark.py`, `wordmark.json`). Raster favicons come from a new rounded app icon, so they read on light and dark tab strips.

- Let authenticated public chat (/v1/chat, /v1/search/chat, OpenAI-compatible completions) run the bounded search agent with workspace retrieval controls enforced on every tool call, while the MCP chat tool stays grounded retrieval only (no nested agents). Toggle with DOCSLURP_PUBLIC_CHAT_AGENT_ENABLED. Also: generic missing-premise/citation agent guidance, relevance-preserving MMR without vectors, opt-in metered DeepInfra BGE-M3 embeddings, failed-search usage persistence, and retrieval/multi-search evaluation harnesses with integrity-gated evidence.

- Add opt-in hosted Qwen reranking at the actual search post-retrieval seam, with workspace provider/model settings, scoped spend/privacy gates, actual-token Search Session usage, bounded fallback diagnostics and isolated SQL/service tests.

- Audit public API and SDK references: feature canonical upload/search/chat interfaces, label OpenAPI compatibility aliases deprecated, document the 0.3.0 SDK methods, and correct progress, workspace and webhook examples. Align browser/CLI adapters with the documented routes.

- Stream worker source downloads to disk with size checks and partial-file cleanup; classify interrupted storage bodies as infrastructure failures and stream-parse embedding artifacts for indexing beyond JavaScript's single-string limit.

- Add explicit native Perplexity embedding routes for ingestion and search with signed INT8 decoding, full-width validation, bounded requests, privacy enforcement and actual usage recording.

- Preserve terminal run status, stage and lease timestamps when late activity checkpoints settle paid usage; explicit retries still resume through queued state.

- Honor the resolved workspace chat retrieval budget (up to 12 passages) when forwarding evidence to answer generation instead of silently capping it at six.

- Trace PostgreSQL, S3, provider transports and vector-search adapters through the shared SigNoz and Langfuse exporters; retain dependency attributes, request-chain correlation and separately labeled usage costs, with real exporter, SDK and database regressions.
- Serialize superseded-document graph cleanup with graph extraction to prevent the production graph-refresh deadlock, using a nonblocking workspace lock when document rows are already held.

- Add opt-in candidate depth and relevance/prompt ordering controls across search GET/POST/batch, workspace/chat retrieval settings, SDK types and MCP-derived contracts. Keep omitted defaults stable; validate actual SQL/LanceDB retrieval in an isolated migrated database without model calls.
- Add opt-in LANCEDB_REFINE_FACTOR with ef covering refined candidates; verify authorization, SQL hydration/citations and unindexed tails through migrated local PostgreSQL and real Lance (2026-10-17).

- Reduced new-account starter credits to 250 ($2.50), below Silver’s 2,000 monthly credits; migration preserves existing grants and one-time claims.

- Retire the automation surface: delete the hidden `ai.simple` / `ai.advanced` / `ai.operation.get` MCP tools, `/v1/ai/*`, automation operations and grounded summaries. Migration 0060 drops their tables (`ai_operations`, `ai_operation_events`, `grounded_summaries`) as the follow-up contract step. The MCP catalog now has one definition per public tool name; the internal `workspace.*` ids, alias map and `docslurp://ai/*` resources are gone (`docslurp://capabilities` replaces them).
