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

## Security-Sensitive Boundaries (mandatory)

These rules are mandatory and override speed and convenience. When in doubt, treat a change as security-sensitive.

**Boundaries in scope:**

- **Untrusted file processing:** anything that reads customer bytes. This covers parsers, converters, OCR, media tools, archive and Office handling, rasterizers, native bindings such as the private PDF engine, and the code that stages inputs and outputs for them.
- **Tenant data boundaries:** organization, workspace, user and API-key scoping in queries, search and vector indexes, storage prefixes, caches, exports, webhooks, MCP tools and chat retrieval.
- **Identity and access:** sessions, API keys and their scopes, OAuth and MCP consent, SSO, CSRF and origin checks.
- **Secrets and egress:** credential storage and distribution, user-supplied URLs, connectors and any outbound fetch driven by user input.
- **Billing and credits:** anything that can let one tenant spend, see or reset another tenant's balance.

**Be extremely careful:**

- Assume every input file and every request field is hostile.
- Fail closed. Never fall back silently to weaker isolation, a broader scope or an unauthenticated path. A missing sandbox, engine or policy is a startup failure or a loud, logged refusal.
- Never widen a default scope. A query, cache key or storage key without an explicit tenant scope is a bug.
- Every boundary change ships with negative tests: cross-tenant access, a revoked or wrong-scope key, and a malicious or oversized file.

**Isolation for untrusted files:**

- Untrusted files must be processed behind a VM or microVM boundary, or something stronger. Firecracker, Cloud Hypervisor and a dedicated VM per job qualify.
- Containers, namespaces, bubblewrap, landlock and seccomp are defense in depth inside that boundary. They are never the boundary on their own.
- In-process parsing of customer bytes inside a process that holds secrets does not qualify, including native bindings loaded into the worker.
- The sandbox host holds the minimum keys it needs, ideally none. It gets no database credentials, no model-provider keys, no auth or encryption secrets and no bucket-wide storage keys. Give it short-lived access scoped to its own input and output objects, no network beyond what the job requires, and no cloud metadata endpoint.

**Council review before merge:**

- Any change touching a boundary above needs a council review before it merges.
- A council is at least two independent reviewers, run as separate agents or models. Give each one the diff, the threat model and the boundary rules, but not the author's conclusion.
- At least one reviewer is adversarial and tries to break the change: escape the sandbox, read another tenant's data, reuse a credential.
- Record each reviewer, their findings and how each was resolved in the pull request. An unresolved high-severity finding blocks the merge.
- Use a draft pull request, never a direct push to `main`. A human owner approves the merge, and deploying the change remains a separate manual decision.

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
- Fake, QA and agent-created accounts use a reserved email domain (`@example.com`, `@<run>.invalid`, `@<name>.test`) so `docslurp_reserved_test_email` (migration 0094) marks them `test` and admin customer metrics exclude them; for an address you cannot choose, use `TEST_ACCOUNT_EMAIL_PATTERNS`.
- Benchmark and evaluation inputs are held-out evidence. Do not hard-code document names, field names or expected values from an evaluation into production code or prompts.

## Licensing

The server, worker and CLI are SSPL-1.0 with an Apache-2.0 future grant; the SDKs, clients (including `contrib-algolia-server`) and `packages/shared` are MIT. New files inherit the license of the package they live in. Do not copy code from incompatibly licensed projects (for example AGPL or GPL sources) into any package.

## Pull requests

Small, focused commits with imperative subjects and a "why" in the body. Run typecheck and tests for the packages you touched before opening a pull request. See `CONTRIBUTING.md`.

**This repository is public.** Push exactly one named branch at a time (`git push origin HEAD:refs/heads/<branch>`), based on `origin/main`. Never `git push --all`, `--mirror`, `--tags` or a glob refspec: local core git directories still hold branches built on the private pre-split DocSlurp/app history (root `46d295e2`), and on 2026-10-27 one such push published 2,602 private commits. Before pushing a branch you did not create in this session, run `scripts/check-public-history.sh <ref>`. If a guard (pre-push hook, ruleset, CI) blocks a push, stop and report it; never work around it.

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
