# Requirements

What the host needs, and what to expect from memory and disk. Where DocSlurp has no measured figure, this page says so.

## Host requirements

- A Linux host with Docker Engine and Compose v2. Docker Desktop is untested. The parser sandbox providers bubblewrap and landlock are Linux-only; the Modal provider runs remotely. See [Parser sandbox providers](sandbox-providers.md).
- A kernel that allows unprivileged user namespaces, and a container runtime that lets the worker create namespaces. Ubuntu 23.10 and later restrict unprivileged user namespaces with `kernel.apparmor_restrict_unprivileged_userns=1`; CI sets it to 0 before the bubblewrap tests (`.github/workflows/ci.yml`). Not verified on an AppArmor host: Docker's default AppArmor profile may also block bubblewrap's mounts. If the worker fails the sandbox check there, add `apparmor=unconfined` to the worker's `security_opt`. The sandbox unshares network, PID, IPC and UTS namespaces, and Compose runs the worker with the `systempaths=unconfined` security option so bubblewrap can mount a fresh `/proc`. Capabilities stay dropped. See [Security](security.md#parser-sandbox).
- Per provider: **bubblewrap** (the default) needs the namespace support above. **Landlock** needs a kernel with Landlock ABI v9, which landrun v0.1.17 requires (on older kernels the probe fails with `missing kernel Landlock support`), and `landrun`, which the worker images include; the release binary needs glibc 2.38 or newer. It works in containers without `unconfined` security options. **Modal** needs a Modal token (`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`) and outbound HTTPS to Modal. Details and container test results are in [Parser sandbox providers](sandbox-providers.md#where-these-providers-work-in-containers).
- Node.js, for the one-time configuration generator (`node scripts/selfhost-init.mjs`). Node is not needed to run the containers after setup.
- Disk for Docker images, the `postgres_data` and `minio_data` volumes, and the worker scratch space. Document artifacts (raw files, page images, derived Markdown) go to `minio_data`. There is no measured per-document figure; watch disk use on your own corpus.

Source: `compose.selfhost.yml`, `worker/scripts/parser-sandbox.sh`, `worker/sandbox-tools.json`, [Self-hosting overview](README.md).

## Sizing

Start with at least 8 GB of RAM for the lean worker. The full worker needs more memory and disk. This is the current guidance from the Compose install. No measurement is recorded for it.

No measured CPU figure; parsing, OCR and local embedding are CPU-bound, so throughput scales with cores. Watch CPU alongside memory when raising `WORKER_DOC_CONCURRENCY`.

Image sizes, measured on local builds on 2026-10-14 (linux/amd64):

| Item | Uncompressed | Compressed | Source |
| --- | --- | --- | --- |
| Lean worker image (`worker/Dockerfile.lean`) | 1,884 MiB | 615 MiB | [Worker image](../worker-image.md), "Measured sizes" |
| Full worker image (`worker/Dockerfile.full`) | 2,552 MiB | 873 MiB | same |
| `docling` vendor bundle | 1,743 MiB unpacked | 656 MiB `.tar.zst` | same |
| `unstructured` vendor bundle | 2,085 MiB unpacked | 599 MiB `.tar.zst` | same |

The lean figure does not include baked ClamAV signatures (about 110 MB on the production machine) or the private native PDF engine. The bge-m3 embedding model is about 560 MB and is cached under `~/.cache` in the worker. Both are from [Worker image](../worker-image.md). Vendor bundles are off unless `DOCSLURP_VENDOR_BUNDLE_BASE_URL` is set; see [Configuration](configuration.md).

Worker scratch space in Compose is tmpfs, which counts against host memory when used: `/tmp` is 2048 MB and `/var/tmp` is 512 MB for `worker`, and 4096 MB and 1024 MB for `worker-full` (`compose.selfhost.yml`).

### How the per-command memory budget works

The worker caps the resident memory of each parser command. `resolveCommandRssBudgetMb` in `worker/src/tools/runner.ts` picks the cap:

1. If `WORKER_COMMAND_MAX_RSS_MB` is set, that value is used.
2. Otherwise the cap is 60% of the container memory limit, with a floor of 1024 MB.
3. If no limit is known, there is no cap.

`resolveContainerMemoryLimitMb` reads the limit from the cgroup (`/sys/fs/cgroup/memory.max`, then `/sys/fs/cgroup/memory/memory.limit_in_bytes`) and falls back to `MemTotal` in `/proc/meminfo`. With no memory limit on the container, the host's total RAM is the limit, so the cap is 60% of host RAM. `scripts/start-worker.sh` applies the same 60% rule when it starts the worker. It also sizes the Node heap at 35% of the limit, clamped between 768 MB and 1536 MB. The worker logs the result at startup as `[worker-memory] container_limit_mb=... command_rss_budget_mb=...`.

The cap is per command, not per document. DocSlurp does not publish a memory figure per document.

### What scales with concurrency

`WORKER_DOC_CONCURRENCY` is the number of documents each worker processes at once. The Compose default is `1`. Memory scales with it, because each document can run its own parser commands. [Extraction feature matrix](../extraction-feature-matrix.md) gives minimum RAM per extractor (for example about 2 GB for Docling and 512 MB for Kreuzberg) and notes that four parallel documents with Docling need about 8 GB. [Worker image](../worker-image.md) puts a Docling call at about 2 GB RSS. Raise concurrency only after you have watched memory and latency at the current setting.

## GPU

The default stack needs no GPU. The lean and full workers run on CPU, and local embedding runs on CPU.

A GPU is optional in two places:

- The `vision-runtime` extractor for handwriting, degraded scans and charts is listed with 1 GB of VRAM or more and an optional GPU ([Extraction feature matrix](../extraction-feature-matrix.md)).
- Private model endpoints let you point `local-only` and `strict-privacy` workspaces at an OpenAI-compatible server you run, such as vLLM on a rented GPU. The GPU lives on that server, not in this Compose stack. See [Model configuration](../model-configuration.md#private-model-endpoints).

The Compose file has no GPU device reservations.
