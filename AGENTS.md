# Repository guidelines for coding agents

DocSlurp is a document and media ingestion service: files go through a configurable pipeline that produces page-by-page Markdown, chunks, embeddings and structured fields, served through search, RAG context and a cited chat endpoint. DocSlurp is live: production holds customer data, so ship schema changes as migrations and keep API and data-model changes compatible unless the owner approves a break.

## Source of truth

This repository (`DocSlurp/docslurp-oss`) owns the server, worker, packages and migrations. The private web application and production operations live in `DocSlurp/app`, which pins this repository at `core/`. Merge core changes to this repository's main before updating the app pin. The former `DocSlurp/docslurp` repository is a read-only historical archive; do not develop or release there. Work directly here.

## Layout

- `server/`: Hono API (`@docslurp/server`). Routes in `server/src/routes/`, services in `server/src/services/`, the Drizzle schema, Postgres migrations, `migrate.mjs` and `seed.ts` in `server/db/`.
- `worker/`: TypeScript ingestion pipeline. Stages live in `worker/src/stages/`.
- `packages/`: `sdk` (with the `@docslurp/sdk/embed` subpath), `cli`, `contrib-astro`, `contrib-search-compat`, `contrib-algolia-server`, `contrib-wordpress`, `estimate` (offline file profiler; the server quotes from its profiles) and `shared` (contracts shared by server and clients).
- `plugins/docslurp`: the DocSlurp plugin for Claude (skills and MCP setup).
- `docs/`: public documentation. Self-host instructions are in `docs/self-host/`.

Keep new code in the package that owns it. `server/` must not import from outside the project packages it declares.

## Prefer native Mastra agent features

When implementing or changing agent behavior, prefer Mastra's native features:
Memory, Signals, Tools, durable agents, background tasks, AgentController,
subagents, channels, and guardrails/processors. Use these for the capabilities
they provide before introducing custom agent loops, execution queues, memory
stores, task controllers, replay journals, or orchestration primitives.

Before choosing an implementation, inspect the installed Mastra version and its
APIs and read the current official documentation for the relevant feature. Use
native persistence and observe/reconnect support for durable agent execution;
keep DocSlurp's tenant authorization, billing/usage accounting, application
projections, and external-workflow integration in thin adapters around it.
Verify required disconnect/reconnect, cancellation, restart, task ownership,
and isolation behavior with tests; a native feature does not replace those
application guarantees.

If a native feature cannot meet a requirement, record the specific gap, the
version/API checked, and why a small adapter or supported upgrade is insufficient
in the design or PR before adding a custom primitive. Reassess existing custom
agent code when touching that capability rather than expanding a duplicate runtime.

Official references: [Mastra docs](https://mastra.ai/docs) (Memory, Signals, Tools),
[durable agents](https://mastra.ai/docs/harness/durable-agents),
[background tasks](https://mastra.ai/docs/harness/background-tasks),
[AgentController](https://mastra.ai/docs/harness/agent-controller),
[channels](https://mastra.ai/docs/channels), and
[guardrails](https://mastra.ai/docs/agents/guardrails).

## Security-Sensitive Boundaries (mandatory)

These rules are mandatory and override speed and convenience. When in doubt, treat a change as security-sensitive.

**Boundaries in scope:**

- **Untrusted file processing:** anything that reads customer bytes. This covers parsers, converters, OCR, media tools, archive and Office handling, rasterizers, native PDF engine bindings, and the code that stages inputs and outputs for them.
- **Tenant data boundaries:** organization, project, user and API-key scoping in queries, search and vector indexes, storage prefixes, caches, exports, webhooks, MCP tools and chat retrieval.
- **Identity and access:** sessions, API keys and their scopes, OAuth and MCP consent, SSO, CSRF and origin checks.
- **Secrets and egress:** credential storage and distribution, user-supplied URLs, connectors and any outbound fetch driven by user input.
- **Billing and credits:** anything that can let one tenant spend, see or reset another tenant's balance.

**Be extremely careful:**

- Assume every input file and every request field is hostile.
- Fail closed. Never fall back silently to weaker isolation, a broader scope or an unauthenticated path. A missing sandbox, engine or policy is a startup failure or a loud, logged refusal.
- Never widen a default scope. A query, cache key or storage key without an explicit tenant scope is a bug.
- Every boundary change ships with negative tests: cross-tenant access, a revoked or wrong-scope key, and a malicious or oversized file.

**Organization isolation (mandatory):** the organization is the only tenant scope. Nothing computed from or for one organization may be served to or reused by another.

- Every cache, memo, dedup or reuse key and every storage key includes the organization id, or an id (project, run, document, API key, or user, since a user belongs to one organization) that belongs to exactly one organization and is used only after its access was checked. Build new cache and reuse keys with `orgScopedCacheKey` from `@docslurp/shared`, which throws without an organization; never fall back to a shared or null scope.
- No cross-organization dedup or reuse of any customer-derived value: uploaded bytes, renders, page images, OCR or vision output, embeddings, model outputs, figures, exports. Identical bytes from two organizations are stored and processed twice.
- Reuse lookups by content hash (embeddings, renders, extraction checkpoints) filter by organization in the query itself; a hash match is never proof of ownership.
- Isolation measures must not cost user-visible latency or throughput; performance is a priority. Put the organization in the key or in the same query's predicate; do not add round trips, locks or lookups per request for isolation alone.
- Accepted, by owner decision (2026-11-16): provider prompt prefix caches shared across organizations (no per-organization prompt salt or `cache_salt`), one shared bounded in-memory LRU per cache with the organization in the key (cross-organization eviction allowed, no per-organization partitions or caps), and timing or volume side channels. Do not reintroduce them without the owner.
- Cache statistics shown to a caller (hits, sizes, timings) are that organization's own, never process-wide.
- A new module-level cache map must be classified in `server/src/__tests__/org-isolation-caches.test.ts`; caches the test cannot see (class fields on long-lived instances, Sets, database tables and storage keyed by content) get the same review in the pull request. Any new cache or reuse path ships with a negative test: organization B never gets organization A's entry with identical inputs, and an unscoped key is refused.
- Reviewers check this rule on every change that adds or changes a cache, a reuse or dedup path, a storage key or a tenant query.

**Isolation for untrusted files:**

- Untrusted files must be processed behind a VM or microVM boundary, or something stronger. Firecracker, Cloud Hypervisor and a dedicated VM per job qualify.
- Containers, namespaces, bubblewrap, landlock and seccomp are defense in depth inside that boundary. They are never the boundary on their own.
- In-process parsing of customer bytes inside a process that holds secrets does not qualify, including native bindings loaded into the worker.
- Compute units that touch customer bytes (VMs, microVMs, sandboxes, containers, warm or standby pools, GPU readers, OCR hosts, parser VM lanes) may be shared and reused across jobs, runs and organizations (owner, 2026-11-16): performance is a priority, and warm reuse is the default. Minimal safeguards, none of which may add a cold start: each job's inputs and outputs live in a per-job workspace that is wiped (or the job process restarted) before the next job uses the unit; results go back only to the job that asked, and a stale job can never read another job's output (a per-job token or the job's own connection); the VM boundary from the worker's secrets above is unchanged; and fairness comes from a fleet-wide cap and fair queueing, with per-organization caps only where they cost no cold start. A unit that fails its reset or verification is destroyed. Residue a hostile file leaves on a shared unit (memory, caches, a subverted guest) for a later job, including another organization's, is an accepted risk; a source quarantine refuses the flagged source for the organization that hit it (per-organization quarantine), so another organization's identical upload may still run on a shared unit.
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
- Every migration must be idempotent: running it twice in a row succeeds and leaves the same schema and data as one run. Use `CREATE TABLE/INDEX/SEQUENCE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE FUNCTION/TRIGGER/VIEW`, a `DO` block that checks the catalog before `ADD CONSTRAINT`, `CREATE TYPE`, `CREATE POLICY` or a rename, `ON CONFLICT` or `NOT EXISTS` on inserts, and a guard on backfills (`WHERE col IS NULL`, never an unguarded `x = x + n`). `worker/src/__tests__/migrations-idempotent.test.ts` runs each migration twice and compares the database, and `scripts/check-migration-safety.mjs` flags the usual causes statically; a migration that is idempotent for a reason the check cannot see says so with `-- idempotent-migration: <why>`.
- Log every LLM or embedding call as `[ai-usage] <metric> model=<id> input_tokens=<n> output_tokens=<n>` (plus `cached_input_tokens=<n>` / `cache_write_input_tokens=<n>` when the provider reports prompt-cache use) and persist usage through the existing recorder with an explicit scope. Keep prompts static first, per-request last, so prefixes stay cacheable; Claude via OpenRouter caches only with `createOpenRouterPromptCacheFetch` on Chat Completions.
- Never commit secrets, `.env` files, model weights or test fixtures with unclear licenses. Third-party fixtures are fetched on first use with `pnpm fixtures:fetch` into the gitignored `.cache/`.
- Fake, QA and agent-created accounts use a reserved email domain (`@example.com`, `@<run>.invalid`, `@<name>.test`) so `docslurp_reserved_test_email` (migration 0094) marks them `test` and admin customer metrics exclude them; for an address you cannot choose, use `TEST_ACCOUNT_EMAIL_PATTERNS`.
- Pricing mechanics (credit multipliers, zero-rated routes, infrastructure costs, margins) stay in `DocSlurp/app`. Core exposes neutral usage and profile data, and a generic seam with an open default for quoting; the customer-visible price list is the only pricing published here.
- Benchmark and evaluation inputs are held-out evidence. Do not hard-code document names, field names or expected values from an evaluation into production code or prompts.

## Scale targets

Ingestion must perform equally well at both ends of the workload:

- **Big:** one uploaded ~1 GB file of 10,000–20,000 pages.
- **Many:** 10,000 files of variable size, from a few KB to a few MB each.

"Equally well" covers latency (time to first searchable text, time to complete) and throughput (pages per minute, pages per $1). Judge every ingestion, extraction, storage or pipeline change against both ends before calling it done:

- memory stays bounded whatever the document size;
- limits scale with page count;
- big documents shard;
- small files batch, so per-file fixed costs such as VM start-up are amortised.

## Licensing

The server, worker and CLI are BUSL-1.1 (free production use up to 16 worker vCPUs and 4 worker/GPU instances; each version converts to Apache-2.0 after three years); the SDKs, clients (including `contrib-algolia-server`) and `packages/shared` are MIT. New files inherit the license of the package they live in. Do not copy code from incompatibly licensed projects (for example AGPL or GPL sources) into any package.

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
