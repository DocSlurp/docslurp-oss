# Self-host docs and system map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `docs/self-host.md` into focused pages under `docs/self-host/`, add four Mermaid diagrams of the current system, and add CI checks for doc links and Mermaid syntax.

**Architecture:** Pure documentation plus two zero-dependency Node scripts. Tasks 1–3 touch disjoint files and run in parallel; Task 4 integrates, runs the checks over the finished pages and verifies the Compose quickstart.

**Tech Stack:** Markdown, Mermaid, Node 20+ ESM scripts tested with `node --test`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-19-self-host-docs-design.md`

## Global Constraints

- Document only what exists today. Sandbox providers, Terraform stacks, the wizard and the skill appear in the overview as "planned", without links.
- Every service name, port, volume, env var and stage name is copied from source (`compose.selfhost.yml`, `.env.selfhost.example`, `worker/src/stages/`, `docs/architecture.md`, `worker/scripts/parser-sandbox.sh`), not memory.
- Sizing: state only measured figures, each with its source; where none exists, say so.
- Prose style: plain, direct, no marketing language; 2-space indentation in any code; double quotes in JS.
- No new runtime dependencies. No new root devDependency for Mermaid (see Task 1 deviation note).
- Do not commit. The coordinator reviews and commits each task. Touch only the files your task lists.
- Fixed anchors other pages link to (GitHub slug of the heading):
  - `configuration.md#storage-configuration` (heading `## Storage configuration`; `docker-compose.yml` links here)
  - `security.md#parser-sandbox` (heading `## Parser sandbox`)
  - `operations.md#backups-and-restore`, `operations.md#upgrades`, `operations.md#troubleshooting`
  - `requirements.md#sizing`
  - `architecture.md#system-map`, `architecture.md#trust-boundaries`

## Review Focus

1. A reader following `docker-compose.md` on a clean checkout hits a command that no longer works after the move (wrong relative path to `scripts/` or `compose.selfhost.yml`). Task 4 runs every command.
2. Old deep links (`docs/self-host.md#storage-configuration`, `#public-access`) land on the pointer page with no way forward: the pointer page lists where each old section went. Task 2 pins this; Task 1's checker validates it.
3. Link checker false positives on anchors with punctuation, duplicate headings, or headings containing inline code: Task 1 tests pin the GitHub slug rules.
4. Links inside fenced code blocks (e.g. URL examples) are reported as broken: Task 1 test pins that fenced content is ignored.
5. A Mermaid diagram that renders on GitHub fails the CLI parser (or the reverse) because of unquoted labels with parentheses or slashes: Task 3 quotes every label containing punctuation; Task 4 runs the check.

---

### Task 1: Doc link checker and Mermaid check

**Files:**
- Create: `scripts/check-docs-links.mjs`, `scripts/check-docs-links.test.mjs`
- Create: `scripts/check-docs-mermaid.mjs`
- Modify: `package.json` (add `"docs:check"` script), `.github/workflows/ci.yml` (typecheck job)

**Interfaces:**
- Produces: `node scripts/check-docs-links.mjs [files...]` — exit 0 when clean, 1 with one `path:line: broken link <target>` line per failure. Default file set: `README.md`, `docs/**/*.md` (excluding `docs/superpowers/**`), `packages/*/README.md`.
- Produces: exported `githubSlug(text: string): string`, `extractLinks(markdown: string): Array<{ target: string; line: number }>`, `checkFile(path: string): Array<{ line: number; target: string }>` from `check-docs-links.mjs` (guard CLI execution with an `import.meta.url` main check).
- Produces: `node scripts/check-docs-mermaid.mjs` — extracts every ```` ```mermaid ```` block from the same default file set, writes each to a temp `.mmd`, renders with `mmdc`, exit 1 listing `path:line` of each failing block.

- [ ] **Step 1: Write failing tests** in `scripts/check-docs-links.test.mjs` (node:test, node:assert/strict, temp dir via `mkdtempSync`):
  - `githubSlug("Storage configuration") === "storage-configuration"`
  - `githubSlug("Client IP behind a proxy or CDN") === "client-ip-behind-a-proxy-or-cdn"`
  - `githubSlug("Data, upgrades, and recovery") === "data-upgrades-and-recovery"`
  - `githubSlug("`STORAGE_URI` options") === "storage_uri-options"` (backticks dropped, underscores kept)
  - duplicate headings: a file with two `## Setup` headings resolves `#setup` and `#setup-1`, and `#setup-2` is broken
  - `extractLinks` ignores links inside fenced code blocks and inline code, and skips `http:`, `https:`, `mailto:` targets
  - relative file link to a missing file is broken; link to an existing directory is valid; `other.md#missing-anchor` is broken; `#anchor` in the same file is checked
  - reference-style links (`[x][ref]` with `[ref]: path.md`) are checked
- [ ] **Step 2: Run** `node --test scripts/check-docs-links.test.mjs` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `scripts/check-docs-links.mjs`. Slug rule (GitHub): lowercase; strip inline-code backticks and markdown emphasis; remove every char not in `[\p{L}\p{N}\s_-]` (Unicode-aware); spaces → `-`; duplicates get `-1`, `-2`. Anchors also accept explicit `<a id="...">`/`<a name="...">`. Headings inside fenced blocks are not anchors.
- [ ] **Step 4: Run** `node --test scripts/check-docs-links.test.mjs` — expect PASS.
- [ ] **Step 5: Run** `node scripts/check-docs-links.mjs` against the current tree. Fix pre-existing broken links in files other than `docs/self-host.md`, `README.md`, `AGENTS.md`, `docs/README.md` (those belong to Task 2) by correcting the link; list any you could not resolve in your report.
- [ ] **Step 6: Implement** `scripts/check-docs-mermaid.mjs`. Deviation from spec, deliberate: run the CLI with `npx --yes @mermaid-js/mermaid-cli@<pinned 11.x version — look up the current latest 11.x on npm and pin it exactly> -i <file> -o <file>.svg -p <puppeteer.json>` instead of a root devDependency, because the package pulls Chromium through puppeteer at install time for every contributor. `puppeteer.json` (written to the temp dir) is `{"args":["--no-sandbox"]}`. Allow override via `MMDC` env var pointing to a local binary. Exit 0 with "no mermaid blocks" when none exist.
- [ ] **Step 7: Wire** `package.json`: `"docs:check": "node scripts/check-docs-links.mjs && node scripts/check-docs-mermaid.mjs"`. The new test file is already picked up by `test:scripts` (`scripts/*.test.mjs`) — verify with `pnpm test:scripts`.
- [ ] **Step 8: Wire CI**: in `.github/workflows/ci.yml` job `typecheck`, after the migration-safety step, add steps `- name: Check doc links` → `run: node scripts/check-docs-links.mjs` and `- name: Check Mermaid diagrams` → `run: node scripts/check-docs-mermaid.mjs`.
- [ ] **Step 9: Verify** `pnpm test:scripts` passes and `node scripts/check-docs-mermaid.mjs` exits 0 on a scratch file with a valid flowchart and 1 on one with a syntax error (create both under a temp dir and pass paths as args; do not leave them in the repo).

### Task 2: Move existing content into focused pages

**Files:**
- Create: `docs/self-host/docker-compose.md`, `docs/self-host/configuration.md`, `docs/self-host/public-access.md`, `docs/self-host/operations.md`
- Modify: `docs/self-host.md` (becomes pointer), `README.md:37`, `AGENTS.md:14`, `docs/README.md:7`, `docker-compose.yml:3`

**Interfaces:**
- Consumes: the fixed anchors in Global Constraints (must create the ones it owns: `configuration.md#storage-configuration`, `operations.md#backups-and-restore`, `#upgrades`, `#troubleshooting`).
- Links to Task 3 pages by filename only: `README.md`, `architecture.md`, `requirements.md`, `security.md` (anchors `security.md#parser-sandbox`, `requirements.md#sizing`).

- [ ] **Step 1: `docker-compose.md`**: move "Requirements" (short; link to `requirements.md#sizing` for detail), "Start", status/logs, the full-worker switch and stop/down commands from `docs/self-host.md`. Fix relative links (now one directory deeper: `../../.env.selfhost.example`, `../worker-image.md`). Commands stay run-from-repo-root and say so once at the top.
- [ ] **Step 2: `configuration.md`**: move "Configuration" table and "Storage configuration" (keep that exact heading) including vector indexes; add a "Temporal connection" section listing `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and the `TEMPORAL_TLS_*` variables read in `worker/src/temporal/worker.ts` and `server/src/lib/temporal.ts` (names copied from source, one line each on purpose); add "Removed and deprecated" with the pre-URI variables paragraph. Cross-check every variable against `.env.selfhost.example` and `compose.selfhost.yml`; add any first-run option from `.env.selfhost.example` missing from the table.
- [ ] **Step 3: `public-access.md`**: move "Public access" and "Client IP behind a proxy or CDN" verbatim except relative link fixes (`../../packages/shared/src/cloudflare-ips.ts`). Keep the "do not publish ports" paragraph but link it to `security.md`.
- [ ] **Step 4: `operations.md`**: sections `## Backups and restore` (Postgres via `pg_dump` in the `postgres` service, MinIO bucket incl. `lancedb/` prefix via `mc mirror` in the `createbucket` image, `.env.selfhost`; restore order; "test restores on a separate host"), `## Upgrades` (moved text), `## Monitoring` (`/health`, metrics endpoint and `METRICS_SECRET` — read `server/src` to confirm path and auth header; container logs), `## Scaling workers on one host` (`WORKER_DOC_CONCURRENCY`, `--scale worker=N`, memory note linking `requirements.md#sizing`), `## Troubleshooting` (table: symptom/message → cause → fix; include at least `parser isolation unavailable` (find its source with grep across `worker/`), migrate service non-zero exit, `Missing .env.selfhost`, full worker first-boot pip install taking long, MinIO credentials changed after first start, Postgres password not rotating). Every message string must be grep-able in the repo.
- [ ] **Step 5: Pointer page** `docs/self-host.md`: one paragraph pointing to `self-host/README.md`, then a table mapping each old heading (Requirements, Start, Configuration, Storage configuration, Public access, Client IP behind a proxy or CDN, Data, upgrades, and recovery) to its new page and anchor. Keep `<a id="storage-configuration"></a>` and `<a id="public-access"></a>` anchors on the matching rows so old deep links still resolve.
- [ ] **Step 6: Update links**: `README.md:37` → `docs/self-host/README.md`; `AGENTS.md:14` → `docs/self-host/`; `docs/README.md:7` → `self-host/README.md`; `docker-compose.yml:3` comment → `docs/self-host/configuration.md#storage-configuration`.
- [ ] **Step 7: Verify** nothing from the old page was dropped: diff the old file's paragraphs against the new pages (`git show HEAD:docs/self-host.md`) and report any intentionally removed sentence with the reason.

### Task 3: Overview, architecture, requirements and security pages

**Files:**
- Create: `docs/self-host/README.md`, `docs/self-host/architecture.md`, `docs/self-host/requirements.md`, `docs/self-host/security.md`

**Interfaces:**
- Consumes: fixed anchors owned by Task 2 (`configuration.md#storage-configuration`, `operations.md#...`) — link to them by exact anchor.
- Produces: `architecture.md#system-map`, `architecture.md#trust-boundaries`, `requirements.md#sizing`, `security.md#parser-sandbox`.

- [ ] **Step 1: `architecture.md`** with four sections, each a Mermaid block plus 3–6 sentences:
  - `## System map` — `flowchart LR`: clients (REST, SDK, CLI, MCP, OpenAI-compatible chat, embeds) → server (Hono, `/v1`, port 8787) → Postgres+pgvector, Redis (rate limits, ephemeral), object storage (S3/MinIO) with LanceDB under `lancedb/`, Temporal; Temporal → workers → parser sandbox; workers → Postgres, storage, LanceDB; workers/server → optional AI providers (dashed).
  - `## Ingest sequence` — `sequenceDiagram`: client, server, object storage, Postgres, Temporal, worker. Stages named as in `docs/architecture.md` (normalize, detect, split and render, extract, embed, index, summarize and structure); confirm against `worker/src/stages/` and the workflow in `worker/src/temporal/`. Show progress events streamed back to the client.
  - `## Trust boundaries` — `flowchart` with subgraphs: Internet/public edge (reverse proxy), private network, data stores, worker process, sandbox (untrusted file parsing, no network). Annotate which components hold `DATABASE_URL`, storage credentials, `BETTER_AUTH_SECRET`, the `*_ENCRYPTION_KEY`s, AI keys (read `compose.selfhost.yml` env blocks for server vs worker to get this right).
  - `## Compose topology` — `flowchart`: every service in `compose.selfhost.yml` incl. one-shot `createbucket` and `migrate`, the `full` profile's `worker-full`, named volumes, and the single host binding `${SERVER_BIND_ADDRESS:-127.0.0.1}:${SERVER_PORT:-8787}`.
  - Quote every node label containing punctuation (`A["Postgres + pgvector"]`). Link to `../architecture.md` for design decisions.
- [ ] **Step 2: `requirements.md`**: `## Host requirements` (Docker Engine + Compose v2, kernel with unprivileged user namespaces and the `systempaths=unconfined` allowance, Node for setup only, disk), `## Sizing` (table: lean vs full worker image sizes from `../worker-image.md` "Measured sizes"; RAM from the current guidance "at least 8 GB" and the per-command RSS budget logic in `resolveCommandRssBudgetMb`/`resolveContainerMemoryLimitMb` in `worker/src/tools/runner.ts` — describe how it derives from the container limit, do not invent per-document numbers; vendor bundle unpack sizes; note what scales with `WORKER_DOC_CONCURRENCY`), `## GPU` (which optional paths can use one; say explicitly that the default stack needs none). Every number cites its source file.
- [ ] **Step 3: `security.md`**: `## Parser sandbox` — from `worker/scripts/parser-sandbox.sh` and `resolveParserSandboxSettings`: what is unshared (net, pid, ipc, uts), fresh `/proc`, read-only vs writable binds, env allowlist (`DOCSLURP_PARSER_ENV_ALLOWLIST`), always on in production, why Compose sets `systempaths=unconfined` while still `cap_drop: [ALL]` and seccomp, the error a reader sees without it, and which commands bypass the sandbox (vector writer, embed pool) and why. `## Malware scanning` (ClamAV policy env vars from `resolveMalwareScanPolicy`). `## Secrets and encryption keys` (each generated key, what it protects, rotation caveats from the old page). `## Network exposure` (ports never to publish; link `public-access.md`).
- [ ] **Step 4: `README.md` (overview)**: who self-hosting is for (two audiences, one sentence each); the system-map diagram (same Mermaid as `architecture.md#system-map`, so GitHub renders it on the landing page); `## Choose your path` table — Docker Compose single host (available, link `docker-compose.md`); pluggable parser sandbox providers, Terraform stacks (Fly, AWS, GCP, Vercel, Cloudflare, Modal workers), `docslurp deploy` wizard, agent skill — all "planned", no links; `## Pages` index linking all eight pages with one line each.

### Task 4: Integrate and verify (coordinator)

**Files:** any page from Tasks 2–3 needing fixes.

- [ ] **Step 1:** `node scripts/check-docs-links.mjs` — expect exit 0; fix any break.
- [ ] **Step 2:** `node scripts/check-docs-mermaid.mjs` — expect exit 0 with 5 blocks rendered (4 in `architecture.md`, 1 in `README.md`).
- [ ] **Step 3:** `pnpm test:scripts` — expect PASS.
- [ ] **Step 4:** Review diagrams against `compose.selfhost.yml` and `worker/src/stages/` (Global Constraints accuracy rule).
- [ ] **Step 5:** In a fresh `git worktree` of the branch, run every command in `docker-compose.md` in order (init, check, up -d --build, check --running, `curl -fsS http://localhost:8787/health`), then `down` (no `--volumes` except for the throwaway project). Use `--project-name` to avoid clashing with any existing local stack. Record the outcome in the PR body.
- [ ] **Step 6:** Commit per task with imperative subjects and a why-body, push, open the PR.
