<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/docslurp-mark-inverse.svg">
  <img src="docs/brand/docslurp-mark-dark.svg" width="72" alt="DocSlurp logo">
</picture>

# DocSlurp

Send DocSlurp any file. Get back page-by-page Markdown and structured fields, hybrid search and RAG context, and a chat endpoint whose answers cite the page they came from.

1. **Ingest and extraction:** PDFs, Office files, EPUBs, HTML, images, audio and video become page-by-page Markdown, page images, chunks and, against a JSON schema, structured fields.
2. **RAG search:** hybrid search and RAG context with page citations, over REST, the SDK, the CLI, MCP and drop-in Algolia, Meilisearch, Typesense and Pagefind clients.
3. **Configurable chat endpoint:** cited answers from `/v1/chat` and the OpenAI-compatible `/v1/chat/completions`, with streaming and per-workspace settings.

This repository holds the **DocSlurp server** (API and worker), the **database migrations**, the **CLI**, the **client SDKs** and the search integrations. The hosted product and its web dashboard are developed separately at <https://docslurp.io>.

> **Status: pre-release.** APIs and data models change without notice until v1.

## What is in this repository

| Path | What it is | License |
| --- | --- | --- |
| `server/` | The Hono API (`@docslurp/server`): ingestion, search, RAG context, chat, MCP, webhooks, auth | SSPL-1.0 (+ Apache-2.0 future grant) |
| `worker/` | Temporal-driven ingestion pipeline: parsing, OCR, chunking, embedding, indexing, extraction | SSPL-1.0 (+ Apache-2.0 future grant) |
| `packages/cli` | `@docslurp/cli`: upload files, watch runs, retrieve cited evidence | SSPL-1.0 (+ Apache-2.0 future grant) |
| `packages/contrib-algolia-server` | Server-side Algolia-style sync adapter | MIT |
| `packages/sdk` (incl. `@docslurp/sdk/embed`), `contrib-astro`, `contrib-search-compat`, `shared` | TypeScript SDK and embeddable widgets, Astro component, Algolia/Meilisearch/Typesense/Pagefind-compatible clients, shared contracts | MIT |
| `packages/contrib-wordpress` | WordPress search plugin | MIT |

## Self-host quickstart

You need Docker with Compose v2 (8 GB RAM or more for the lean worker) and a recent Node.js for the one-time config generator.

```sh
node scripts/selfhost-init.mjs                  # writes .env.selfhost with random secrets
node scripts/selfhost-check.mjs                 # validates the configuration
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --build
node scripts/selfhost-check.mjs --running       # waits for a healthy API and worker
```

The stack runs the API, one worker, Postgres with pgvector, Redis, MinIO and Temporal. There is no bundled web UI: use the REST API under `/v1`, the CLI, the SDK or MCP. Back up `.env.selfhost`: changing encryption keys later can make stored secrets unreadable. Full details, configuration options and operations notes are in [docs/self-host/README.md](docs/self-host/README.md).

## Use it

```js
import { createReadStream } from "node:fs";
import { createDocSlurpClient } from "@docslurp/sdk";

const client = createDocSlurpClient(); // reads DOCSLURP_API_KEY (and DOCSLURP_URL for self-host)
const { run } = await client.upload(createReadStream("handbook.pdf"));
await client.waitForRun(run.id);

for await (const hit of client.search({ q: "What is the parental leave policy?" })) {
  console.log(hit.text, hit.citation); // citation names the document and page
}
```

## Packages

Every package has an official docs page, a source folder in this repository and an npm listing. See the [package index](https://docslurp.io/docs/packages) for the full set, for example [`@docslurp/sdk`](https://docslurp.io/docs/packages/sdk) and [`@docslurp/cli`](https://docslurp.io/docs/packages/cli).

## Develop

```sh
cp .env.example .env
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev:api        # the Hono API on http://localhost:8787
pnpm dev:worker     # the ingestion worker (second terminal)
pnpm typecheck && pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Contributions require signing the [CLA](CLA.md). Security, conduct, licensing and trademark questions: **legal@docslurp.io**.

## License

DocSlurp is **source-available, not OSI-approved open source**.

- **Server** (`server/` including `server/db/`, `worker/`, CLI): [SSPL-1.0](LICENSES/SSPL-1.0.txt) with an irrevocable Apache-2.0 grant for each version three years after it is first publicly available under these terms. Self-hosting for your own use is allowed; offering the functionality to third parties as a service triggers SSPL section 13.
- **SDKs, clients, shared contracts and the WordPress plugin**: MIT. Using them to talk to a DocSlurp server over HTTP does not make your application SSPL.
- Third-party components keep their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [docs/licensing.md](docs/licensing.md).

"DocSlurp" and the DocSlurp logo are trademarks of DocSlurp, Inc. (unregistered, registration pending); the licenses above do not grant rights to them. See [TRADEMARK.md](TRADEMARK.md).

## Repository ownership

Develop the server, worker, SDKs and CLI in this repository. The private web application and production operations live in [DocSlurp/app](https://github.com/DocSlurp/app), which pins this repository as its `core/` submodule. The former private monorepo is retained as a historical archive; new changes and releases belong here.
