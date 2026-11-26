# Contributing to DocSlurp

Thanks for your interest. DocSlurp moves quickly, so small, focused contributions that match the current direction are the easiest to merge. Please open an issue before starting anything large.

## Layout

`pnpm` monorepo:

- `worker/`: the ingestion pipeline (TypeScript, Temporal)
- `packages/*`: the SDK (with its `/embed` subpath), CLI, `contrib-*` integrations and compatibility clients; `packages/shared` holds shared contracts

Stack: TypeScript (strict), Hono, Postgres, MinIO/S3, Redis, Temporal. Node.js 24 and pnpm 10 are required.

## Development setup

```bash
pnpm install
pnpm --filter @docslurp/worker build
```

Worker tests and local PDF mode count PDF pages with Doppler's `pdfpagecount` (under `prlimit`, from util-linux). Install the
pinned Doppler utilities once per pin with `bash scripts/install-doppler.sh`: it verifies the source tarball pinned in
`worker/doppler.json`, builds it with the worker images' recipe and installs it under `/usr/lib/doppler` (off `PATH`;
`DOCSLURP_DOPPLER_BIN_DIR` points elsewhere if you install it there). On Debian or Ubuntu it installs the build dependencies
itself; elsewhere install a C++ toolchain, CMake, Ninja and the FreeType, Fontconfig, libjpeg, OpenJPEG, libpng, libtiff,
Little CMS and zlib development packages first. Without it, PDF page counts refuse ("pdfpagecount ... is not installed")
and the real-tool tests skip; CI sets `DOCSLURP_REQUIRE_DOPPLER_TOOLS=1` so they cannot.

Local development runs with `NODE_ENV` `development` (or unset). Only there does the worker accept the development-only
settings that weaken untrusted-file protection; anywhere else, including staging and preview, it refuses to start with
any of them set: `QUARANTINE_ENABLED=false`, `DOCSLURP_PARSER_SANDBOX=none`, `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED`,
`DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS`, `QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING` and
`DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB`. ClamAV fails closed on a stale or missing signature database by default, in
development too: keep signatures fresh (`freshclam`), or opt in to a warning for local work with
`DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB=true` in your `.env`. The worker images set `NODE_ENV=production`; pass
`-e NODE_ENV=development` to run one as a local development container.

The web dashboard is not part of this repository, so there is no `pnpm dev` UI host here. Exercise changes through the REST API, the CLI, the SDK or MCP.

## Before you open a pull request

1. `pnpm typecheck`
2. `pnpm test` (server, worker, packages and scripts)
3. `pnpm build`
4. For worker or runtime dependency changes, check the Docker image still builds.

Tests that need third-party PDFs fetch them on first use with `pnpm fixtures:fetch` into the gitignored `.cache/`; never commit them.

Database schema changes go only through `server/db/migrations`: run `pnpm db:new <name>` and write the SQL in the `YYYYMMDDTHHMM_<name>.sql` file it creates (UTC). There is no journal to edit and no number to pick, so two branches never collide; the runner (`server/db/migration-runner.mjs`) applies every file a database has not recorded, in name order, one transaction per file. Tests build their databases by applying the migrations in order.

### Real Postgres and Redis tests

Most tests use an in-memory PGlite database. Tests that need real Postgres (lock contention, concurrent transactions, roles) or Redis read `TEST_DATABASE_URL` and/or `TEST_REDIS_URL` and skip without them. `scripts/run-database-tests.mjs` finds them by those two names, gives each file its own fresh copy of a migrated template database, and fails on any skipped test. CI runs it in the `database integration` job. To run it locally against disposable services:

```bash
docker compose up -d postgres redis   # or any local Postgres/Redis whose databases you can throw away
export TEST_DATABASE_ADMIN_URL=postgres://docslurp:docslurp@127.0.0.1:5432 TEST_DATABASE_TEMPLATE=docslurp_test_tmpl
export TEST_REDIS_URL=redis://127.0.0.1:6379
docker compose exec postgres createdb -U docslurp docslurp_test_tmpl
DATABASE_URL="$TEST_DATABASE_ADMIN_URL/$TEST_DATABASE_TEMPLATE" node server/db/migrate.mjs
node scripts/run-database-tests.mjs [file filter]
```

A new test of this kind just reads `TEST_DATABASE_URL` / `TEST_REDIS_URL`; there is nothing to register. Do not give it its own variable: the runner refuses test files gated on a database or Redis variable it never sets. Never export `TEST_DATABASE_URL` for a whole `pnpm test` run, since every gated file would then share and wipe one database. The server and worker test setups refuse a `TEST_DATABASE_URL` that is not on a loopback host or whose database name does not look disposable (a `test`, `tmp` or `scratch` word, or the runner's `dbtest_<n>`), so a mistyped URL fails loudly instead of writing to your development database.

## Style

- TypeScript strict mode, 2-space indentation, double quotes in server code.
- Keep new code in the package that owns it (routes in `server/`, pipeline stages in `worker/src/stages/`).
- Every LLM or embedding call must log usage as `[ai-usage] <metric> model=<id> input_tokens=<n> output_tokens=<n>` and persist it through the existing usage recorder.
- Add a test for behaviour you change.

## Commits and pull requests

Short imperative subjects ("Fix worker timeout on large PDFs") with a body explaining why. Keep pull requests small, describe user-visible behaviour, and note any environment variable or schema change.

AI-assisted contributions are welcome. You are responsible for reviewing the code, its license compatibility and its tests.

## Licensing of contributions and the CLA

DocSlurp uses different licenses for different parts of the tree (BUSL-1.1, converting to Apache-2.0 after three years, for the server, worker and CLI; MIT for the SDKs, shared contracts and client integrations; see [LICENSE](LICENSE)). To keep that model workable, and to let us offer commercial terms, **every contributor signs the [Contributor License Agreement](CLA.md)** before a pull request can be merged.

- **You keep the copyright** in your contribution. You grant 17th Street Labs, LLC (DocSlurp) a copyright and patent license that includes the right to relicense it, and you confirm the work is yours to contribute. It is modelled on the Apache individual and corporate CLAs.
- **Individuals:** open a pull request. The CLA Assistant bot comments with the exact sentence to reply with; the check turns green once you have signed. You sign once; it covers later pull requests under the same CLA version.
- **Employees:** if your employer may own what you write, ask it to sign the corporate CLA (Part B of [CLA.md](CLA.md)) and email it to **legal@docslurp.io**, listing your GitHub username. Do this before you contribute.
- **Not required:** DocSlurp organization members, and bots such as Dependabot.
- Accepted pull requests are merged in our private monorepo and published here by the exporter, so the commit that lands here may be re-created by the exporter. We keep you as the commit author or credit you by name in the commit message.
- Do not submit code you do not have the right to license, including output copied from other projects. Say so in the pull request if part of your change comes from elsewhere, and name its license.

Questions about the CLA: **legal@docslurp.io**.

## Security and conduct

Report vulnerabilities privately to **legal@docslurp.io** as described in [SECURITY.md](SECURITY.md), not in public issues. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md); conduct reports also go to **legal@docslurp.io**. The name and logo are covered by the [trademark policy](TRADEMARK.md).
