# DocSlurp

Send DocSlurp any file. Get back page-by-page Markdown and structured fields, hybrid search and RAG context, and a chat endpoint whose answers cite the page they came from.

This repository holds the **DocSlurp server** (API and worker), the **database migrations**, the **CLI** and the **client SDKs**. The hosted product and its web dashboard are developed separately at <https://docslurp.io>.

> **Status: pre-release.** APIs and data models change without notice until v1.

## What is in this repository

| Path | What it is | License |
| --- | --- | --- |
| `server/` | The Hono API (`@docslurp/server`): ingestion, search, RAG context, chat, MCP, webhooks, auth | SSPL-1.0 (+ Apache-2.0 future grant) |
| `worker/` | Temporal-driven ingestion pipeline: parsing, OCR, chunking, embedding, indexing, extraction | SSPL-1.0 (+ Apache-2.0 future grant) |
| `packages/cli` | `@docslurp/cli`: upload files, watch runs, retrieve cited evidence | SSPL-1.0 (+ Apache-2.0 future grant) |
| `packages/contrib-algolia-server` | Server-side Algolia-style sync adapter | SSPL-1.0 (+ Apache-2.0 future grant) |
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

The stack runs the API, one worker, Postgres with pgvector, Redis, MinIO and Temporal. There is no bundled web UI: use the REST API under `/v1`, the CLI, the SDK or MCP. Back up `.env.selfhost`: changing encryption keys later can make stored secrets unreadable. Full details, configuration options and operations notes are in [docs/self-host.md](docs/self-host.md).

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
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev:api        # the Hono API, standalone
pnpm dev:worker     # the ingestion worker
pnpm typecheck && pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

DocSlurp is **source-available, not OSI-approved open source**.

- **Server** (`server/` including `server/db/`, `worker/`, CLI, `contrib-algolia-server`): [SSPL-1.0](LICENSES/SSPL-1.0.txt) with an irrevocable Apache-2.0 grant for each version three years after it is first publicly available under these terms. Self-hosting for your own use is allowed; offering the functionality to third parties as a service triggers SSPL section 13.
- **SDKs, clients, shared contracts and the WordPress plugin**: MIT. Using them to talk to a DocSlurp server over HTTP does not make your application SSPL.
- Third-party components keep their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [docs/licensing.md](docs/licensing.md).

"DocSlurp" is a trademark of its owner; see [TRADEMARK.md](TRADEMARK.md).
