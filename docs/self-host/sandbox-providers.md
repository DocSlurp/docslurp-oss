# Parser sandbox providers

The worker runs file parsers (poppler, pandoc, LibreOffice and similar) on untrusted input. A sandbox provider decides where and how those commands run. This page covers the four providers, how one is chosen, what production requires, and how to set up each. For what the sandbox protects and where it stops, see [Security](security.md#parser-sandbox).

## Providers

| Provider | `DOCSLURP_PARSER_SANDBOX` | Filesystem | Network | Process isolation | Where it runs |
| --- | --- | --- | --- | --- | --- |
| Bubblewrap | `bubblewrap` | Isolated | Fully blocked (`full`) | Yes | Local |
| Landlock | `landlock` | Isolated | TCP blocked (`tcp-only`) on Linux 6.8+, otherwise not isolated (`none`) | No | Local |
| Modal | `modal` | Isolated | Fully blocked (`full`) | Yes | Remote |
| None | `none` | Not isolated | Not isolated (`none`) | No | Local |

The network levels mean:

- `full`: the parser has no network access of any kind.
- `tcp-only`: TCP connect and bind are denied. Other protocols are not restricted.
- `none`: no network isolation.

| Provider | Host requirements |
| --- | --- |
| Bubblewrap | Linux, `bwrap` installed, a kernel and container runtime that allow unprivileged user namespaces. In Docker this needs the security options in [Requirements](requirements.md#host-requirements). |
| Landlock | Linux with the Landlock LSM, and the `landrun` binary. Kernel 6.8 or newer for the TCP rule. The worker images include landrun. `landrun` v0.1.17 is a dynamically linked release binary that needs glibc 2.38 or newer (Debian trixie, not bookworm). No namespaces or extra container options needed. |
| Modal | Outbound HTTPS from the worker to Modal, a Modal account and API token, and the `modal` npm package (an optional dependency of `@docslurp/worker`). |
| None | Nothing. Development only. |

The pinned landrun version, download URLs and sha256 sums are in `worker/sandbox-tools.json`. landrun is MIT-licensed; releases before v0.1.12 were GPL-2.0 and are not used. See `THIRD_PARTY_NOTICES.md`.

## Selecting a provider

Set `DOCSLURP_PARSER_SANDBOX` to `bubblewrap`, `landlock`, `modal` or `none`. An unknown value stops the worker at start.

Unset, the default is `bubblewrap` on Linux, and `none` on other platforms outside production. Existing installs that never set the variable keep running under bubblewrap.

At start the worker loads the provider, probes it and checks the policy below. If any step fails, the worker exits. It never falls back to running parsers unsandboxed. On success it logs one line:

```text
[parser-sandbox] provider=<id> filesystem=<bool> network=<level> processes=<bool> location=<local|remote>
```

Each Temporal activity opens its own sandbox session, and the session closes when the activity ends, including when it fails or is cancelled.

## Production policy

With `NODE_ENV=production` (which Compose sets), the provider must report:

- filesystem isolation, and
- network isolation of `tcp-only` or `full`.

So landlock on a kernel older than 6.8 is refused in production. Provider `none` is refused unless you set `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true`. With that override, every start logs:

```text
[parser-sandbox] status=unisolated
```

Outside production the policy is not enforced, but the probe still has to pass.

## Configuration

Variables each provider reads. Secret values are never logged or included in error messages.

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `DOCSLURP_PARSER_SANDBOX` | all | see [Selecting a provider](#selecting-a-provider) | Provider id. |
| `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED` | `none` | unset | `true` allows provider `none` in production. |
| `DOCSLURP_PARSER_SANDBOX_ROOT` | bubblewrap, landlock | `/tmp/docslurp-parser-sandbox` | Host directory for per-command scratch space. |
| `DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS` | bubblewrap, landlock | empty | Comma-separated private DocSlurp workspaces every parser command may write. |
| `DOCSLURP_LANDRUN_BINARY` | landlock | `landrun` | Path or name of the landrun executable. |
| `MODAL_TOKEN_ID` | modal | required | Modal API token id. Secret. |
| `MODAL_TOKEN_SECRET` | modal | required | Modal API token secret. Secret. |
| `DOCSLURP_MODAL_APP` | modal | `docslurp-parsers` | Modal app that owns the sandboxes. Created if missing. |
| `DOCSLURP_MODAL_IMAGE` | modal | `ghcr.io/docslurp/worker-full:<worker version>` | Image the sandboxes run. It must contain the parser binaries. |
| `DOCSLURP_MODAL_CPU` | modal | `2` | Requested CPU cores per sandbox. |
| `DOCSLURP_MODAL_MEMORY_MB` | modal | `4096` | Requested memory in MiB per sandbox. |
| `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS` | modal | `900` | Maximum sandbox lifetime. Bounds billing if a session leaks. |

A required variable that is missing, or a number or boolean that does not parse, fails startup with `Invalid sandbox configuration; ...`, naming the variables.

## Landlock

Set `DOCSLURP_PARSER_SANDBOX=landlock`. The worker images ship `landrun` at `/usr/local/bin/landrun`. Elsewhere, install the pinned release from `worker/sandbox-tools.json` and point `DOCSLURP_LANDRUN_BINARY` at it.

Landlock restricts the parser to read-only access to system runtime paths and the input files, and write access to its scratch and declared output directories. It denies TCP connect and bind on kernel 6.8 and newer. It does not create namespaces, so it works in containers where bubblewrap cannot. It has no PID or IPC isolation, and the `processes` flag is `false`.

## Modal

Modal runs each activity's parser commands in a remote sandbox. Use it when the worker host cannot run bubblewrap or landlock, or when you want parsing off the host.

1. Create a Modal API token and set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` on the worker. Keep them in your secret store, not in the repository.
2. Set `DOCSLURP_PARSER_SANDBOX=modal`.
3. The default image is `ghcr.io/docslurp/worker-full:<version>`, matching the worker's version. `.github/workflows/worker-images.yml` publishes it on release tags (see [Releases](../releases.md)). To use your own image, set `DOCSLURP_MODAL_IMAGE`.
4. Start the worker. The probe loads the `modal` package and opens the app (`DOCSLURP_MODAL_APP`, created if it does not exist).

How it behaves:

- The sandbox is created with the network blocked.
- Input files are staged into the sandbox before each command, and files under the declared writable paths are copied back after it. A writable path the command never creates is not an error and produces no file.
- Time limits are enforced by Modal. A command that exceeds its limit is reported like a killed process.
- The sandbox is terminated when the session closes, or when the activity is aborted. `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS` is the backstop if the worker dies.
- Each command logs one line:

```text
[sandbox-usage] provider=modal cpu_seconds=<n> memory_gb_seconds=<n> activity=<id>
```

The Modal SDK does not report actual usage. The figures are the requested CPU and memory multiplied by wall time, which is what Modal bills. The same figures are recorded as a usage event with provider `modal`. This is provider cost, and it is kept separate from customer credits.

Modal sends your document contents to a third party. Decide whether that fits your data before you enable it.

## Where these providers work in containers

Results of a local check on 2026-10-20. Image: Debian trixie-slim with bubblewrap and landrun v0.1.17. Docker 29.7.2, host kernel 7.2.5.

| Docker security options | Bubblewrap | Landlock |
| --- | --- | --- |
| Default seccomp | Fails: `bwrap: No permissions to create a new namespace` | Works: filesystem rules enforced, TCP connect denied |
| `seccomp`, `apparmor` and `systempaths` all `unconfined` | Works | Works |

Takeaway: landlock works in containers without `unconfined` security options. Bubblewrap needs them. `compose.selfhost.yml` keeps bubblewrap as the default and sets `systempaths=unconfined` for the worker (see [Security](security.md#parser-sandbox)).

Not yet tested:

| Platform | Status |
| --- | --- |
| AWS Fargate | Not yet tested |
| Google Cloud Run | Not yet tested |

Do not assume landlock works on either until it has been checked. The probe at worker start tells you for your platform. Run it without starting the worker:

```bash
node worker/dist/sandbox/probe-cli.js
```

It prints `ok <provider>` and exits 0, or prints the failure detail and exits 1.

## Overhead

Measured on one machine, with the local providers and Modal. These figures are for a small PDF. Your hardware and documents will differ.

- Fixture: `form-rotated-notes.pdf`.
- Repeats: 3. Figures are medians.
- Commands per run: `pdfinfo`, `pdftotext`, `pdftoppm -r 72 -f 1 -l 1`.
- landrun v0.1.17.

| Provider | Isolation | Session open (ms) | Median command (ms) | Total (ms, sum of medians) |
| --- | --- | ---: | ---: | ---: |
| bubblewrap | fs=true net=full proc=true local | - | 30.3 | 137.7 |
| landlock | fs=true net=tcp-only proc=false local | - | 13.8 | 87.9 |
| none | fs=false net=none proc=false local | - | 10.9 | 78.9 |

Local providers spawn a process per command, so there is no session open cost (`-`).

Modal figures are partial. They were measured on the stock `debian:trixie-slim` image, because the worker image was not yet published, and only for opening a session and running `cat` on the PDF. Session open was about 445 ms and the `cat` command about 544 ms. Real parser timings through Modal are pending the published worker image.

To measure your own:

```bash
pnpm --filter @docslurp/worker bench:sandbox -- --file <pdf> --providers bubblewrap,landlock,none --repeat 3
```

A provider whose probe fails is skipped, with the reason printed.

## Limits

Not every code path goes through a provider:

- **In-process Node parsers** (Kreuzberg and LiteParse) run inside the worker process. No provider sandboxes them.
- **The vector writer and the embedding pool** run outside the sandbox. The writer needs object storage access.

Treat these as part of the worker's trust boundary. [Security](security.md#commands-that-skip-the-sandbox) has details.

## Adding a provider

Providers live in `worker/src/sandbox/providers/<id>/index.ts`.

1. Implement `ParserSandboxProvider` (`worker/src/sandbox/types.ts`): `id`, `configSchema` (each property names its `env` variable and marks secrets with `secret: true`), `readConfig`, `probe` and `openSession`. A local session returns `spawn`; a remote session returns `run`.
2. Report honest `SandboxIsolation` values from `probe`. The production policy trusts them.
3. Register the id in `SANDBOX_PROVIDER_IDS` and add a loader in `worker/src/sandbox/registry.ts`.
4. Pass the shared contract: call `defineSandboxContract` (`worker/src/sandbox/__tests__/contract.ts`) from a test, as `contract-local.test.ts`, `contract-landlock.test.ts` and `contract-modal.test.ts` do.
5. Never put secret values in probe details or error messages.

Source: `worker/src/sandbox/`, `worker/sandbox-tools.json`, [Security](security.md#parser-sandbox).
