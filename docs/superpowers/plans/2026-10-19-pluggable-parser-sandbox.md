# Pluggable parser sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-wired bubblewrap launcher with a provider interface (`bubblewrap`, `landlock`, `modal`, `none`) selected by `DOCSLURP_PARSER_SANDBOX`, enforced by a production isolation policy, with per-activity sessions.

**Architecture:** `worker/src/sandbox/` holds the types, config-schema validator, policy, registry, generic path resolution, session context (AsyncLocalStorage) and a Temporal activity interceptor. Providers live in `worker/src/sandbox/providers/<id>/` and are loaded by dynamic import. `CommandRunner.spawn` asks the current session to spawn (local) or run (remote); its public API is unchanged, so stages are unchanged.

**Tech Stack:** TypeScript strict (Node 24), vitest, Temporal TS SDK interceptors, bubblewrap, landrun (MIT, ≥ v0.1.12), `modal` npm package (optional dependency), GitHub Actions + GHCR.

**Spec:** `docs/superpowers/specs/2026-10-19-pluggable-parser-sandbox-design.md`

## Global Constraints

- TypeScript strict, 2-space indentation, double quotes. Tests with vitest under `worker/src/**/__tests__/` or `*.test.ts` beside the code, matching existing patterns.
- Pre-release: remove `DOCSLURP_PARSER_SANDBOX_ENABLED`, `DOCSLURP_PARSER_SANDBOX_MODE`, `DOCSLURP_PARSER_SANDBOX_SCRIPT` with no compatibility shims. Keep `DOCSLURP_PARSER_SANDBOX_ROOT`, `DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS`.
- Default unchanged: unset `DOCSLURP_PARSER_SANDBOX` → `bubblewrap` on Linux; `none` on macOS outside production.
- Production policy: `filesystem: true` and `network` in {`tcp-only`, `full`}; `none` only with `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true` plus a warn log `[parser-sandbox] status=unisolated` on every start.
- Startup log line exactly: `[parser-sandbox] provider=<id> filesystem=<bool> network=<level> processes=<bool> location=<local|remote>`.
- Probe failure message stays `parser isolation unavailable: <detail>`.
- Never log secrets (`MODAL_TOKEN_SECRET`, any `secret: true` schema property).
- landrun only from a release ≥ v0.1.12 (MIT); earlier tags are GPL-2.0 and forbidden. Pin version + sha256 in `worker/sandbox-tools.json`; record in `THIRD_PARTY_NOTICES.md`.
- `modal` is an `optionalDependencies` entry of `@docslurp/worker`, loaded only by the modal provider via dynamic import; pin an exact version.
- Modal usage: log `[sandbox-usage] provider=modal cpu_seconds=<n> memory_gb_seconds=<n> activity=<id>` and record via `buildLocalComputeUsageEvent` (`worker/src/pipeline/local-compute-cost.ts`) with provider `modal`; provider cost stays separate from customer credits.
- No image publishing, tags or releases. The images workflow runs only on release tags and `workflow_dispatch`.
- Never rewrite git history. Commit small, imperative subject, why-body.

## Review Focus

1. Two concurrent activities sharing one `CommandRunner` must each get their own session; a command in activity A must never run in activity B's sandbox. Test in Task 3.
2. An activity that throws or is cancelled must still close its session (a leaked Modal sandbox bills until timeout). Test in Task 3 (interceptor) and Task 5 (provider `close` on abort).
3. A remote command whose declared writable path it never creates must behave like local: no error from staging, no file appears. Test in Task 5.
4. Unset `DOCSLURP_PARSER_SANDBOX` with `NODE_ENV=production` on Linux resolves to `bubblewrap` and passes policy — today's deployments keep working with no config change. Test in Task 1.
5. Probe `detail` strings and error messages never contain secret config values. Test in Task 1 (config-schema redaction helper) and Task 5.

---

### Task 0: Fargate Landlock spike (controller, throwaway)

Not code that ships. Run by the controller with the user's AWS CLI credentials (region `us-west-1`).

- [ ] Build a probe image (Debian slim + bubblewrap + landrun ≥ v0.1.12) whose entrypoint prints `uname -r`, `cat /sys/kernel/security/lsm`, and the exit status + stderr of `unshare --user true`, `bwrap --unshare-all --ro-bind / / true`, `landrun --rox /usr --ro /lib,/lib64,/etc true`, and a landrun TCP-deny check (`landrun --rox /usr ... curl -m 3 https://example.com` must fail).
- [ ] Push to a temporary ECR repo, run once as a Fargate task (platform LATEST, 0.25 vCPU / 0.5 GB, awslogs), collect logs.
- [ ] Tear down every resource created (task definition deregistered, ECR repo deleted, log group deleted, cluster deleted if created) and list what was deleted. All resources tagged `docslurp-spike=sandbox`.
- [ ] Record results (raw output) for Task 8. Cloud Run is not run (no gcloud on this host); record that.

### Task 1: Sandbox core — types, config schema, policy, registry, `none`

**Files:**
- Create: `worker/src/sandbox/types.ts`, `config-schema.ts`, `policy.ts`, `registry.ts`, `providers/none/index.ts`
- Test: `worker/src/sandbox/__tests__/config-schema.test.ts`, `policy.test.ts`, `registry.test.ts`

**Interfaces:**
- Produces (types.ts): exactly the spec's `SandboxNetworkIsolation`, `SandboxIsolation`, `SandboxProbeResult`, `SandboxLimits`, `SandboxCommand`, `SandboxResult`, `SandboxSession`, `ParserSandboxProvider<C>`; plus `SandboxConfigSchema = { type: "object"; properties: Record<string, { type: "string" | "number" | "boolean"; description: string; default?: string | number | boolean; secret?: boolean; env: string }>; required?: string[] }` (`env` names the environment variable each property reads).
- Produces (config-schema.ts): `readSandboxConfig<C>(schema: SandboxConfigSchema, env: NodeJS.ProcessEnv): C` (coerces numbers/booleans, applies defaults, throws `SandboxConfigError` listing every missing required / wrongly typed property by env name, never including values) and `redactSandboxConfig(schema, config): Record<string, unknown>` (secret values → `"[redacted]"`).
- Produces (policy.ts): `assertSandboxPolicy(args: { providerId: string; isolation: SandboxIsolation; env: NodeJS.ProcessEnv }): { warnings: string[] }` — throws `SandboxPolicyError` on violation.
- Produces (registry.ts): `SANDBOX_PROVIDER_IDS = ["bubblewrap", "landlock", "modal", "none"] as const`; `resolveSandboxProviderId(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): SandboxProviderId`; `loadSandboxProvider(id): Promise<ParserSandboxProvider>` (dynamic import of `./providers/<id>/index.js`, default export).
- Produces (providers/none): provider with `configSchema` `{ type: "object", properties: {} }`, `probe` → `{ ok: true, isolation: all false + location "local", detail: "no isolation" }`, session `spawn` = `child_process.spawn(binary, args, { env, stdio: ["ignore","pipe","pipe"], signal })`.

- [ ] **Step 1: Write failing tests.**
  - registry: unset + `linux` → `"bubblewrap"`; unset + `darwin` + no `NODE_ENV` → `"none"`; unset + `darwin` + `NODE_ENV=production` → `"bubblewrap"`; `DOCSLURP_PARSER_SANDBOX=landlock` → `"landlock"`; `=bogus` throws with message containing `bubblewrap, landlock, modal, none`; `loadSandboxProvider("none")` returns a provider whose `id === "none"`.
  - policy (table test): production × {fs true/net full → ok; fs true/net tcp-only → ok; fs true/net none → throws; fs false → throws; provider none without ALLOW → throws; provider none with `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true` → ok with warnings `["[parser-sandbox] status=unisolated"]`}; development × any isolation → ok, no throw.
  - config-schema: defaults applied; `"8"` → `8` for number; `"true"`/`"false"` → boolean; missing two required → one error naming both env vars; a secret property's value never appears in the error message or in `redactSandboxConfig` output.
- [ ] **Step 2: Run** `pnpm --filter @docslurp/worker exec vitest run src/sandbox` — expect FAIL (modules missing).
- [ ] **Step 3: Implement** the five files per Interfaces.
- [ ] **Step 4: Run** the same command — expect PASS. Run `pnpm --filter @docslurp/worker typecheck`.
- [ ] **Step 5: Commit.**

### Task 2: Generic path resolution, bubblewrap provider, contract suite

**Files:**
- Create: `worker/src/sandbox/paths.ts`, `worker/src/sandbox/providers/bubblewrap/index.ts`, `worker/src/sandbox/__tests__/contract.ts`, `worker/src/sandbox/__tests__/contract-local.test.ts`
- Move: `worker/scripts/parser-sandbox.sh` stays where it is (Dockerfiles and the prerequisites script reference it); the provider resolves it via `resolveScriptsDir()`.
- Modify: `worker/src/tools/runner.ts` — move `resolveSandboxReadablePaths`, `resolveSandboxWritablePaths`, `withoutCoveredPaths`, `inferDocslurpTempWorkspace`, `inferDocslurpTempAncestor` into `sandbox/paths.ts` (exported), re-import them in runner.ts. No behavior change in this task.

**Interfaces:**
- Consumes: Task 1 types.
- Produces (paths.ts): `resolveCommandPaths(args: { plan: CommandPlan; venvBin: string; scratchRoot: string; configuredWritablePaths: string[]; scriptsDir: string }): { readablePaths: string[]; writablePaths: string[] }` — same results the current functions produce for the bubblewrap launcher.
- Produces (bubblewrap): config schema properties `scratchRoot` (env `DOCSLURP_PARSER_SANDBOX_ROOT`, default `/tmp/docslurp-parser-sandbox`) and `writablePaths` (env `DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS`, comma list, default `""`); session `spawn` runs `parser-sandbox.sh <binary> <args>` with env `DOCSLURP_PARSER_SANDBOX_MODE=isolated`, `_READABLE_PATHS`, `_ROOT`, `_TMP_ROOT`, `_WRITABLE_PATHS` exactly as `buildSpawnCommandSpec` sets today; `probe` runs the script with `/usr/bin/true` (10 s timeout) and returns `detail` = trimmed stderr on failure; isolation `{ filesystem: true, network: "full", processes: true, location: "local" }`.
- Produces (contract.ts): `defineSandboxContract(name: string, open: () => Promise<SandboxSession | { skip: string }>): void` — registers vitest cases (spec "Testing" list): undeclared read fails; write outside writable fails; declared write visible locally after; TCP connect to `1.1.1.1:443` fails when `isolation.network !== "none"` (use `bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'`); per-command timeout kills (`sleep 30` with 1 s limit → non-zero or killed within 5 s); env has only provided keys (`env` command output); non-zero exit + stderr returned. Works for both `spawn` and `run` sessions via a helper `execInSession(session, command): Promise<SandboxResult>`.

- [ ] **Step 1:** Write `contract-local.test.ts` calling `defineSandboxContract("none", ...)` (expect the isolation cases to be skipped by the suite because none reports no isolation, and the exit/stderr/timeout/env cases to pass) and `defineSandboxContract("bubblewrap", ...)` (returns `{ skip }` when probe fails, logging the detail).
- [ ] **Step 2: Run** `pnpm --filter @docslurp/worker exec vitest run src/sandbox src/__tests__/parser-filesystem-isolation.test.ts src/__tests__/process-env.test.ts` — expect FAIL (bubblewrap provider missing).
- [ ] **Step 3: Implement** paths.ts move (runner re-imports), bubblewrap provider, contract suite.
- [ ] **Step 4: Run** the Step 2 command — expect PASS (on this Linux host bubblewrap is available; existing isolation tests still pass unchanged).
- [ ] **Step 5: Commit.**

### Task 3: Runner integration, session context, interceptor, startup

**Files:**
- Create: `worker/src/sandbox/session-context.ts`, `worker/src/sandbox/activity-interceptor.ts`, `worker/src/sandbox/startup.ts`, `worker/src/sandbox/probe-cli.ts`
- Modify: `worker/src/tools/runner.ts` (spawn path, constructor, remove `ParserSandboxSettings`/`resolveParserSandboxSettings`/`buildSpawnCommandSpec` sandbox branches), `worker/src/temporal/worker.ts` (startup + `interceptors.activity`), `scripts/check-worker-prerequisites.mjs` (`--sandbox` calls the probe CLI), `.env.example`, `.env.selfhost.example` if they list removed vars, `worker/src/__tests__/parser-filesystem-isolation.test.ts`, `worker/src/__tests__/process-env.test.ts` (update imports to the providers)
- Test: `worker/src/sandbox/__tests__/session-context.test.ts`, `activity-interceptor.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (session-context.ts): `class SandboxSessionScope { constructor(open: () => Promise<SandboxSession>); get(): Promise<SandboxSession> /* opens lazily once */; close(): Promise<void> /* no-op if never opened */ }`; `sandboxScopeStorage: AsyncLocalStorage<SandboxSessionScope>`; `runWithSandboxScope<T>(scope, fn: () => Promise<T>): Promise<T>`.
- Produces (startup.ts): `initializeParserSandbox(env, platform): Promise<{ provider: ParserSandboxProvider; config: unknown; isolation: SandboxIsolation }>` — resolves id, loads provider, reads config, probes (throws `parser isolation unavailable: <detail>` on failure), asserts policy, logs the exact startup line and warnings.
- Produces (activity-interceptor.ts): `createSandboxActivityInterceptor(open: (activityId: string) => Promise<SandboxSession>): ActivityInterceptorsFactory` — `execute` wraps `next(input)` in `runWithSandboxScope(new SandboxSessionScope(() => open(Context.current().info.activityId)), ...)` and closes in `finally`.
- Runner: `CommandRunner` constructor takes optional `{ openSession?: (activityId: string) => Promise<SandboxSession> }`; `spawn(plan, signal)` gets the session from `sandboxScopeStorage.getStore()?.get()` or opens a per-command session and closes it after the command; builds a `SandboxCommand` from `buildAllowlistedEnv` (unchanged) + `resolveCommandPaths`; if `session.spawn` exists, behaves exactly as today (monitor applies); if only `session.run` exists, skip `startCommandMonitor`, map `SandboxResult` to the existing success/failure handling (non-zero exit → same error shape as today), and record `peakRssKb`/`cpuSeconds` in the existing perf metrics. The vector-writer and embed-pool bypasses stay (they never go through the session).
- probe-cli.ts: compiled entry `node dist/sandbox/probe-cli.js` prints `ok <provider>` or the detail and exits 0/1; `check-worker-prerequisites.mjs --sandbox` runs it and keeps the message `parser isolation unavailable: <detail>`.

- [ ] **Step 1: Write failing tests:**
  - session-context: two concurrent `runWithSandboxScope` calls with distinct fake sessions, each running a `CommandRunner` command through a fake provider, record commands only on their own session; `get()` twice opens once; a scope never `get()`-ed never calls `open`.
  - interceptor: an activity that throws still triggers `close()` exactly once; an activity that never runs a command never calls `open`.
  - runner remote path: a fake session with only `run` returning `{ exitCode: 2, stderr: "boom" }` makes `runner.run(plan)` reject with an error containing `boom`; with `exitCode: 0, stdout: "x"` resolves `{ stdout: "x", stderr: "" }`.
  - startup: `initializeParserSandbox` with `DOCSLURP_PARSER_SANDBOX=none` and `NODE_ENV=production` throws `SandboxPolicyError`; with `ALLOW_UNISOLATED=true` logs the unisolated warning and the exact startup line.
- [ ] **Step 2: Run** `pnpm --filter @docslurp/worker exec vitest run src/sandbox src/__tests__/parser-filesystem-isolation.test.ts src/__tests__/process-env.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** per Interfaces; wire `initializeParserSandbox` + interceptor in `worker.ts` before Temporal connection; remove the old settings code and env vars (grep the repo for `DOCSLURP_PARSER_SANDBOX_ENABLED|_MODE|_SCRIPT` and update every reference, including docs and compose files).
- [ ] **Step 4: Run** the Step 2 command, then full `pnpm --filter @docslurp/worker test` and `pnpm typecheck` — expect PASS. Run `node scripts/check-worker-prerequisites.mjs --sandbox` after `pnpm --filter @docslurp/worker build` — expect `status=ready`.
- [ ] **Step 5: Commit.**

### Task 4: landlock provider

**Files:**
- Create: `worker/src/sandbox/providers/landlock/index.ts`, `worker/sandbox-tools.json`, `worker/src/sandbox/__tests__/contract-landlock.test.ts`
- Modify: `worker/Dockerfile.lean`, `worker/Dockerfile.full`, `worker/Dockerfile` (install landrun from the pinned asset, verify sha256), `THIRD_PARTY_NOTICES.md`, `.github/workflows/ci.yml` only if the worker test lane needs landrun installed (install the same pinned binary in the test job; skip gracefully otherwise)

**Interfaces:**
- Consumes: Tasks 1–2 (`resolveCommandPaths`, contract suite). Independent of Task 3.
- Produces: `sandbox-tools.json` `{ "landrun": { "version": "<>= 0.1.12>", "url": "<release asset for linux/amd64>", "sha256": "<>", "license": "MIT" }, ... arm64 if published }` — look up the latest release and its license file; refuse any version < 0.1.12.
- Provider: config `binary` (env `DOCSLURP_LANDRUN_BINARY`, default `landrun`), `scratchRoot`/`writablePaths` as bubblewrap. Session `spawn`: `landrun --rox <runtime paths> --ro <readablePaths> --rw <writablePaths> -- <binary> <args>` (comma-joined lists; runtime paths = `/usr`, `/lib`, `/lib64`, `/bin`, `/etc`, venv, bundle roots that exist); no network flags; never `--best-effort`. Probe: run `landrun --rox /usr,/lib,/lib64 -- /usr/bin/true`; parse `uname -r` → network `"tcp-only"` if ≥ 6.8 else `"none"`; detail includes kernel version and landrun stderr on failure. Isolation `{ filesystem: true, network, processes: false, location: "local" }`.

- [ ] **Step 1:** `contract-landlock.test.ts` → `defineSandboxContract("landlock", ...)` skipping with the probe detail when unavailable; unit test for the kernel-version → network mapping (`"6.7.12"` → none, `"6.8.0"` → tcp-only, `"7.2.5-3-omarchy"` → tcp-only).
- [ ] **Step 2: Run** `pnpm --filter @docslurp/worker exec vitest run src/sandbox` — expect FAIL.
- [ ] **Step 3: Implement**; install landrun locally from the pinned asset into a temp dir (not the repo) to exercise the contract suite on this host.
- [ ] **Step 4: Run** with `DOCSLURP_LANDRUN_BINARY=<temp path>` — expect PASS (or a logged skip with the reason). Build `worker/Dockerfile.lean` and run `docker run --rm --entrypoint landrun <image> --version`.
- [ ] **Step 5: Commit.**

### Task 5: modal provider

**Files:**
- Create: `worker/src/sandbox/providers/modal/index.ts`, `worker/src/sandbox/providers/modal/staging.ts`, `worker/src/sandbox/__tests__/modal-staging.test.ts`, `worker/src/sandbox/__tests__/contract-modal.test.ts`
- Modify: `worker/package.json` (`optionalDependencies.modal` exact version — current latest), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Tasks 1–2 (types, `redactSandboxConfig`, contract suite). Independent of Task 3.
- Provider config (schema env names): `MODAL_TOKEN_ID` (secret, required), `MODAL_TOKEN_SECRET` (secret, required), `DOCSLURP_MODAL_APP` (default `docslurp-parsers`), `DOCSLURP_MODAL_IMAGE` (default `ghcr.io/docslurp/worker-full:<@docslurp/worker package version>`), `DOCSLURP_MODAL_CPU` (default 2), `DOCSLURP_MODAL_MEMORY_MB` (default 4096), `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS` (default 900).
- staging.ts (pure, SDK-free, unit-testable): `class SessionStaging { constructor(fs: RemoteFs); ensureUploaded(paths: string[]): Promise<void> /* each local file or directory uploaded once per session, recursively */; download(paths: string[]): Promise<void> /* remote path missing → skip silently; file → write; dir → recursive */ }` with `interface RemoteFs { exists(p): Promise<boolean>; writeFile(p, data: Uint8Array): Promise<void>; readFile(p): Promise<Uint8Array>; list(p): Promise<{ path: string; isDir: boolean }[]>; mkdir(p): Promise<void> }`.
- Session `run`: `staging.ensureUploaded(readablePaths)`, ensure writable dirs exist remotely, `exec([binary, ...args], { env, timeout })`, `staging.download(writablePaths)`, return result + Modal-reported usage; log/record `[sandbox-usage]` per Global Constraints. `close`: terminate; also terminate when the signal aborts. Network blocked at sandbox creation.
- Errors and probe detail redact secrets via `redactSandboxConfig`.

- [ ] **Step 1: Write failing tests** (`modal-staging.test.ts`, in-memory `RemoteFs`): same path uploaded twice → one write; directory uploads recursively; download of a never-created writable path → no throw, no local file; download of a remote directory recreates files locally; the error thrown when `MODAL_TOKEN_SECRET` is wrong-typed or the SDK rejects never contains the secret value.
- [ ] **Step 2: Run** `pnpm --filter @docslurp/worker exec vitest run src/sandbox/__tests__/modal-staging.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** staging and provider against the `modal` SDK (read its README/API for `sandboxes.create`, `exec`, filesystem calls, `terminate`, network blocking, CPU/memory options; wrap every SDK call in the provider).
- [ ] **Step 4: Run** the staging tests — PASS. `contract-modal.test.ts` runs `defineSandboxContract("modal", ...)` only when `MODAL_TOKEN_ID` is set, else skips; run it if credentials exist in the environment and report.
- [ ] **Step 5: Commit.**

### Task 6: Worker images workflow

**Files:**
- Create: `.github/workflows/worker-images.yml`
- Modify: `docs/releases.md` (add the images step)

**Interfaces:**
- Produces: images `ghcr.io/docslurp/worker-lean:<version>` / `:<sha>` and `ghcr.io/docslurp/worker-full:<version>` / `:<sha>`; triggers `push: tags: ["v*"]` and `workflow_dispatch` (input `version`); `permissions: contents: read, packages: write`; actions pinned by full SHA like the other workflows; build context and args as in `worker-supply-chain.yml`; linux/amd64 (arm64 only if the existing Dockerfiles already support it).

- [ ] **Step 1:** Write the workflow; validate with `actionlint` via `npx --yes actionlint` or the `rhysd/actionlint` docker image if available; otherwise `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))"`.
- [ ] **Step 2:** Update `docs/releases.md`; run `node scripts/check-docs-links.mjs`.
- [ ] **Step 3: Commit.** Do not trigger the workflow.

### Task 7: Sandbox overhead benchmark

**Files:**
- Create: `worker/src/benchmarks/sandbox-overhead-cli.ts`
- Modify: `worker/package.json` (script `bench:sandbox`)

**Interfaces:**
- Consumes: Tasks 1–5.
- CLI: `pnpm --filter @docslurp/worker bench:sandbox -- --file <pdf> --providers bubblewrap,landlock,none[,modal] --repeat 3`; for each available provider: open session (time), run `pdfinfo`, `pdftotext`, `pdftoppm -r 72 -f 1 -l 1` against the file through the session (per-command time), close; prints a Markdown table `provider | session open ms | median command ms | total ms` and JSON with `--json`. Unavailable providers print their probe detail and are skipped.

- [ ] **Step 1:** Implement; run against a small fixture PDF from the repo's existing test fixtures (find one with `git ls-files '*.pdf' | head`) with `bubblewrap,none,landlock`.
- [ ] **Step 2: Commit** with the measured table in the commit body.

### Task 8: Docs

**Files:**
- Create: `docs/self-host/sandbox-providers.md`
- Modify: `docs/self-host/security.md`, `requirements.md`, `configuration.md`, `operations.md`, `README.md`, `docker-compose.md` if it mentions the old variables

**Interfaces:**
- Consumes: spike results (Task 0), benchmark table (Task 7), provider config schemas (Tasks 2, 4, 5).

- [ ] **Step 1:** `sandbox-providers.md`: provider table (isolation it reports, host requirements, configuration variables from each `configSchema`), selection and defaults, production policy, Fargate spike results verbatim with date, Cloud Run "not yet tested", Modal setup (tokens, app, image, cost logging), benchmark table, "Adding a provider" (implement `ParserSandboxProvider`, register the id, pass `defineSandboxContract`).
- [ ] **Step 2:** Make `security.md#parser-sandbox` provider-neutral (keep the anchor), call out in-process Node parsers as unsandboxed; update requirements per provider; configuration: add new variables, list removed ones under "Removed and deprecated"; troubleshooting rows per provider probe failure (messages must be grep-able); README sandbox row → available, linked.
- [ ] **Step 3: Run** `pnpm docs:check` (with `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` locally) — expect exit 0.
- [ ] **Step 4: Commit.**

## Execution order

Task 0 (controller) runs alongside Task 1. Then Task 2. Then Tasks 3, 4, 5 and 6 in parallel (disjoint files: Task 3 owns runner/worker/startup/scripts; Task 4 owns providers/landlock, Dockerfiles, notices; Task 5 owns providers/modal, worker/package.json, lockfile; Task 6 owns the workflow and releases doc). Task 4's Dockerfile edits and Task 5's package.json edits do not overlap. Then Task 7, then Task 8.
