# Repository guidelines for coding agents

DocSlurp is a document and media ingestion service: files go through a configurable pipeline that produces page-by-page Markdown, chunks, embeddings and structured fields, served through search, RAG context and a cited chat endpoint. This repository is pre-release: breaking changes to APIs and data models are acceptable, so prefer the cleanest design over compatibility shims.

## Source of truth

This repository (`DocSlurp/docslurp-oss`) owns the server, worker, packages and migrations. The private web application and production operations live in `DocSlurp/app`, which pins this repository at `core/`. Merge core changes to this repository's main before updating the app pin. The former `DocSlurp/docslurp` repository is a read-only historical archive; do not develop or release there. Work directly here; exports from the archive are retired.

## Layout

- `server/`: Hono API (`@docslurp/server`). Routes in `server/src/routes/`, services in `server/src/services/`, the Drizzle schema, Postgres migrations, `migrate.mjs` and `seed.ts` in `server/db/`.
- `worker/`: TypeScript ingestion pipeline. Stages live in `worker/src/stages/`.
- `packages/`: `sdk` (with the `@docslurp/sdk/embed` subpath), `cli`, `contrib-astro`, `contrib-search-compat`, `contrib-algolia-server`, `contrib-wordpress` and `shared` (contracts shared by server and clients).
- `docs/`: public documentation. Self-host instructions are in `docs/self-host/`.

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

Never rewrite git history; always move forward with new commits. Do not use `git rebase`, `git commit --amend`, `git reset --hard`, `git push --force`/`--force-with-lease`, `git filter-branch` or similar. To catch a branch up, merge `main` into it and resolve conflicts in the merge commit. To fix a mistake, commit the corrected state on top. To undo a commit, `git revert` it.

Keep every branch in sync with its remote. Fetch and merge `origin/main`, plus the current branch's upstream when it has one, before you start work, before you commit and before you push. Push each commit soon after making it, so unpushed commits never pile up locally and the remote never moves far ahead of you. Before you finish a task, `git status -sb` must show neither `ahead` nor `behind` on the branch you worked on (`main` included). If it does, merge and push at once, resolving conflicts in a merge commit. This applies in every worktree.

Squash-merge pull requests into `main` (`gh pr merge --squash`) so each PR lands as one commit. For a PR stacked on a branch that was just squash-merged, merge the new `main` into it and retarget its base to `main`.

## Releases

Follow [docs/releases.md](docs/releases.md). All public libraries share a version and release together through release-npm.yml. Do not publish or push release tags without an explicit release request.

## Production performance investigations

During production tests or tuning, inspect logs and traces before, at least every
five minutes during active experiments, and after the run. Use
[dependency tracing](docs/dependency-tracing.md) for attribution and verification.
Keep provider costs separate from customer credits and deduplicate usage receipts.
Do not create a recurring scheduler unless explicitly requested.
