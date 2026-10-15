# Contributing to DocSlurp

Thanks for your interest. DocSlurp is pre-release and moving quickly, so small, focused contributions that match the current direction are the easiest to merge. Please open an issue before starting anything large.

## Layout

`pnpm` monorepo:

- `server/`: the Hono API (`@docslurp/server`), with Postgres migrations, seed and the migration runner in `server/db/`
- `worker/`: the ingestion pipeline (TypeScript, Temporal)
- `packages/*`: the SDK (with its `/embed` subpath), CLI, `contrib-*` integrations and compatibility clients; `packages/shared` holds shared contracts

Stack: TypeScript (strict), Hono, Postgres with pgvector, MinIO/S3, Redis, Temporal. Node.js 24 and pnpm 10 are required.

## Development setup

```bash
cp .env.example .env
pnpm install
pnpm db:up          # Postgres, Redis, MinIO and Temporal via Docker Compose
pnpm db:migrate     # apply server/db/migrations
pnpm db:seed        # local development users
pnpm dev:api        # standalone API on http://localhost:8787
pnpm dev:worker     # worker, in a second terminal
```

The web dashboard is not part of this repository, so there is no `pnpm dev` UI host here. Exercise changes through the REST API, the CLI, the SDK or MCP.

## Before you open a pull request

1. `pnpm typecheck`
2. `pnpm test` (server, worker, packages and scripts)
3. `pnpm build`
4. For worker or runtime dependency changes, check the Docker image still builds.

Tests that need third-party PDFs fetch them on first use with `pnpm fixtures:fetch` into the gitignored `.cache/`; never commit them.

Database schema changes go only through `server/db/migrations` (`pnpm db:generate`, or a hand-written `NNNN_name.sql` plus its `meta/_journal.json` entry). Tests build their databases by applying the migrations in order.

## Style

- TypeScript strict mode, 2-space indentation, double quotes in server code.
- Keep new code in the package that owns it (routes in `server/`, pipeline stages in `worker/src/stages/`).
- Every LLM or embedding call must log usage as `[ai-usage] <metric> model=<id> input_tokens=<n> output_tokens=<n>` and persist it through the existing usage recorder.
- Add a test for behaviour you change.

## Commits and pull requests

Short imperative subjects ("Fix worker timeout on large PDFs") with a body explaining why. Keep pull requests small, describe user-visible behaviour, and note any environment variable or schema change.

AI-assisted contributions are welcome. You are responsible for reviewing the code, its license compatibility and its tests.

## Licensing of contributions and the CLA

DocSlurp uses different licenses for different parts of the tree (SSPL-1.0 with an Apache-2.0 future grant for the server, worker, CLI and server-side adapter; MIT for the SDKs, shared contracts and client integrations; see [LICENSE](LICENSE)). To keep that model workable, and to let us offer commercial terms, **every contributor signs the [Contributor License Agreement](CLA.md)** before a pull request can be merged.

- **You keep the copyright** in your contribution. You grant DocSlurp, Inc. a copyright and patent license that includes the right to relicense it, and you confirm the work is yours to contribute. It is modelled on the Apache individual and corporate CLAs.
- **Individuals:** open a pull request. The CLA Assistant bot comments with the exact sentence to reply with; the check turns green once you have signed. You sign once; it covers later pull requests under the same CLA version.
- **Employees:** if your employer may own what you write, ask it to sign the corporate CLA (Part B of [CLA.md](CLA.md)) and email it to **legal@docslurp.io**, listing your GitHub username. Do this before you contribute.
- **Not required:** DocSlurp organization members, and bots such as Dependabot.
- Accepted pull requests are merged in our private monorepo and published here by the exporter, so the commit that lands here may be re-created by the exporter. We keep you as the commit author or credit you by name in the commit message.
- Do not submit code you do not have the right to license, including output copied from other projects. Say so in the pull request if part of your change comes from elsewhere, and name its license.

Questions about the CLA: **legal@docslurp.io**.

## Security and conduct

Report vulnerabilities privately to **legal@docslurp.io** as described in [SECURITY.md](SECURITY.md), not in public issues. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md); conduct reports also go to **legal@docslurp.io**. The name and logo are covered by the [trademark policy](TRADEMARK.md).
