# Pluggable parser sandbox — design

Date: 2026-10-19
Status: draft for review
Sub-project 2 of 6 in the self-host and deploy program. Program decisions are
recorded in `2026-10-19-self-host-docs-design.md`.

## Goal

Let operators choose how untrusted-file parsers are isolated, so DocSlurp
workers can run on hosts where bubblewrap cannot (Fargate, Cloud Run, other
serverless containers) and can offload parsing to remote compute (Modal),
without weakening the production default. Success: the worker selects a
provider with one variable, every provider passes one contract suite, the
worker refuses to start in production with less isolation than the policy
requires, and today's bubblewrap behavior is unchanged when nothing is set.

## Current state

- Every parser subprocess goes through `CommandRunner.spawn()` in
  `worker/src/tools/runner.ts`. `buildSpawnCommandSpec` wraps the command with
  `worker/scripts/parser-sandbox.sh` (bubblewrap: unshared net, pid, ipc, uts;
  fresh `/proc`; read-only and writable binds; allowlisted env).
- `resolveParserSandboxSettings` decides enabled/mode/launcher from env.
- `run()` and `runToWritable()` enforce an RSS budget and a wall-clock budget
  by sampling the local process tree (`startCommandMonitor`).
- `scripts/check-worker-prerequisites.mjs --sandbox` probes the script at
  startup and prints `parser isolation unavailable` on failure.
- The vector writer and the Python embedding pool bypass the sandbox.
- In-process Node parsers (Kreuzberg's Node binding, LiteParse) run inside the
  worker process and are not sandboxed by any mechanism.
- One `CommandRunner` instance is shared by all concurrent activities
  (`worker/src/temporal/worker.ts:102`); benchmarks and CLIs construct their
  own.

## Decisions

- Session lifetime: one sandbox session per Temporal activity (option a).
  Job-level remote extraction (option c) is out of scope; the design keeps a
  seam for it, and a benchmark measures whether it is needed.
- Providers live in-repo under `worker/src/sandbox/providers/<id>/`, loaded
  by dynamic `import()`. No published packages.
- Modal is the first remote provider. Its image is a published worker image
  pulled from GHCR.
- gVisor is deferred to sub-project 3 (host-level runtime), because `runsc`
  inside a container needs privileges.
- Landlock uses landrun (MIT from v0.1.12; earlier tags were GPL-2.0 and
  must not be used), pinned by version and sha256.
- Production network floor: `tcp-only` is accepted, because landrun cannot
  block UDP. Operators who need full network isolation choose `bubblewrap`
  or `modal`.

## Interface

`worker/src/sandbox/types.ts`:

```ts
export type SandboxNetworkIsolation = "none" | "tcp-only" | "full";

export interface SandboxIsolation {
  filesystem: boolean;
  network: SandboxNetworkIsolation;
  processes: boolean;
  location: "local" | "remote";
}

export interface SandboxProbeResult {
  ok: boolean;
  isolation: SandboxIsolation;
  detail: string;
}

export interface SandboxLimits {
  timeoutMs: number;
  rssBudgetMb?: number;
  cpu?: number;
}

export interface SandboxCommand {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;      // already allowlisted by the runner
  readablePaths: string[];
  writablePaths: string[];
  limits: SandboxLimits;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  peakRssKb?: number;
  cpuSeconds?: number;
}

export interface SandboxSession {
  readonly providerId: string;
  readonly isolation: SandboxIsolation;
  /** Local providers return a child process so the existing monitor keeps enforcing limits. */
  spawn?(command: SandboxCommand, signal?: AbortSignal): ChildProcess;
  /** Remote providers run to completion and enforce limits provider-side. */
  run?(command: SandboxCommand, signal?: AbortSignal): Promise<SandboxResult>;
  close(): Promise<void>;
}

export interface ParserSandboxProvider<C = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  configSchema: SandboxConfigSchema;    // read by the CLI wizard (sub-project 5)
  readConfig(env: NodeJS.ProcessEnv): C; // validated against configSchema
  probe(config: C): Promise<SandboxProbeResult>;
  openSession(config: C, context: { activityId: string }): Promise<SandboxSession>;
}
```

`SandboxConfigSchema` is a small local JSON Schema subset (object with
`properties` of type `string | number | boolean`, `description`, `default`,
`secret?: boolean`, and `required`), validated by
`worker/src/sandbox/config-schema.ts`. No schema library is added.

Exactly one of `spawn` or `run` is implemented per provider; the runner uses
whichever exists. Local providers (`bubblewrap`, `landlock`, `none`) implement
`spawn`, so `startCommandMonitor` keeps measuring and killing the local process
tree. Remote providers implement `run`; the runner skips the local monitor and
records the returned `peakRssKb`/`cpuSeconds`.

### Session propagation

`worker/src/sandbox/session-context.ts` holds an `AsyncLocalStorage<SandboxSession>`.
A Temporal activity inbound interceptor
(`worker/src/sandbox/activity-interceptor.ts`, registered in
`worker/src/temporal/worker.ts` through the worker's `interceptors.activity`
option) wraps every activity: it opens a session lazily on the first parser
command, runs the activity inside `sandboxSessionStorage.run(...)`, and closes
any opened session in `finally`. Lazy opening means activities that never run a
parser (database or embedding work) never pay for a remote session.
`CommandRunner.spawn` reads the current session. With no current session
(benchmarks, CLIs, tests), the runner opens a per-command session and closes it
after the command; local providers make that free.

`CommandRunner`'s public API does not change, so stages do not change.

### Registry and selection

`worker/src/sandbox/registry.ts` maps ids to loaders:
`{ bubblewrap, landlock, modal, none }` → `() => import("./providers/<id>/index.js")`.
`DOCSLURP_PARSER_SANDBOX=<id>` selects one. Unset keeps today's behavior:
`bubblewrap` on Linux; `none` on macOS outside production. An unknown id fails
startup with the list of valid ids.

`DOCSLURP_PARSER_SANDBOX_ENABLED`, `DOCSLURP_PARSER_SANDBOX_MODE` and
`DOCSLURP_PARSER_SANDBOX_SCRIPT` are removed (pre-release: no shims).
`inherit` mode becomes the `none` provider in development.
`DOCSLURP_PARSER_SANDBOX_ROOT` and `DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS`
remain as `bubblewrap` and `landlock` config.

### Policy

`worker/src/sandbox/policy.ts`: `assertSandboxPolicy(isolation, env)`.

- Production (`NODE_ENV=production`) requires `filesystem: true` and
  `network` of `tcp-only` or `full`.
- `none` in production requires `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true`
  and logs `[parser-sandbox] status=unisolated` at warn level on every start.
- Startup logs `[parser-sandbox] provider=<id> filesystem=<bool> network=<level> processes=<bool> location=<local|remote>`.
- A failed probe fails startup with the provider's `detail`.

`scripts/check-worker-prerequisites.mjs --sandbox` calls the selected
provider's `probe()` (through a small compiled entry point) instead of running
the script directly; the failure message stays `parser isolation unavailable: <detail>`.

## Providers

### bubblewrap

Moves the current launcher logic behind the interface with no behavior change:
`parser-sandbox.sh`, path resolution (`resolveSandboxReadablePaths`,
`resolveSandboxWritablePaths`, `withoutCoveredPaths`) and env construction move
to `providers/bubblewrap/`. Probe: run the script with `/usr/bin/true`.
Isolation: `{ filesystem: true, network: "full", processes: true, location: "local" }`.

### landlock

`providers/landlock/` spawns `landrun` with `--rox` for runtime paths
(the venv, `/usr`, `/lib*`, bundle roots), `--ro` for readable paths, `--rw`
for writable paths, and no `--connect-tcp`/`--bind-tcp` flags, so TCP is
denied. Without `--best-effort`, so it fails rather than silently weakening.
Probe: reads the Landlock ABI (`landrun` exits non-zero if unavailable) and
the kernel version. Isolation: `{ filesystem: true, network: kernel >= 6.8 ? "tcp-only" : "none", processes: false, location: "local" }`.
On kernels below 6.8 the policy therefore rejects it in production.

The worker Dockerfiles install landrun from a pinned release asset verified by
sha256 (version and hash in `worker/sandbox-tools.json`), recorded in
`THIRD_PARTY_NOTICES.md`.

### modal

`providers/modal/` uses the `modal` npm package as an optional dependency of
`@docslurp/worker` (dynamic import; a clear error if missing).

- Config (`configSchema`): `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` (secrets),
  `DOCSLURP_MODAL_APP` (default `docslurp-parsers`), `DOCSLURP_MODAL_IMAGE`
  (default `ghcr.io/docslurp/worker-full:<worker version>`),
  `DOCSLURP_MODAL_CPU`, `DOCSLURP_MODAL_MEMORY_MB`,
  `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS`.
- `openSession`: create a sandbox from the image with outbound network blocked,
  the configured CPU and memory, and a session timeout.
- `run`: upload each readable path not yet present in the session (files and
  directories, tracked per session so repeated commands reuse uploads), `exec`
  the command with the given env and per-command timeout, download every
  declared writable path back to the same local path, return exit code,
  stdout, stderr and the usage Modal reports.
- `close`: terminate the sandbox.
- Probe: authenticate, look up the app and image, and run `/usr/bin/true` in a
  short-lived sandbox.
- Isolation: `{ filesystem: true, network: "full", processes: true, location: "remote" }`.
- Usage: log `[sandbox-usage] provider=modal cpu_seconds=<n> memory_gb_seconds=<n> activity=<id>`
  and record it through the existing local-compute recorder
  (`buildLocalComputeUsageEvent` in `worker/src/pipeline/local-compute-cost.ts`)
  with provider `modal`, keeping provider cost separate from customer credits.

### none

Runs the command directly. Isolation: all false, `location: "local"`.

## Worker images on GHCR

A new workflow `.github/workflows/worker-images.yml` builds `worker/Dockerfile.lean`
and `worker/Dockerfile.full` and pushes `ghcr.io/docslurp/worker-lean:<version>`
and `ghcr.io/docslurp/worker-full:<version>` (plus `:<git sha>`). It runs on
release tags and `workflow_dispatch` only; nothing publishes without an
explicit release. `docs/releases.md` gains the step. Sub-project 3 reuses
these images.

## Testing

- Contract suite `worker/src/sandbox/__tests__/contract.ts`, run per provider:
  reading an undeclared path fails; writing outside writable paths fails;
  declared writes are visible locally afterwards; a TCP connect fails when the
  provider reports `network` other than `none`; the per-command timeout kills
  the command; the env contains only allowlisted keys; non-zero exit codes
  and stderr come back intact.
- CI runs the suite for `bubblewrap`, `none` and `landlock` (landlock skips
  itself when the probe reports Landlock unavailable, and CI logs the skip).
  `modal` runs only when `MODAL_TOKEN_ID` is set, never in public CI.
- Unit tests: registry selection and unknown ids; policy matrix (production vs
  development × each isolation shape × `ALLOW_UNISOLATED`); config-schema
  validation (missing required, wrong type, secrets never logged); session
  propagation (concurrent activities get their own sessions; a session opens
  only on the first command; no session opens a per-command one and closes it;
  a throwing activity still closes its session).
- Existing `parser-filesystem-isolation.test.ts` and `process-env.test.ts` keep
  passing unchanged in intent (imports updated).
- Benchmark `worker/src/benchmarks/sandbox-overhead-cli.ts`: runs the
  extraction commands for a fixture PDF under each available provider and
  reports per-activity session open time, per-command overhead and total. Its
  Modal result decides whether job-level execution is worth a later spec.

## Spike (first, before landlock code)

A throwaway probe image that prints `/sys/kernel/security/lsm`, the kernel
version, the result of `unshare --user true`, `bwrap --unshare-all true`, and
`landrun --rox /usr true`, run once as a Fargate task and once as a Cloud Run
job. Needs the user's AWS and GCP credentials. Results go into
`docs/self-host/sandbox-providers.md` and decide whether that page recommends
`landlock` for Fargate and Cloud Run. If neither host supports Landlock, the
`landlock` provider still ships (useful on locked-down VMs) but the docs
recommend `modal` for those hosts.

## Docs

- New `docs/self-host/sandbox-providers.md`: provider table (isolation,
  requirements, configuration), policy, the spike results, how to add a
  provider (implement `ParserSandboxProvider`, add to the registry, pass the
  contract suite).
- Update `security.md` (parser sandbox section becomes provider-neutral; in-process
  Node parsers called out as unsandboxed), `requirements.md` (host requirements
  per provider), `configuration.md` (new variables, removed variables),
  `README.md` (sandbox providers row becomes available), and
  `operations.md` troubleshooting (probe failures per provider).

## Out of scope

- Job-level remote extraction (`runJob`).
- Sandboxing in-process Node parsers.
- gVisor.
- Other remote providers (E2B, Daytona, Cloudflare, Vercel); the interface and
  contract suite are the path for them later.

## Risks

- Modal's JS SDK and filesystem API are beta: pin the version, wrap all SDK
  calls in the provider, and keep the contract suite as the gate.
- Remote file staging cost for large inputs: per-session upload tracking, and
  the benchmark measures it.
- Behavior drift when moving bubblewrap behind the interface: the existing
  isolation tests plus the contract suite run before and after the move.
- landrun maintenance (single maintainer): pinned version and hash; the
  provider shells out to a CLI, so replacing it later is local to one folder.

## Findings after implementation (2026-10-20)

Appended after the spikes and implementation. The sections above are unchanged.

- Landlock kernel assumption. The spec says landlock reports
  `tcp-only` on kernel 6.8 or newer and `none` below that. That is wrong for
  the pinned tool. landrun v0.1.17 requires Landlock ABI v9 and refuses to run
  on a lower ABI without `--best-effort`. The provider never uses
  `--best-effort`. On an older ABI the probe fails with
  `missing kernel Landlock support`, and the worker does not start with
  landlock. It reports `tcp-only` whenever it does run. The release binary
  also needs glibc 2.38 or newer, so worker images use Debian trixie.
- Fargate run 1 (us-west-1, platform 1.4.0, kernel 6.1.188). bubblewrap fails
  because user namespaces are not permitted. landrun fails because Fargate
  exposes ABI v2. With `--best-effort` (diagnostic only) the filesystem rules
  applied but TCP was not blocked, so even best-effort could not meet the
  production policy. The spec's open question is answered: on Fargate use
  `modal`. Cloud Run is still untested.
- Fargate run 2: a per-job hardened task with no bubblewrap or landlock
  (`readonlyRootFilesystem`, user 65534, all capabilities dropped, no task
  role, no public IP, security-group egress only to VPC endpoints). Internet
  TCP was blocked and IMDS unreachable, and the credentials endpoint returned
  404. DNS still resolved through the VPC resolver (an exfiltration path
  unless Route 53 Resolver DNS Firewall is used), and task metadata v4 stayed
  reachable (ARNs, no secrets). Fargate bind volumes are root-owned, so a
  trusted init container must chown scratch. Start latency was 43 to 48 s cold
  and about 12.5 s warm. Full tables are in
  `docs/self-host/sandbox-providers.md`.
- Follow-up. A `platform-task` provider (per-job ECS task, Cloud Run job or
  Fly Machine, with operator attestation and an in-job probe that fails closed)
  is a separate sub-project, ordered after the Terraform foundation. Per-platform
  guidance is in `docs/self-host/platform-isolation.md`.
- Modal aborts. An aborted or timed-out command's remote process is killed,
  files it changed in writable directories are removed remotely and not copied
  back, and each command copies back only files it created or changed. (The
  original design assumed the aborted process could keep running.)
