# Parser sandbox providers

The worker runs file parsers (poppler, pandoc, LibreOffice and similar) on untrusted input. A sandbox provider decides where and how those commands run. This page covers the four providers, how one is chosen, what production requires, and how to set up each. For what the sandbox protects and where it stops, see [Security](security.md#parser-sandbox).

## Providers

| Provider | `DOCSLURP_PARSER_SANDBOX` | Filesystem | Network | Process isolation | Where it runs |
| --- | --- | --- | --- | --- | --- |
| Bubblewrap | `bubblewrap` | Isolated | Fully blocked (`full`) | Yes | Local |
| Landlock | `landlock` | Isolated | TCP blocked (`tcp-only`) | Yes, when the host allows user namespaces; otherwise the probe fails | Local |
| Modal | `modal` | Isolated | Fully blocked (`full`) | On the worker host only; a remote descendant can outlive its command inside the session (see below) | Remote |
| None | `none` | Not isolated | Not isolated (`none`) | Yes, when the host allows user namespaces; otherwise only with `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true` | Local |

### Process teardown

"Process isolation" (`processes=true`) means no process a parser command starts outlives it on the worker host, so the worker can release the command's slot and remove its scratch knowing nothing still runs. Local providers get it by running each command in its own PID namespace (`unshare --user --map-current-user --pid --mount-proc --fork --kill-child`, from util-linux), in its own process group. For landlock and `none`, a minimal init (`tini` when installed, else a signal-forwarding `sh` that also reaps orphans while it waits) is the namespace's PID 1 in front of the parser, so the parser keeps default SIGTERM and SIGPIPE handling; the bubblewrap launcher is that init itself. Either init reports a parser killed by a signal as exit status 128+signal (137 for SIGKILL), not as the signal. Modal qualifies because nothing runs on the host (see the Modal paragraph below).

- On abort, timeout, an RSS or output budget, or a normal exit, the worker sends SIGTERM to the process group, then after `WORKER_COMMAND_ABORT_GRACE_MS` (default 2 s) SIGKILLs everything below the launcher, gives the launcher `WORKER_COMMAND_LAUNCHER_GRACE_MS` (default 1 s) to run its cleanup, and then SIGKILLs it. Killing the namespace's init makes the kernel kill everything left in the namespace, including processes that called `setsid`, re-parented, or closed their stdio.
- A command settles only once that teardown is verified: unshare has reaped the namespace's init (so the namespace is empty), the process group is empty, and the command's stdio has closed. If that cannot be confirmed within `WORKER_COMMAND_TEARDOWN_VERIFY_MS` (default 5 s), the worker destroys the command's stdio, logs `[worker-command] status=teardown-unverified metric=command_teardown_unverified` with the run and document ids, fails the command with `CommandTeardownError`, and keeps its raster slot out of service (`[worker-capacity] status=slot-poisoned`). That error wins over whatever was stopping the command (a timeout, an RSS budget, a failed output destination such as a full disk), which it carries as its cause. Alert on either line.
- A PID namespace contains only what the command forks. A host service that starts a process on the parser's behalf, such as a systemd user manager reached over the session bus, starts it outside the namespace, where it can hold the command's stdio. The worker cannot see or kill that process: the command's stdio stays open past `WORKER_COMMAND_TEARDOWN_VERIFY_MS`, and it ends as an unverified teardown with its slot poisoned. That bound counts only while the worker is waiting on the writer (nothing buffered, not backpressured), so a slow output destination, such as a multipart upload finishing its last part, never trips it; each chunk read restarts it, and `WORKER_COMMAND_STDIO_DRAIN_CAP_MS` (default 60 s) caps the total wait so a trickling writer cannot hold it open. A stopped or failed command cancels its output destination at once, and its stdout is drained to a real end of file, never closed early. Bubblewrap gives the parser no route to one: its filesystem starts empty (no `/run`), and its own network namespace hides abstract sockets. landrun v0.1.17 cannot restrict UNIX-socket connects, so with landlock run the worker where no such service listens; the worker images run no such service.
- Untrusted parser work refuses to run on a provider without process teardown, both at worker start (the policy below) and per command (`[parser-sandbox] status=refused ... reason=no-process-teardown`). The only exception is `none` with `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true`, which runs commands in a process group only: a descendant that calls `setsid` can outlive the command there. A provider that starts a command without a PID namespace anyway has it stopped and failed with `CommandTeardownError`: an empty process group does not prove a `setsid` descendant is gone, so its scratch is kept and it counts toward the circuit breaker below.
- **Teardown circuit breaker.** Only raster commands hold a slot that stays poisoned; any other parser (pandoc, LibreOffice, tesseract) runs in an activity slot that Temporal frees when the activity fails. So after `WORKER_UNVERIFIED_TEARDOWN_LIMIT` (default 1) unverified teardowns, the worker quarantines itself: it logs `[worker-quarantine] status=open`, refuses new activities (retryable, so they run on another worker), reports `/health` 503 `quarantined`, drains in-flight activities and exits non-zero (`[worker-fatal] reason=teardown-unverified`). An activity that fails with `CommandTeardownError` is not retried (`CommandTeardownUnverified`), so one document cannot quarantine worker after worker. To recover, restart the machine or container, not only the worker process: a fresh VM or container has no stray processes. On Fly, the machine's restart policy does that after the non-zero exit. Find the cause in the `[worker-command] status=teardown-unverified` lines (org, workspace, run, document and stage ids) before re-running that document.
- **The activity always ends as a teardown failure.** Once a command's teardown fails, its activity ends as the non-retryable `CommandTeardownUnverified` failure whatever else happens: a stage that swallowed the error (a parser fallback, an optional sidecar), a stall watchdog, a cancellation or the worker's own shutdown cannot turn it into a retry. Commands the same activity tries to start afterwards get the same failure.
- **Source quarantine.** The document's source hash (the server-computed `documents.source_sha256`) is recorded in `quarantined_sources`, logged as `[worker-quarantine] status=source-quarantined` with org, workspace, run, document and hash. Every worker refuses to run a command for a document with those bytes (`status=source-refused`), and that document fails without another strategy, whoever uploaded it. The list is global on purpose: one hostile file must not quarantine one worker per uploading organization. After investigating, delete the row to admit the source again. Not covered: a document without a source hash, and two workers that start the same source before the first record lands.
- **No UNIX sockets for poppler and qpdf.** Under bubblewrap, `pdfinfo`, `pdftoppm`, `pdfimages`, `pdftotext` and the other poppler and qpdf tools run under a seccomp filter (generated by the worker, `sandbox/seccomp.ts`) that makes `socket(AF_UNIX)` and `socketpair(AF_UNIX)` fail, so two concurrent commands cannot meet on a socket and pass file descriptors (for example to hold each other's stdout and trip the breaker). Concurrent pdftoppm lanes also write to separate directories and read the source read-only. The filter covers x86_64 and arm64; on another architecture those commands refuse to run. Other parsers (clamdscan, LibreOffice) may need UNIX sockets and run without it. landlock cannot apply it and logs `status=degraded reason=no-unix-socket-filter`; it also shares the host's abstract socket namespace.
- **A quarantined worker always exits.** Temporal's `shutdownForceTime` is the drain grace plus `WORKER_COMMAND_TEARDOWN_VERIFY_MS` plus 10 s. If the process is still running 30 s after that, a timer started when the breaker opened logs `[worker-fatal] reason=teardown-unverified phase=force` and exits 1.
- A sweep (at session start, then every 10 minutes) removes per-command directories under `DOCSLURP_PARSER_SANDBOX_ROOT` whose owning command has exited, for example after a worker crash. The owner file is written before the command starts (the worker's pid, then the command's), each time atomically (a temporary file renamed over it). The sweep is a heuristic: a directory whose owner file is missing is removed by age alone, after 3 hours (longer than any command's wall-clock budget); one whose owner file exists but cannot be read or parsed is kept and logged (`status=sweep-skipped`). Age never comes from the directory's modification time, which the parser can set: it is the owner file's, or without one the directory's change time (ctime). Symlinked entries are skipped, never followed.

The PID namespace needs unprivileged user namespaces, the same requirement as bubblewrap. Landlock therefore no longer runs where user namespaces are blocked (for example Docker's default seccomp profile); there its probe fails with `cannot create a PID namespace`, and the worker refuses to start rather than run parsers whose descendants could outlive them.

Modal runs commands remotely. An aborted or timed-out command's remote process group is SIGKILLed, and the command settles after that kill and a bounded wait (10 s). A remote descendant that started its own session could keep running inside that activity's Modal sandbox until the session closes or `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS` (default 900) ends it. It never runs on the worker host and cannot reach the worker's scratch, so releasing the local slot is safe. Its cost is remote CPU for the rest of the session, and it can still write into that session's remote working directories.

The network levels mean:

- `full`: the parser has no network access of any kind.
- `tcp-only`: TCP connect and bind are denied. Other protocols are not restricted.
- `none`: no network isolation.

| Provider | Host requirements |
| --- | --- |
| Bubblewrap | Linux, `bwrap` installed, a kernel and container runtime that allow unprivileged user namespaces. In Docker this needs the security options in [Requirements](requirements.md#host-requirements). |
| Landlock | Linux with a kernel that supports Landlock ABI v9, and the `landrun` binary. landrun v0.1.17 refuses to run on a kernel with a lower ABI; the probe tells you whether yours qualifies (the test host on kernel 7.2.5 works, Fargate's kernel 6.1 does not). The worker images include landrun. `landrun` v0.1.17 is a dynamically linked release binary that needs glibc 2.38 or newer (Debian trixie, not bookworm). No namespaces or extra container options needed. |
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

- filesystem isolation,
- network isolation of `tcp-only` or `full`, and
- process teardown (`processes=true`, see [Process teardown](#process-teardown)). This one is required in every environment.

Landlock reports `tcp-only`, so it passes. On a kernel without Landlock ABI v9 it never gets that far: the probe fails (see [Landlock](#landlock)). Provider `none` is refused unless you set `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true`. With that override, every start logs:

```text
[parser-sandbox] status=unisolated
```

Outside production only the process-teardown requirement is enforced, and the probe still has to pass.

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
| `DOCSLURP_MODAL_IMAGE` | modal | `ghcr.io/docslurp/worker-full:<DOCSLURP_VERSION>` in release images; required otherwise | Image the sandboxes run. It must contain the parser binaries. Accepts a digest-pinned reference (`repo@sha256:<digest>`). |
| `DOCSLURP_MODAL_IMAGE_DIGEST` | modal | unset | `sha256:<digest>` that pins the image (the default or `DOCSLURP_MODAL_IMAGE`) by digest instead of its mutable tag. Must match a digest already in `DOCSLURP_MODAL_IMAGE`. |
| `DOCSLURP_MODAL_REGISTRY_SECRET` | modal | unset | Name of a Modal Secret holding `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`, for pulling a private image. |
| `DOCSLURP_MODAL_CPU` | modal | `2` | Requested CPU cores per sandbox. |
| `DOCSLURP_MODAL_MEMORY_MB` | modal | `4096` | Requested memory in MiB per sandbox. |
| `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS` | modal | `900` | Maximum sandbox lifetime. Bounds billing if a session leaks. |

A required variable that is missing, or a number or boolean that does not parse, fails startup with `Invalid sandbox configuration; ...`, naming the variables.

## Landlock

Set `DOCSLURP_PARSER_SANDBOX=landlock`. The worker images ship `landrun` at `/usr/local/bin/landrun`. Elsewhere, install the pinned release from `worker/sandbox-tools.json` and point `DOCSLURP_LANDRUN_BINARY` at it.

Landlock restricts the parser to read-only access to system runtime paths and the input files, and write access to its scratch and declared output directories. Like the bubblewrap launcher, each command gets a private directory under `DOCSLURP_PARSER_SANDBOX_ROOT` with `HOME`, `TMPDIR`, `TMP`, `TEMP` and the `XDG_*` directories pointed into it; it is removed when the command exits. The worker resolves `DOCSLURP_LANDRUN_BINARY` against its `PATH` once at start, so the probe and every command run the same landrun. A path containing a comma cannot be granted (landrun splits grant lists on commas), so such a command fails instead of running with the wrong grants. It denies TCP connect and bind. landrun v0.1.17 refuses to run unless the kernel supports Landlock ABI v9. On an older ABI the probe fails with `missing kernel Landlock support. Got Landlock ABI vN, wanted {Landlock V9; ...}`, and the worker refuses to start with landlock rather than running with weaker isolation. The probe tells you whether your kernel qualifies; the test host on kernel 7.2.5 works and Fargate's kernel 6.1 (ABI v2) does not. If you see this, the kernel is too old for landrun v0.1.17: use `bubblewrap` on a host that allows user namespaces, or `modal`. Landlock itself creates no namespaces. Each command still runs in its own PID namespace (see [Process teardown](#process-teardown)), so landlock needs unprivileged user namespaces just as bubblewrap does, and the probe fails without them. It has no IPC isolation.

## Modal

Modal runs each activity's parser commands in a remote sandbox. Use it when the worker host cannot run bubblewrap or landlock, or when you want parsing off the host.

1. Create a Modal API token and set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` on the worker. Keep them in your secret store, not in the repository.
2. Set `DOCSLURP_PARSER_SANDBOX=modal`.
3. Choose the image. Release worker images set `DOCSLURP_VERSION`, and the default image is `ghcr.io/docslurp/worker-full:<DOCSLURP_VERSION>`, which `.github/workflows/worker-images.yml` publishes on the same release tag (see [Releases](../releases.md)). A worker run from source or a local image build has no `DOCSLURP_VERSION`, so `DOCSLURP_MODAL_IMAGE` is required there; without it the worker stops at start with `Invalid sandbox configuration; missing required: DOCSLURP_MODAL_IMAGE`. Modal pulls the image without credentials, so the GHCR package must be public. For a private image, create a Modal Secret with `REGISTRY_USERNAME` and `REGISTRY_PASSWORD` and set `DOCSLURP_MODAL_REGISTRY_SECRET` to its name. For production, verify the release image's cosign signature and pin it by digest with `DOCSLURP_MODAL_IMAGE_DIGEST=sha256:<digest>` (the image becomes `ghcr.io/docslurp/worker-full@sha256:<digest>`, so a re-pushed tag cannot change what runs); see [Verifying worker images](security.md#verifying-worker-images).
4. Start the worker. The probe loads the `modal` package and opens the app (`DOCSLURP_MODAL_APP`, created if it does not exist).

How it behaves:

- The sandbox is created with the network blocked.
- Only the command's input files (file arguments inside the worker's DocSlurp temp workspaces) are uploaded, at the same paths, before each command. Parsers, scripts, Node and Python come from the image, never from the worker host. After the command, only the files it created or changed under the declared writable paths are copied back, not the whole directory. A writable path the command never creates is not an error and produces no file.
- Time limits are enforced by Modal, which accepts only whole seconds, so each limit is rounded up to the next second. A command that exceeds its limit is killed as described below and reported like a killed process (exit code `null`).
- When one command is aborted (for example a stage's per-command timeout) or times out, only that command fails; other commands in the same activity keep using the sandbox. The Modal SDK cannot kill one exec, so the worker starts each command in its own session with `setsid` (from util-linux, which the worker image has) and kills the command's whole process group with a second exec. A descendant that starts its own session or process group escapes that kill and runs until the sandbox closes. On an image without `setsid`, only the command's top process is killed. A command that dies from a signal reports 128 plus the signal number, as local commands do.
- Reporting an abort can take up to about 20 seconds: up to 10 seconds for the kill exec, then up to 10 seconds for the killed command's exec to end.
- An aborted or timed-out command copies nothing back. The files it created or changed in its writable directories are removed from the sandbox, so a retry does not find its partial output there. If other commands in the same activity are still running, that removal waits until none is, because their in-progress files cannot be told apart from the aborted command's. An input the aborted command modified is uploaded again the next time a command uses it.
- Copy-back is per command, judged by what changed under its writable directories while it ran. When commands in one activity run at the same time and share a writable directory, a command can copy back a file another running command wrote meanwhile, including the partial output of a command that is later aborted. That copy is not removed from the worker host. It sits at the aborted command's own output path, where a successful retry overwrites it. A command never copies back an input uploaded for another command. Modal reports file times in whole seconds, so if a command rewrites an existing file with the same size in the same second the worker recorded its writable directories, the change is not detected and the file is not copied back.
- The sandbox is terminated when the activity's session closes, whether the activity succeeds, fails or is cancelled. `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS` is the backstop if the worker dies.
- Each command logs one line:

```text
[sandbox-usage] provider=modal cpu_seconds=<n> memory_gb_seconds=<n> activity=<id>
```

The Modal SDK does not report actual usage. The figures are the requested CPU and memory multiplied by wall time, which is what Modal bills. For each command, including one that fails or is aborted, the worker also records one usage event with provider `modal` and metric `sandbox_compute` in the running stage's usage ledger, tagged with the stage's scope. The event carries the estimated provider cost in `metadata.effectiveCostCents` and is marked `costRollup: "included"` and `billable: false`, so it never adds customer credits (compute is never billed; customers pay per page). A command run outside a pipeline stage (for example from a CLI) only logs the line.

While a Modal command runs, the worker reports progress to the stage's stall watchdog every 30 seconds, up to the command's own time limit. Long remote parses are not aborted as hung. Remote stdout and stderr are capped at `WORKER_COMMAND_MAX_OUTPUT_BYTES`, as local commands are.

Modal sends your document contents to a third party. Decide whether that fits your data before you enable it.

## Where these providers work in containers

Results of local Docker checks on 2026-10-20. Image: Debian trixie-slim with bubblewrap and landrun v0.1.17. Docker 29.7.2, host kernel 7.2.5.

| Docker security options | Bubblewrap | Landlock |
| --- | --- | --- |
| Default seccomp | Fails: `bwrap: No permissions to create a new namespace` | Works: filesystem rules enforced, TCP connect denied |
| `seccomp`, `apparmor` and `systempaths` all `unconfined` | Works | Works |

Takeaway: landrun itself worked in containers without `unconfined` security options, but this test predates per-command PID namespaces (see [Process teardown](#process-teardown)). Landlock now needs user namespaces too, so expect the same container options as bubblewrap; run the probe. Bubblewrap worked only when `seccomp`, `apparmor` and `systempaths` were all `unconfined` in this test. Each option was not tested alone. `compose.selfhost.yml` keeps bubblewrap as the default and uses `systempaths=unconfined` plus a custom seccomp profile (see [Security](security.md#parser-sandbox)).

<details>
<summary>Raw probe output, default seccomp</summary>

```text
== uname
7.2.5-3-omarchy
== lsm
cat: /sys/kernel/security/lsm: No such file or directory

== userns_clone
1
256370
== unshare --user true
unshare: unshare failed: Operation not permitted
exit=1
== bwrap --unshare-all --ro-bind / / true
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.
exit=1
== landrun --version
landrun version 0.1.17
exit=0
== landrun fs allow /usr
exit=0
== landrun fs deny (read /etc/hostname without /etc)
cat: /etc/hostname: Permission denied
exit=1
== curl without landrun (baseline)
200
exit=0
== landrun tcp deny (curl must fail)
curl: (7) Failed to connect to example.com port 443 after 0 ms: Could not connect to server
exit=7
```

</details>

<details>
<summary>Raw probe output, seccomp, apparmor and systempaths unconfined</summary>

```text
== uname
7.2.5-3-omarchy
== lsm
cat: /sys/kernel/security/lsm: No such file or directory

== userns_clone
1
256370
== unshare --user true
exit=0
== bwrap --unshare-all --ro-bind / / true
exit=0
== landrun --version
landrun version 0.1.17
exit=0
== landrun fs allow /usr
exit=0
== landrun fs deny (read /etc/hostname without /etc)
cat: /etc/hostname: Permission denied
exit=1
== curl without landrun (baseline)
200
exit=0
== landrun tcp deny (curl must fail)
curl: (7) Failed to connect to example.com port 443 after 0 ms: Could not connect to server
exit=7
```

</details>

### AWS Fargate

Run on 2026-10-20 in us-west-1, platform 1.4.0, kernel 6.1.188, 0.25 vCPU / 0.5 GB, with the same image (Debian trixie-slim, bubblewrap, landrun v0.1.17).

| Platform | Bubblewrap | Landlock |
| --- | --- | --- |
| AWS Fargate | Fails: no user namespaces (`bwrap: No permissions to create a new namespace`) | Fails: landrun v0.1.17 needs Landlock ABI v9, Fargate exposes ABI v2 (`missing kernel Landlock support`) |

Takeaway: on Fargate neither local provider works. Bubblewrap cannot create user namespaces. Landlock fails the probe, and ABI v2 has filesystem rules only and no network rules, so it could not pass the production policy even with `--best-effort`. Use the `modal` provider on Fargate.

<details>
<summary>Raw probe output, AWS Fargate</summary>

```text
== uname
6.1.188
== lsm
cat: /sys/kernel/security/lsm: No such file or directory
== userns_clone
cat: /proc/sys/kernel/unprivileged_userns_clone: No such file or directory
16384
== unshare --user true
unshare: unshare failed: Operation not permitted
exit=1
== bwrap --unshare-all --ro-bind / / true
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.
exit=1
== landrun --version
landrun version 0.1.17
exit=0
== landrun fs allow /usr
[landrun:error] 2026/10/20 16:25:40 Failed to apply sandbox: failed to apply Landlock restrictions: missing kernel Landlock support. Got Landlock ABI v2, wanted {Landlock V9; FS: all; Net: all; Scoped: all}
exit=1
== landrun fs deny (read /etc/hostname without /etc)
[landrun:error] 2026/10/20 16:25:40 Failed to apply sandbox: failed to apply Landlock restrictions: missing kernel Landlock support. Got Landlock ABI v2, wanted {Landlock V9; FS: all; Net: all; Scoped: all}
exit=1
== curl without landrun (baseline)
200
exit=0
== landrun tcp deny (curl must fail)
[landrun:error] 2026/10/20 16:25:40 Failed to apply sandbox: failed to apply Landlock restrictions: missing kernel Landlock support. Got Landlock ABI v2, wanted {Landlock V9; FS: all; Net: all; Scoped: all}
exit=1
```

</details>

<details>
<summary>Raw probe output, AWS Fargate, landrun with --best-effort (diagnostic only)</summary>

Diagnostic only: the provider never uses `--best-effort`.

```text
== best-effort fs allow
exit=0
== best-effort fs deny
cat: /etc/hostname: Permission denied
exit=1
== best-effort tcp (ABI v2 has no net rules)
curl: (23) client returned ERROR on write of 577 bytes
200
exit=23
```

curl exit 23 means `/dev/null` was not writable inside the sandbox. The HTTP 200 shows TCP was not blocked.

</details>

If the landlock probe fails with the following message, the kernel is too old for landrun v0.1.17:

```text
missing kernel Landlock support
```

Not yet tested:

| Platform | Status |
| --- | --- |
| Google Cloud Run | Not yet tested |

Do not assume landlock works on Cloud Run until it has been checked. [Choosing isolation per platform](platform-isolation.md) lists what each platform's own boundary gives you. The probe at worker start tells you for your platform. Build the worker first (`pnpm --filter @docslurp/worker build`); the probe and `scripts/check-worker-prerequisites.mjs --sandbox` both run the compiled `worker/dist/`. Then run the probe without starting the worker:

```bash
node worker/dist/sandbox/probe-cli.js
```

It prints `ok <provider>` and exits 0, or prints the failure detail and exits 1. After the probe succeeds it also opens one session and runs `ffprobe -version`, `ffmpeg -version`, `pdftoppm -v` and `pandoc --version` inside it, for each of those that is installed. A library the sandbox cannot see then fails the check, not every upload of that format. If one fails, the probe prints `<name> fails inside the parser sandbox (exit <status>): <first line of stderr>` and exits 2. For a remote provider such as Modal it skips these checks without opening a sandbox, because the binaries live in the provider's image, and prints `parser binary checks skipped: remote provider`. The Modal probe also does not pull the image, so a wrong or unpullable `DOCSLURP_MODAL_IMAGE` first shows up as `modal sandbox creation failed` in the first activity that runs a parser.

## Running parsers in a separate Fargate task (no bubblewrap or landlock)

DocSlurp does not yet have a provider that launches such tasks. This section records a spike that shows the approach works, so you can judge it. It is planned as the `platform-task` provider: one ECS task, Cloud Run job or Fly Machine per job, with operator attestation plus an in-job probe that fails closed if the network or credential endpoints are reachable. Until it exists, on Fargate use `modal`.

The spike ran on 2026-10-20 in us-west-1, platform 1.4.0, kernel 6.1.188, with the same image as above. A task ran the probe script with no bubblewrap and no landlock, relying only on the task's own settings.

| Check | Result |
| --- | --- |
| Identity and capabilities | `uid=65534(nobody)`, all capability sets empty (`CapEff` `0000000000000000`), seccomp mode 2. |
| Root filesystem | Read-only: writing `/probe-write` fails with `Read-only file system`. |
| Scratch volume | Writable by the non-root parser only after a trusted init container runs `chown 65534:65534 /scratch`. The probe wrote each check's output to `$TMPDIR/o` with `TMPDIR=/scratch` (the bind volume). Without the init container every check failed with `cannot create /scratch/o: Permission denied`. With it, every output was written to and read back from `/scratch`. The "write to /tmp" line in the raw output below failed with `Read-only file system` because `/tmp` is part of the read-only root in that run, not the scratch volume. |
| Internet TCP | Blocked by the security group. `https://example.com` and `1.1.1.1:443` both time out. |
| DNS | Still resolves `example.com`. The VPC resolver answers even with no egress. This is a data exfiltration path. Use [Route 53 Resolver DNS Firewall](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-dns-firewall.html) if it matters. |
| EC2 metadata (IMDS) | Unreachable: `169.254.169.254` refuses the connection. |
| Task credentials endpoint | `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` is unset and the endpoint returns `404` when the task has no task role. |
| Task metadata v4 | Reachable through `ECS_CONTAINER_METADATA_URI_V4`. It returns cluster and task ARNs, no secrets. |

For contrast, a default task (root, default capabilities, public IP, open egress) ran as uid 0 with `CapEff` `00000000a80425fb`, a writable root filesystem, and internet access (`example.com` 200, `1.1.1.1` 301).

Task-definition settings used:

- `readonlyRootFilesystem: true`, user `65534`, and Linux capabilities drop `ALL`.
- No task role. The execution role only pulls the image and writes logs.
- A scratch bind volume. Fargate bind volumes are root-owned and do not copy the image directory's ownership, so a trusted init container (root, `CHOWN` only, `essential: false`, with the parser container `dependsOn` it at `SUCCESS`) chowns the volume for the non-root parser.
- `assignPublicIp: DISABLED`. The security group allows egress only on 443, to the VPC CIDR (interface endpoints for `ecr.api`, `ecr.dkr` and `logs`) and to the S3 prefix list (gateway endpoint).

With no internet egress, the task cannot pull its image or write logs unless those VPC endpoints exist. Plan for them. The security-group rules above are the only egress.

Start latency, from `RunTask` to the container started:

| Case | Time |
| --- | --- |
| Cold, image pulled through the VPC endpoints (3 runs) | 43 to 48 s (about 33 s of it the pull) |
| Warm (2 runs, includes the init container) | about 12.5 s |

That suits large documents or media jobs, and is slow for small PDFs.

Scratch-volume evidence from the earlier revision of the task, before the init container was added, with the same probe writing to `/scratch/o`:

```text
cannot create /scratch/o: Permission denied
```

The spike removed every resource it created (cluster, task definitions, VPC endpoints, security group, ECR repository, log group, IAM role).

<details>
<summary>Raw probe output, AWS Fargate per-job hardened task</summary>

```text
== id
uid=65534(nobody) gid=65534(nogroup) groups=65534(nogroup)
== kernel
6.1.188
== status
CapPrm:
0000000000000000
CapEff:
0000000000000000
CapBnd:
0000000000000000
NoNewPrivs:
0
Seccomp:
2
== visible pids
3
== write to root fs (/probe-write)
sh: 1: cannot create /probe-write: Read-only file system
exit=2
== write to /tmp (scratch volume)
sh: 1: cannot create /tmp/probe-write: Read-only file system
exit=2
== internet https (example.com)
curl: (28) Connection timed out after 5001 milliseconds
000
exit=28
== internet tcp by IP (1.1.1.1:443)
curl: (28) Connection timed out after 5002 milliseconds
000
exit=28
== dns lookup
2606:4700:10::ac42:93f3 example.com
2606:4700:10::6814:179a example.com
exit=0
== EC2 IMDS 169.254.169.254
curl: (7) Failed to connect to 169.254.169.254 port 80 after 0 ms: Could not connect to server
exit=7
== credentials uri env
<unset>
== ECS credentials endpoint
404 page not found
exit=0
== ECS task metadata v4 (task)
(JSON with cluster and task ARNs; account id and task ids omitted)
exit=0
== env keys
AWS_DEFAULT_REGION AWS_EXECUTION_ENV AWS_REGION ECS_AGENT_URI ECS_CONTAINER_METADATA_URI ECS_CONTAINER_METADATA_URI_V4 HOME HOSTNAME PATH PWD TMPDIR 
```

</details>

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
