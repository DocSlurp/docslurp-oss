# Self-host docs and system map — design

Date: 2026-10-19
Status: draft for review
Sub-project 1 of 6 in the self-host and deploy program (see "Program decisions").

## Goal

Make self-hosting DocSlurp understandable and repeatable for two audiences with
equal weight: OSS evaluators and small teams who want a working install quickly,
and companies deploying into their own cloud account who need to understand the
system before they run it in production. Success means a reader can, from the
docs alone, see every component and how data and trust flow between them, size
a host, install with Docker Compose, configure it, expose it safely, and operate
it (back up, upgrade, monitor, troubleshoot).

This sub-project documents what exists today. Later sub-projects add their own
pages (sandbox providers, Terraform stacks, wizard, skill) to the structure
created here.

## Program decisions

Agreed during brainstorming; later sub-projects build on these.

- Audience: OSS evaluators/small teams and BYO-cloud companies, equally.
- Order: (1) self-host docs and system map, (2) pluggable parser sandbox,
  (3) Terraform foundation with Fly and AWS stacks, (4) GCP, Vercel and
  Cloudflare stacks, (5) CLI wizard, (6) agent skill. Each gets its own spec,
  plan and pull request.
- Parser sandbox: a provider interface modeled on Mastra's
  `SandboxProvider`/`WorkspaceSandbox` split (descriptor with `id`, `name`,
  `description`, JSON Schema `configSchema`, `probe`, `create`; instance with
  lifecycle, `run`, `info` and optional `staging` and `runJob` capabilities).
  Providers declare their isolation guarantees and the worker enforces a policy.
  Local providers: `bubblewrap` (current behavior), `landlock`, `gvisor`, `none`
  (explicit acknowledgement required). First remote provider: Modal.
- Providers live in-repo under `worker/src/sandbox/providers/<id>/`, loaded by
  dynamic import. No separate published packages for now.
- Terraform: layered modules (`data`, `temporal`, `control-plane`, `workers`,
  `secrets`) per provider sharing one connection contract, composed by thin
  stack roots under `deploy/terraform/stacks/`. Docker Compose remains the local
  stack.
- Temporal: chosen per stack; self-hosted on the stack's Postgres for Docker,
  Fly and VMs, Temporal Cloud suggested for HA AWS/GCP, Temporal Cloud or an
  existing address for Vercel and Cloudflare stacks.
- DocSlurp's own production keeps its private Fly Terraform for now; the OSS Fly
  module mirrors its patterns so a later switch stays cheap.
- Wizard: `docslurp deploy init|plan|check` in `@docslurp/cli`, using
  `node:readline/promises` (no new runtime dependencies), with a
  non-interactive `--answers <file> --yes` mode. Replaces
  `scripts/selfhost-init.mjs`.
- Skill: user-facing, Agent Skills format at `skills/docslurp-self-host/`,
  shipped in the CLI package and installed with `docslurp skill install`.

## Scope

In scope:

- Restructure `docs/self-host.md` into `docs/self-host/` with focused pages.
- Four Mermaid diagrams describing the current system.
- A docs link checker and a Mermaid syntax check in CI.
- A follow-up app PR adding a Self-host chapter to the docs site.

Out of scope: any code change to the server or worker, Terraform, sandbox
providers, wizard, skill. Pages for those are added by their sub-projects. The
overview lists them as planned, without links, until they land.

## Page structure

`docs/self-host/`:

| Page | Contents |
| --- | --- |
| `README.md` | Who self-hosting is for, the system map diagram, a "choose your path" table (Docker Compose available; sandbox providers and Terraform stacks listed as planned) and a page index. |
| `architecture.md` | Component map, ingest sequence, trust boundaries and Compose topology diagrams, each with a short explanation. Links to `docs/architecture.md` for design decisions rather than repeating them. |
| `requirements.md` | Host requirements and sizing: lean vs full worker memory, disk and CPU, how `WORKER_DOC_CONCURRENCY` scales them, which workloads benefit from a GPU, and the parser sandbox's kernel requirements (user namespaces, `systempaths=unconfined`). Figures come from `docs/worker-image.md`, `compose.selfhost.yml` and the worker's memory budget logic in `worker/src/tools/runner.ts`; where no measured figure exists the page says so instead of guessing. |
| `docker-compose.md` | The current quickstart, full worker switch, status and logs, moved from `docs/self-host.md` with light edits. |
| `configuration.md` | The configuration table, storage URIs, LanceDB URIs, Temporal connection (address, namespace, TLS), AI provider keys and OAuth sign-in, moved and consolidated. Deprecated variables stay in a short "removed and deprecated" section. |
| `public-access.md` | Reverse proxy and TLS, the Caddy example, trusted proxies and client IP, `REQUIRE_TRUSTED_PROXY`, moved from the current page. |
| `security.md` | Parser sandbox (what bubblewrap isolates: network, PID, IPC, UTS, filesystem binds; why the worker needs `systempaths=unconfined`; what happens without it), secrets and encryption keys and their rotation caveats, ports that must never be published, malware scanning. |
| `operations.md` | Backups and restore (Postgres, MinIO incl. LanceDB, `.env.selfhost`), upgrades and migrations, monitoring (`/health`, metrics with `METRICS_SECRET`, logs), scaling workers on one host, and a troubleshooting table of known failure messages and fixes. |

`docs/self-host.md` becomes a short pointer to `docs/self-host/README.md` so
existing links keep working. Links elsewhere in the repo (`README.md`,
`docs/README.md`, `AGENTS.md`, other docs) are updated to the new paths.

## Diagrams

Mermaid in Markdown, rendered natively by GitHub. Each describes the current
system only.

1. System map (`flowchart`): clients (REST, SDK, CLI, MCP, OpenAI-compatible
   chat, embeds) → server → Postgres with pgvector, Redis, object storage with
   LanceDB, Temporal → workers → parser sandbox → optional AI providers.
2. Ingest sequence (`sequenceDiagram`): upload → object storage and run record →
   Temporal workflow → worker stages (normalize, detect, split and render,
   extract, embed, index, summarize and structure) → searchable, with progress
   events back to the client.
3. Trust boundaries (`flowchart` with subgraphs): public edge, private network,
   data stores, worker process, sandboxed parsers handling untrusted files;
   annotated with which components hold which secrets.
4. Compose topology (`flowchart`): services in `compose.selfhost.yml`, the
   `full` profile, named volumes and the single loopback host port.

Accuracy rule: service names, ports and volumes match `compose.selfhost.yml`;
stage names match `worker/src/stages/` and `docs/architecture.md`. The
implementer reads those sources when drawing, not memory.

## Checks

- `scripts/check-docs-links.mjs`: verifies relative links and heading anchors in
  `docs/**/*.md`, `README.md` and package READMEs; exits non-zero on a broken
  link. Has its own `node --test` test. Runs in the existing `typecheck` job in `.github/workflows/ci.yml`.
- Mermaid syntax: a script extracts ```` ```mermaid ```` blocks from `docs/` and
  parses each with `@mermaid-js/mermaid-cli` (dev dependency only). Runs in the same CI job.

## App docs site (follow-up PR in DocSlurp/app)

After this PR merges to main and the `core/` pin is updated:

- Add a Self-host chapter to `app/src/components/docs/chapters.ts` with pages
  that import `core/docs/self-host/*.md`, following the existing pattern in
  `app/src/pages/docs/http.astro`.
- Render Mermaid at build time with `rehype-mermaid` (`inline-svg` strategy)
  so pages ship no client JavaScript; theme the SVG for light and dark modes.
- Add a system-map illustration in the style of
  `app/src/components/docs/art/*-art.astro` for the chapter header.
- Extend the existing docs tests (`public-interface-docs.test.ts`) to cover the
  new routes.

## Testing

- Link and Mermaid checks pass locally and in CI.
- Every command in `docker-compose.md` is run against a clean checkout before
  the PR is opened (init, check, up, check --running, health).
- Diagrams are reviewed against the source files listed under "Accuracy rule".

## Risks

- Moving the page breaks external deep links: mitigated by the pointer page.
- Sizing figures can be wrong or stale: only measured figures are stated, each
  with its source.
- Diagrams drift as the system changes: later sub-projects update the
  diagrams they affect as part of their own PRs.
