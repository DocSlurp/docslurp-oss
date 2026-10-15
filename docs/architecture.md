# Architecture Notes

This document captures architecture decisions that are cross-cutting enough to matter outside a single package.

## Product tentpoles

DocSlurp is organized around three jobs. Each one reads and writes the same workspaces.

| Tentpole | What it delivers | Where it lives |
| --- | --- | --- |
| Ingest and extraction | Any file (PDF, Office, EPUB, HTML, images, audio, video) becomes page-by-page Markdown, page images, chunks and, with a workspace JSON schema, structured fields | `worker/src/stages/`, ingest routes in `server/src/routes/` |
| RAG search | Hybrid search and RAG context with document and page citations, over REST, SDK, CLI, MCP and drop-in search clients | `server/src/services/search.ts`, `server/src/routes/search.ts`, `packages/sdk`, `packages/compat-*` |
| Configurable chat endpoint | Cited answers from `/v1/chat` and the OpenAI-compatible `/v1/chat/completions`, with streaming, per-workspace chat settings and per-request model, retrieval and filter overrides on `/v1/chat` | `server/src/services/workspace-chat.ts`, `server/src/routes/chat-completions.ts` |

## Multi-Tenant Vector Storage

DocSlurp treats `Organization -> Workspace -> Run -> Document` as the retrieval boundary chain. Postgres remains the source of truth for membership, workspace scope, document status, chunk metadata, and result hydration.

LanceDB stores ANN vectors behind a storage-layer tenant boundary:

- `packages/shared/src/vector-namespace.ts` owns the naming contract through `VectorNamespaceManager`.
- The live table for an organization is `chunks_org_<sha256(org_id)[0:32]>`.
- `worker/src/stages/index-vectors.ts` writes LanceDB vectors only to the table derived from `state.run.orgId`.
- `server/src/search/lancedb.ts` opens only the exact table derived from the org id returned by workspace access checks.
- Search callers cannot provide a LanceDB namespace, table name, or table prefix.
- Blank org ids fail closed, and lookalike/archive table names are not considered live tenant tables.

This means a malformed namespace parameter, missing namespace parameter, or table-prefix bug cannot widen a vector query across organizations. PostgreSQL workspace-scoped hydration remains in place as a second boundary after ANN retrieval.
