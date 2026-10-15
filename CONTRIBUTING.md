# Contributing to DocSlurp

Thanks for your interest. DocSlurp is pre-release and moving quickly, so small, focused contributions that match the current direction are the easiest to merge. Please open an issue before starting anything large.

## Layout

`pnpm` monorepo:

- `server/`: the Hono API (`@docslurp/server`), with Postgres migrations, seed and the migration runner in `server/db/`
- `worker/`: the ingestion pipeline (TypeScript, Temporal)
- `packages/*`: SDK, CLI, embeds and compatibility clients; `packages/shared` holds shared contracts

Stack: TypeScript (strict), Hono, Postgres with pgvector, MinIO/S3, Redis, Temporal.

## Development setup

```bash
pnpm install
pnpm db:up          # Postgres and MinIO via Docker Compose
pnpm db:migrate     # apply server/db/migrations
pnpm db:seed        # local development users
pnpm dev:api        # standalone API
pnpm dev:worker     # worker, in a second terminal
```

The web dashboard is not part of this repository, so there is no `pnpm dev` UI host here. Exercise changes through the REST API, the CLI, the SDK or MCP.

## Before you open a pull request

1. `pnpm typecheck`
2. `pnpm test` (server, worker, packages and scripts)
3. `pnpm build`
4. For worker or runtime dependency changes, check the Docker image still builds.

Database schema changes go only through `server/db/migrations` (`pnpm db:generate`, or a hand-written `NNNN_name.sql` plus its `meta/_journal.json` entry). Tests build their databases by applying the migrations in order.

## Style

- TypeScript strict mode, 2-space indentation, double quotes in server code.
- Keep new code in the package that owns it (routes in `server/`, pipeline stages in `worker/src/stages/`).
- Every LLM or embedding call must log usage as `[ai-usage] <metric> model=<id> input_tokens=<n> output_tokens=<n>` and persist it through the existing usage recorder.
- Add a test for behaviour you change.

## Commits and pull requests

Short imperative subjects ("Fix worker timeout on large PDFs") with a body explaining why. Keep pull requests small, describe user-visible behaviour, and note any environment variable or schema change.

AI-assisted contributions are welcome. You are responsible for reviewing the code, its licence compatibility and its tests.

## Licensing of contributions

> **OWNER DECISION PENDING: DCO or CLA.** Choose one before the repository goes public and delete the other paragraph.
>
> **Option 1, DCO:** every commit must carry a `Signed-off-by:` line (`git commit -s`) certifying the [Developer Certificate of Origin](https://developercertificate.org/). Contributions are licensed under the licence of the part of the tree they modify (SSPL-1.0 with the Apache-2.0 future grant for the server, MIT for SDKs and clients). Commercial relicensing of the server then depends on contributor consent.
>
> **Option 2, CLA:** contributors sign a Contributor License Agreement (text and tooling to be chosen) granting the maintainers the right to relicense, which keeps dual-licensing and commercial terms possible.

Until this is decided, the project cannot accept external contributions.

## Security and conduct

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
