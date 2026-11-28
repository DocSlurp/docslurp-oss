# Repository guidelines for coding agents

DocSlurp is a document and media ingestion service: files go through a configurable pipeline that produces page-by-page Markdown, chunks, embeddings and structured fields, served through search, RAG context and a cited chat endpoint. DocSlurp is live: production holds customer data, so ship schema changes as migrations and keep API and data-model changes compatible unless the owner approves a break.

## Source of truth

This repository (`DocSlurp/docslurp-oss`) is the open-source core. The hosted API server, web application and production operations live in the private `DocSlurp/app`, which pins this repository at `core/`; merge core changes to `main` here before that pin moves. `DocSlurp/docslurp` is a read-only archive.

- `worker/`: TypeScript ingestion pipeline (stages in `worker/src/stages/`).
- `server/db/`: the database schema, migrations and their runner. There is no API server package here.
- `packages/`: `sdk` (with the `@docslurp/sdk/embed` subpath), `cli`, `shared` (contracts shared by the worker, the server and clients), `estimate` (offline file profiler; the server quotes from its profiles) and the `contrib-*` integrations.
- `plugins/docslurp`: the DocSlurp plugin for Claude (skills and MCP setup).
- `docs/`: public documentation; self-hosting in `docs/self-host/`.

Keep new code in the package that owns it. Setup, test databases and style detail live in [CONTRIBUTING.md](CONTRIBUTING.md); the everyday commands:

- `pnpm install`, then `pnpm --filter @docslurp/worker build`
- `pnpm db:up` (local Postgres, Redis, MinIO and Temporal), `pnpm db:migrate`, `pnpm db:new <name>`
- `pnpm typecheck`, `pnpm test`, `pnpm build` (run for what you touched before a pull request)
- `pnpm fixtures:fetch` (pinned third-party test fixtures into `.cache/`)

Code style: TypeScript strict mode, 2-space indentation, double quotes.

## Security-Sensitive Boundaries (mandatory)

These rules override speed and convenience. When in doubt, treat a change as security-sensitive. `DocSlurp/app` carries the same rules (plus hosted-only notes); change both together.

**Boundaries in scope:**

- **Untrusted file processing:** anything that reads customer bytes. This covers parsers, converters, OCR, media tools, archive and Office handling, rasterizers, native PDF engine bindings, and the code that stages inputs and outputs for them.
- **Tenant data boundaries:** organization scoping of queries, search and vector indexes, storage prefixes, exports, webhooks, MCP tools and chat retrieval (data only, not compute).
- **Identity and access:** sessions, API keys and their scopes, OAuth and MCP consent, SSO, CSRF and origin checks.
- **Secrets and egress:** credential storage and distribution, user-supplied URLs, connectors and any outbound fetch driven by user input.
- **Billing and credits:** anything that can let one tenant spend, see or reset another tenant's balance.

**Defaults on every boundary:**

- Treat every input file and every request field as hostile.
- Fail closed. A missing sandbox, engine or policy is a startup failure or a loud, logged refusal, never a silent fallback to running customer bytes next to secrets, a broader scope or an unauthenticated path.
- Never widen a default scope. A query, cache key or storage key without an explicit tenant scope is a bug.
- Ship boundary changes with negative tests where they apply: cross-organization data access, a revoked or wrong-scope key, a malicious or oversized file.

**Organization data scoping:** the organization is the only tenant scope.

- One organization never receives another organization's data: documents, results, search hits, chat, cached responses or URLs. Queries filter by organization, and storage and cache keys carry the organization (or a project, run or document id that belongs to one). `orgScopedCacheKey` from `@docslurp/shared` builds such a key; a content-hash match is never proof of ownership, so content-hash lookups filter by organization in the same query.
- That is the whole rule. Use the cheapest form (the organization in the key or in the same query's predicate), with no extra round trips, locks, partitions, salts or lookups for isolation. Cache statistics shown to a caller are that organization's own.
- Authenticated and tenant HTTP responses are `private, no-store` (never `public` or `s-maxage`, and never relying on `Vary: Cookie`, which Cloudflare ignores). Tenant file and page URLs are signed and short-lived. Telemetry, analytics, eval datasets and trace stores never receive customer documents, queries, answers or names derived from them.

**Compute is shared (owner, 2026-11-17).** Compute that touches customer bytes (VMs, sandboxes, warm pools, GPU readers, OCR and text hosts, parser lanes) is shared and reused across jobs, runs and organizations, warm by default. Per-organization, per-run or per-job compute isolation is a later enterprise feature: do not add, require or review for fresh or dedicated VMs, unit-to-organization or unit-to-run bindings, per-job wipes or attestation, per-organization cache partitions, prompt salts or `cache_salt`. Residue and timing side channels on shared compute are accepted. Results still go back only to the job that asked, and fairness comes from fleet-wide caps and fair queueing.

**Isolation for untrusted files** protects the worker's secrets, not one tenant from another:

- Untrusted files are processed outside any process that holds secrets, behind a VM or microVM boundary (Firecracker, Cloud Hypervisor, a cloud VM). One shared, warm VM serving many jobs qualifies.
- Containers, namespaces, bubblewrap, landlock and seccomp are defense in depth inside that boundary, never the boundary on their own. In-process parsing of customer bytes in the worker, native bindings included, does not qualify.
- The sandbox host holds the minimum keys it needs, ideally none: no database credentials, model-provider keys, auth or encryption secrets, or bucket-wide storage keys; short-lived access scoped to its own input and output objects; no network beyond what the job requires; no cloud metadata endpoint.

**Council review before merge** for identity and access, secrets and egress, billing, organization data scoping, or the VM boundary between customer bytes and secrets (sharing, reusing or warming compute needs none):

- A council is at least two independent reviewers, run as separate agents or models. Give each the diff, the threat model and these rules, not the author's conclusion. At least one is adversarial: read another organization's data, reuse a credential, escape to the secrets. Shared-compute residue is out of scope for them.
- Record each reviewer, their findings and each resolution in the pull request. An unresolved high-severity finding blocks the merge.
- Use a draft pull request. A human owner approves the merge; deploying is a separate manual decision.

## Conventions

- **Migrations:** schema changes go only through `server/db/migrations`; tests build databases by applying them in order.
  - New files are `YYYYMMDDTHHMM_name.sql` (UTC; `pnpm db:new <name>`). The numbered `NNNN_` files are frozen: add, renumber or edit none of them. A shipped file is never edited or renamed either, since downstream deployments copy this folder file for file.
  - There is no journal: `server/db/migration-runner.mjs` records each applied file by name in `docslurp_migrations.applied` and applies every unrecorded file in name order, one transaction per file, so a late-merged migration still runs. Write each to apply cleanly both in name order (a fresh database) and after everything already on `main` (`worker/src/__tests__/migrations-late-merge.test.ts`).
  - Keep each file short (one table rewrite or index build): it waits at most `MIGRATION_STATEMENT_LOCK_TIMEOUT_MS` for a lock and is retried.
  - Every migration is idempotent: two runs leave the same schema and data as one. Use `IF NOT EXISTS` / `IF EXISTS`, `CREATE OR REPLACE`, a `DO` block that checks the catalog before `ADD CONSTRAINT`, `CREATE TYPE`, `CREATE POLICY` or a rename, `ON CONFLICT` or `NOT EXISTS` on inserts, and guarded backfills (`WHERE col IS NULL`, never an unguarded `x = x + n`). `worker/src/__tests__/migrations-idempotent.test.ts` runs each twice and `scripts/check-migration-safety.mjs` flags the usual causes; mark an exception the check cannot see with `-- idempotent-migration: <why>`.
- **Model usage:** log every LLM or embedding call as `[ai-usage] <metric> model=<id> input_tokens=<n> output_tokens=<n>` (plus `cached_input_tokens=<n>` / `cache_write_input_tokens=<n>` when the provider reports prompt-cache use) and persist it through the existing recorder with an explicit scope. Order prompts static first, per-request last so prefixes stay cacheable; Claude via OpenRouter caches only with `createOpenRouterPromptCacheFetch` (`packages/shared`) on Chat Completions.
- **Test accounts:** fake, QA and agent-created accounts use a reserved domain (`@example.com`, `@<run>.invalid`, `@<name>.test`), which `docslurp_reserved_test_email` (migration 0094) marks `test` so customer metrics exclude them; for an address you cannot choose, use `TEST_ACCOUNT_EMAIL_PATTERNS`.
- **Pricing:** core exposes neutral usage and profile data and a generic quoting seam with an open default; the customer-visible price list is the only pricing published here. Credit multipliers, zero-rated routes, infrastructure costs and margins stay in `DocSlurp/app`.
- **Evaluation inputs are held-out evidence:** production code and prompts stay free of document names, field names or expected values from an evaluation.
- **Committed files:** secrets, `.env` files, model weights and fixtures with unclear licenses stay out of Git; third-party fixtures arrive on first use through `pnpm fixtures:fetch` into the gitignored `.cache/`.

## Scale targets

Ingestion must perform equally well at both ends of the workload:

- **Big:** one uploaded ~1 GB file of 10,000–20,000 pages.
- **Many:** 10,000 files of variable size, from a few KB to a few MB each.

"Equally well" covers latency (time to first searchable text, time to complete) and throughput (pages per minute, pages per $1). Judge every ingestion, extraction, storage or pipeline change against both ends before calling it done: memory stays bounded whatever the document size, limits scale with page count, big documents shard, and small files batch so per-file fixed costs such as VM start-up are amortised.

## Licensing

The worker, `server/db/` and the CLI are BUSL-1.1 (free production use up to 16 worker vCPUs across at most 4 worker or GPU instances; each version converts to Apache-2.0 after three years). The SDKs, clients (including the `contrib-*` packages) and `packages/shared` are MIT. New files take the license of their package; code from incompatibly licensed projects (for example AGPL or GPL sources) stays out of every package. See [LICENSE](LICENSE).

## Git and pull requests

**This repository is public.** Push exactly one named branch at a time with an explicit refspec, `git push origin HEAD:refs/heads/<branch>`, based on `origin/main`. Local core Git directories still hold branches built on the private pre-split history (root `46d295e2`), and on 2026-10-27 one bulk push published 2,602 private commits: `--all`, `--mirror`, `--tags` and glob refspecs are off limits. Before pushing a branch you did not create in this session, run `scripts/check-public-history.sh <ref>`. If a guard (pre-push hook, ruleset, CI) blocks a push, stop and report it; never work around it.

- **Branching:** create task branches with `git switch --no-track -c <branch> origin/main`. A branch that tracks `origin/main` pushes straight to `main` under `push.default=upstream`; check that push output reads `HEAD -> <branch>`.
- **Forward-only history:** catch a branch up by merging `origin/main` into it, fix mistakes with a new commit, undo with `git revert`. Rebase, amend, `reset --hard`, force pushes and `filter-branch` are never used.
- **Stay in sync:** fetch and merge `origin/main` (and the branch's upstream) before starting, committing and pushing; push each commit soon after making it. Finish only when `git status -sb` shows neither `ahead` nor `behind` on every branch you worked on (`main` included), in every worktree you used.
- **Commits and merges:** small, focused commits with imperative subjects and a "why" in the body (see `CONTRIBUTING.md`). Squash-merge with `gh pr merge --squash`; for a PR stacked on one just squash-merged, merge the new `main` into it and retarget it to `main`.
- **Releases:** follow [docs/releases.md](docs/releases.md). All public libraries share a version and release together through `release-npm.yml`; publish or push release tags only on an explicit release request.

## Production performance investigations

During production tests or tuning, inspect logs and traces before the run, at least every five minutes while it is active, and after it. Use [dependency tracing](docs/dependency-tracing.md) for attribution and verification. Keep provider costs separate from customer credits and deduplicate usage receipts. Create a recurring scheduler only when explicitly asked.
