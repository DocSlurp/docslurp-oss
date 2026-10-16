# Architecture Notes

This document captures architecture decisions that are cross-cutting enough to matter outside a single package.

## Layout and hosting

- `server/` (`@docslurp/server`) is the Hono API: ingest, search, chat, MCP, webhooks and auth routes, plus services and startup tasks. The Drizzle schema, migrations, `migrate.mjs` and seed live in `server/db/`. `pnpm dev:api` runs it alone on port 8787.
- `app/` is the private Astro frontend. By default it mounts the server in the same process, so API calls from the dashboard make no network hop. Set `DOCSLURP_SERVER_URL` to call a separately hosted server over HTTP instead.
- `worker/` runs the ingestion pipeline as Temporal activities (stages in `worker/src/stages/`). It shares Postgres, object storage and LanceDB with the server.
- `packages/` holds the SDK (with `/embed`), CLI, `shared` contracts and the `contrib-*` integrations.

A run flows from upload to object storage and a run record, through the worker stages (normalize, detect, split and render, extract, embed, index, then summarize and structure), and becomes searchable, chat-ready and visible in the dashboard. PDFs use Kreuzberg by default with Poppler as the fallback; a private native-pdf engine is used when installed, and Docling and Unstructured are optional vendor bundles ([worker image](worker-image.md)). Scanned pages go to vision models within a per-document page budget.

Deploys run migrate, then worker, then app. A worker capability handshake keeps flags that need both sides off until every live worker supports them; see releases.

## Dashboard bootstrap

The Astro app reads signed-in state from `GET /dashboard/bootstrap`, using a session cookie in both hosting modes. It returns the admin flag, organizations and accessible workspaces through the existing domain services. This dashboard contract is separate from the public `/v1` integration API, rejects API keys, uses `Cache-Control: private, no-store`, and retains the global IP limit without consuming the actor's API budget.

Account provisioning runs after signup and before session creation; configured admin membership promotion runs before session creation, after provisioning. Bootstrap reads do not provision organizations, promote memberships, or refine workspace titles. Existing incomplete accounts are repaired on their next sign-in. Admin eligibility is still checked against the verified identity on each authenticated request, while membership promotion waits until the next sign-in.

## Product tentpoles

DocSlurp is organized around three jobs. Each one reads and writes the same workspaces.

| Tentpole | What it delivers | Where it lives |
| --- | --- | --- |
| Ingest and extraction | Any file (PDF, Office, EPUB, HTML, images, audio, video) becomes page-by-page Markdown, page images, chunks and, with a workspace JSON schema, structured fields | `worker/src/stages/`, ingest routes in `server/src/routes/` |
| RAG search | Hybrid search and RAG context with document and page citations, over REST, SDK, CLI, MCP and drop-in search clients | `server/src/services/search.ts`, `server/src/routes/search.ts`, `packages/sdk`, `packages/contrib-search-compat` |
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
