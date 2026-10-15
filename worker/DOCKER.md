# Worker Docker Images

Sizes, contents, Fly limits and vendor bundles are documented in
[docs/worker-image.md](../docs/worker-image.md).

## Dockerfile.lean (production)

Production worker (`fly.worker.toml`), about 1.9 GB uncompressed: Node 24 with a pruned, worker-only
`node_modules` (`pnpm deploy`), poppler-utils, pandoc, ffmpeg, ClamAV, bubblewrap,
and a wheel-only Python venv with the base parsers (pymupdf, pymupdf4llm,
trafilatura, ebooklib, python-pptx, openpyxl, xlsx2csv). Docling and Unstructured
are fetched on demand as sha256-pinned vendor bundles
(`DOCSLURP_VENDOR_BUNDLE_BASE_URL`). Runtime pip installs are off.

## Dockerfile.full

Self-host image for every document type, about 2.6 GB uncompressed. Everything in lean, plus:

- **Tesseract OCR** - with eng, fra, deu, spa language packs
- **LibreOffice headless** - office format conversion (pptx, xlsx, doc, rtf)
- **ghostscript, imagemagick, mupdf-tools, qpdf, ocrmypdf, catdoc, unrtf**
- **Docling / Unstructured** - from vendor bundles, or (without a bundle source)
  the legacy first-boot install of `requirements.lock.txt` into `/app/.venv`
  (`DOCSLURP_WORKER_INSTALL_HEAVY_DEPS_ON_STARTUP`, default true here)

## Dockerfile.bundles

Builds vendor bundle archives (`--build-arg BUNDLE=docling|unstructured --target export`).

## Dockerfile

Legacy all-in-one image used by `docker-compose.prod.yml`.

## Locked Python Supply Chain

The worker now carries three Linux-targeted lockfiles generated with `uv pip compile`:

- `worker/requirements-base.lock.txt` - baked into every image's venv (wheel-only) for the base parser stack
- `worker/requirements.lock.txt` - used for the deferred full parser/tooling install
- `worker/requirements-fallback.lock.txt` - used when the deferred install falls back to the reduced parser set

`scripts/setup-worker-python-venv.sh` and `scripts/start-worker.sh` default to these lockfiles on Linux `x86_64`, which matches the production container target. Local non-Linux developer machines stay on the looser manifests by default unless you explicitly set `DOCSLURP_WORKER_REQUIREMENTS_MODE=locked`.

## Quarantine Controls

The worker now runs a `quarantine` stage before format detection and normalization. Useful env overrides:

- `QUARANTINE_ENABLED=true|false`
- `QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING=true|false`
- `QUARANTINE_MAX_ARCHIVE_ENTRIES`
- `QUARANTINE_MAX_ARCHIVE_DEPTH`
- `QUARANTINE_MAX_TOTAL_UNCOMPRESSED_BYTES`
- `QUARANTINE_MAX_SINGLE_ENTRY_BYTES`
- `QUARANTINE_MAX_EXPANSION_RATIO`

`QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING` now defaults to `false` when `NODE_ENV=production`, so missing or broken ClamAV tooling blocks ingestion instead of silently downgrading quarantine to a warning. Local development keeps the permissive default unless you explicitly set the env var to `false`.

## CI Supply-Chain Checks

The `worker-supply-chain` GitHub Actions workflow rebuilds the tracked worker lockfiles, checks that they are committed, builds the full worker image, generates an SBOM, and uploads an image vulnerability scan. This keeps dependency refreshes explicit and gives us ongoing visibility into the Python/native package surface we ship.

## ClamAV Health Controls

The worker entrypoint can now manage ClamAV readiness before the Temporal worker starts:

- `DOCSLURP_CLAMAV_ENABLED=true|false`
- `DOCSLURP_CLAMAV_MANAGE_DAEMON=true|false`
- `DOCSLURP_CLAMAV_REQUIRE_DAEMON=true|false`
- `DOCSLURP_CLAMAV_UPDATE_ON_STARTUP=if-stale|true|false` (default `if-stale`)
- `DOCSLURP_CLAMAV_UPDATE_IF_OLDER_THAN_HOURS=12`
- `DOCSLURP_CLAMAV_PRIVATE_MIRROR=https://...` (shared signature mirror for large fleets)
- build arg `DOCSLURP_BAKE_CLAMAV_SIGNATURES=true` (lean image) downloads signatures at build time
- `DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB=true|false`
- `DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS=24`
- `DOCSLURP_CLAMAV_DB_DIR=/var/lib/clamav`
- `DOCSLURP_CLAMAV_RUN_DIR=/tmp/clamav`
- `DOCSLURP_CLAMAV_READY_TIMEOUT_SECONDS=180`
- `DOCSLURP_CLAMAV_CLAMD_CONF=/etc/clamav/clamd.conf`
- `DOCSLURP_CLAMAV_FRESHCLAM_CONF=/etc/clamav/freshclam.conf`

Production defaults now prefer `clamdscan`, refresh signatures on startup, and fail the worker start when the signature database is missing or older than the configured max age. The container images place the ClamAV daemon socket under `/tmp/clamav` so the unprivileged worker can recreate runtime state after each boot. Local development defaults stay more permissive unless you explicitly opt into the stricter settings.

## Parser Trust Boundary

The worker images now run as a dedicated non-root `docslurp` user. Untrusted extraction commands are launched through `worker/scripts/parser-sandbox.sh`, which gives each parser invocation its own ephemeral scratch workspace plus isolated `HOME`, `TMPDIR`, and XDG directories instead of sharing the main worker process context.

Useful env overrides:

- `DOCSLURP_PARSER_SANDBOX_ENABLED=true|false`
- `DOCSLURP_PARSER_SANDBOX_SCRIPT=/absolute/path/to/parser-sandbox.sh`
- `DOCSLURP_PARSER_SANDBOX_ROOT=/tmp/docslurp-parser-sandbox`

Local macOS workers default `DOCSLURP_PARSER_SANDBOX_ENABLED` to `false`
because the isolated launcher depends on Linux `bubblewrap`. Docker workers set
the flag to `true` explicitly.

This is the baseline parser boundary. Additional egress-deny and kernel/filesystem sandboxing layers can build on the same launcher path without changing the worker call sites.

## Parser Environment And Egress

Parser subprocesses should not inherit the full worker control-plane environment. The worker now supports a minimal parser env plus a deny-by-default network stance via `worker/scripts/parser-sandbox.sh`.

Useful env overrides:

- `DOCSLURP_PARSER_SANDBOX_ENABLED=true|false`
- `DOCSLURP_PARSER_SANDBOX_NETWORK=none|inherit`
- `DOCSLURP_PARSER_SANDBOX_ROOT=/tmp/docslurp-parser-sandbox`
- `DOCSLURP_PARSER_ENV_ALLOWLIST=EXTRA_ONE,EXTRA_TWO`
- `DOCSLURP_PYTHON_POOL_ENV_ALLOWLIST=EXTRA_ONE,EXTRA_TWO`

The Docker worker images now include `bubblewrap`, and the runtime defaults parser sandboxes to `DOCSLURP_PARSER_SANDBOX_MODE=isolated`. If `bubblewrap` is unavailable while isolated mode is enabled, the launcher fails closed instead of running an unisolated parser.

## Sandbox Layers

The worker now supports two layers of parser isolation:

1. Container baseline: `docker-compose.yml` drops all Linux caps, enables `no-new-privileges`, applies a seccomp deny-list from `worker/security/seccomp-doc-extract.json`, constrains PID fanout, and mounts `/tmp` plus `/var/tmp` as hardened `tmpfs` scratch space.
2. Parser subprocess boundary: `worker/scripts/parser-sandbox.sh` launches parser commands via `bubblewrap` with `--unshare-net`, a read-only root view, and writable scratch only for the configured temp paths.

Useful env overrides:

- `DOCSLURP_PARSER_SANDBOX_ENABLED=true|false`
- `DOCSLURP_PARSER_SANDBOX_MODE=isolated|inherit`
- `DOCSLURP_PARSER_SANDBOX_ROOT=/tmp/docslurp-parser-sandbox`
- `DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS=` (empty by default; set only for trusted extra writable mounts)

When `bubblewrap` is unavailable, set `DOCSLURP_PARSER_SANDBOX_ENABLED=false`
or `DOCSLURP_PARSER_SANDBOX_MODE=inherit` only for trusted local development.
Production Docker workers should keep isolated mode enabled.

## Deployment and benchmark cost profiles

Worker images declare `DOCSLURP_DEPLOYMENT_PROFILE=lean|heavy` plus their
allocated vCPU and memory. Local compute Usage Events attach this profile,
worker class, region, image, and cold/warm command state so benchmark results
cannot silently compare a local heavy toolchain with the deployed lean lane.

Override the generic image defaults with the actual machine allocation and
marginal provider rates:

- `DOCSLURP_WORKER_CLASS`
- `DOCSLURP_WORKER_REGION`
- `DOCSLURP_WORKER_IMAGE`
- `DOCSLURP_ALLOCATED_VCPU`
- `DOCSLURP_ALLOCATED_MEMORY_GB`
- `DOCSLURP_CPU_CENTS_PER_SECOND`
- `DOCSLURP_MEMORY_CENTS_PER_GB_SECOND`
- `DOCSLURP_GPU_CENTS_PER_SECOND`
- `DOCSLURP_STORAGE_CENTS_PER_GB_MONTH`
- `DOCSLURP_NETWORK_INGRESS_CENTS_PER_GB`
- `DOCSLURP_NETWORK_EGRESS_CENTS_PER_GB`

The rate defaults are provider-neutral estimates. Production cost comparisons
should always set rates for the real worker class and region.

## Usage

```bash
# Default (full image, used by docker-compose.yml)
docker compose up worker

# Build lean image manually
docker build -f worker/Dockerfile.lean -t docslurp-worker:lean .

# Override in docker-compose
# Change worker/Dockerfile.full to worker/Dockerfile.lean in docker-compose.yml
```
