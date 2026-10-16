# Repository guidelines for coding agents

DocSlurp is a document and media ingestion service: files go through a configurable pipeline that produces page-by-page Markdown, chunks, embeddings and structured fields, served through search, RAG context and a cited chat endpoint. This repository is pre-release: breaking changes to APIs and data models are acceptable, so prefer the cleanest design over compatibility shims.

## Layout

- `server/`: Hono API (`@docslurp/server`). Routes in `server/src/routes/`, services in `server/src/services/`, the Drizzle schema, Postgres migrations, `migrate.mjs` and `seed.ts` in `server/db/`.
- `worker/`: TypeScript ingestion pipeline. Stages live in `worker/src/stages/`.
- `packages/`: `sdk` (with the `@docslurp/sdk/embed` subpath), `cli`, `contrib-astro`, `contrib-search-compat`, `contrib-algolia-server`, `contrib-wordpress` and `shared` (contracts shared by server and clients).
- `docs/`: public documentation. Self-host instructions are in `docs/self-host.md`.

Keep new code in the package that owns it. `server/` must not import from outside the workspace packages it declares.

## Commands

- `pnpm install`
- `pnpm dev:api` (http://localhost:8787), `pnpm dev:worker`
- `pnpm db:up`, `pnpm db:migrate`, `pnpm db:seed`
- `pnpm typecheck`, `pnpm test`, `pnpm build`
- `pnpm fixtures:fetch` (pinned third-party test fixtures into `.cache/`)

## Conventions

- TypeScript strict mode, 2-space indentation, double quotes.
- Database schema changes go only through `server/db/migrations`; tests build databases by applying migrations in order. Never create tables or columns any other way.
- Log every LLM or embedding call as `[ai-usage] <metric> model=<id> input_tokens=<n> output_tokens=<n>` and persist usage through the existing recorder with an explicit scope.
- Never commit secrets, `.env` files, model weights or test fixtures with unclear licenses. Third-party fixtures are fetched on first use with `pnpm fixtures:fetch` into the gitignored `.cache/`.
- Benchmark and evaluation inputs are held-out evidence. Do not hard-code document names, field names or expected values from an evaluation into production code or prompts.

## Licensing

The server, worker and CLI are SSPL-1.0 with an Apache-2.0 future grant; the SDKs, clients (including `contrib-algolia-server`) and `packages/shared` are MIT. New files inherit the license of the package they live in. Do not copy code from incompatibly licensed projects (for example AGPL or GPL sources) into any package.

## Pull requests

Small, focused commits with imperative subjects and a "why" in the body. Run typecheck and tests for the packages you touched before opening a pull request. See `CONTRIBUTING.md`.
