# Operations

Commands on this page run from the repository root, with the stack started as
described in [Docker Compose install](docker-compose.md).

## Automatic upload completion and Tigris notifications

Direct upload sessions finalize automatically. For known-size multipart uploads,
the API reconciler lists stored parts, checks every part number and size, and
assembles the object. Unknown-size streams must send an end-of-stream completion
with their final byte count; the SDK does this after every part succeeds. The SDK
then polls session status for the accepted run. Acceptance means ingestion has
started or is queued; it does not mean extraction has finished. There is no separate client
confirmation required to start ingestion.

The API runs the reconciler every 15 seconds, in bounded batches, with per-session
backoff (up to 30 seconds for incomplete uploads, five minutes after errors).
Unfinished transfers expire after 24 hours and become `aborted`; sessions already
starting ingestion continue recovery. It also verifies single-PUT objects,
so self-hosted S3/MinIO installations do not require webhooks. Keep the API process
running; a process that sleeps between requests cannot execute background sweeps.
Allow up to two additional on-demand database connections per API process for
upload advisory locks, beyond `DATABASE_POOL_MAX` and existing listener/probe
connections. These locks use a separate pool so finalization cannot exhaust the
query pool while waiting for its own queries.

For a bucket-specific custom domain, set
`DOCSLURP_STORAGE_PUBLIC_BUCKET_URL=https://f.docslurp.io` (or your own HTTPS
bucket origin). Upload URLs are signed for that host and omit the bucket name
from their path. Internal storage access continues using the configured S3
endpoint. The web app permits this origin in its upload connection policy.
Keep the custom-domain CNAME DNS-only, pointing directly to Tigris, as required
for Tigris TLS issuance/renewal. This storage URL is separate from the API's
webhook receiver URL.

For Tigris, notifications bring a pending session forward in the reconciliation
schedule. Configure these **after applying migrations and deploying the receiver**:

1. Set `DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET` to a long random secret in the API
   runtime. Use the same value as the notification token; do not use an S3 admin
   key as the webhook token.
2. Open the bucket's **Settings → Notifications** in the
   [Tigris console](https://console.storage.dev/).
3. Set the webhook URL to `https://YOUR_API_HOST/webhooks/tigris/uploads`.
   The hosted DocSlurp URL is `https://docslurp.io/webhooks/tigris/uploads`.
4. Select **Token authentication**, entering only the configured secret in the
   token field. Tigris sends it as the standard `Authorization: Bearer <token>`
   header; no custom HTTP headers are required.
5. Set this filter to exclude generated artifacts and unrelated events:

   ```sql
   WHERE `key` REGEXP "^[^/]+/[^/]+/raw/" AND (`Event-Type` = "OBJECT_CREATED_PUT" OR `Event-Type` = "OBJECT_CREATED_MULTIPART")
   ```

6. Enable notifications and save. Upload a small file and a multipart file;
   verify their session results point to a single ingestion run each. A repeated
   notification must not create another run.

The receiver authenticates the bearer token, matches the configured storage
bucket and registered source keys, and persists a reconciliation nudge before
acknowledging. It never trusts notification byte counts as proof of completion.
Do not configure a localhost URL in Tigris; use a publicly reachable development
API or rely on reconciliation locally. Missing secret returns 503; invalid token
returns 401. A successful authenticated empty `{"events":[]}` request returns
200 and can check receiver reachability without ingesting anything.

Poll `GET /v1/uploads/direct/sessions/:sessionId?statusOnly=true` for `status`,
`error`, per-file state and `result`. A timeout after bytes were uploaded does
not imply failure: retain the session ID and check it before submitting again.
Look for `[upload-reconcile]` errors when handoff stalls. Configure the bucket's
incomplete-multipart lifecycle expiry as a final safety net: a process crash
between provider multipart creation and saving its upload ID can leave an orphan
that the database cannot identify. Normal expired/failed sessions abort known
multipart IDs and queue delayed raw-object cleanup.

Tigris delivers at least once, may deliver out of order, and retries requests
that do not receive a 2xx response within ten seconds. See the official
[object notification documentation](https://www.tigrisdata.com/docs/buckets/object-notifications/).

For client examples and recovery behavior, see [upload completion](../api-sdk.md#upload-completion).

## Backups and restore

Three things hold your data:

- Postgres, in the named volume `postgres_data`: database records. Temporal also
  keeps its state in this Postgres instance.
- MinIO, in the named volume `minio_data`: raw and derived artifacts in the
  `docslurp-files` bucket. The LanceDB vector indexes live in the same bucket
  under the `lancedb/` prefix.
- `.env.selfhost`: the generated credentials and encryption keys. Without the
  encryption keys, stored credentials and secrets cannot be read.

Redis is an ephemeral rate-limit cache and needs no backup.

Back up all three before upgrading. The commands below write to `./backup`.

```sh
mkdir -p backup
cp .env.selfhost backup/env.selfhost

# Postgres: the docslurp database, custom format
docker compose --env-file .env.selfhost -f compose.selfhost.yml exec -T postgres \
  pg_dump -U docslurp -d docslurp -Fc > backup/docslurp.dump

# MinIO: the whole bucket, including lancedb/, with the mc client from the createbucket service.
# Runs as your user so it can write to ./backup.
set -a; . ./.env.selfhost; set +a
export MC_HOST_local="http://${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}@minio:9000"
docker compose --env-file .env.selfhost -f compose.selfhost.yml run --rm --no-deps \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e MC_HOST_local -v "$PWD/backup:/backup" \
  --entrypoint mc createbucket mirror --overwrite local/docslurp-files /backup/minio
```

The `pg_dump` covers the `docslurp` database only. Workflows still in flight in
Temporal are not in this dump; resubmit any document that was processing when you
took the backup.

`selfhost-init` generates hex keys, so they are URL-safe in `MC_HOST_local`. If you chose keys with reserved characters, URL-encode them there.

The image runs as a non-root user that cannot write to a host directory you own, so the command runs as your user. `mc` reports success even when it cannot write, so check that the copy landed:

```sh
find backup/minio -type f | head
```

To restore, use a stack that has not served traffic yet, ideally on a separate
host. Order matters:

1. Put the saved file back as `.env.selfhost`.
2. Start only the data services: `docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d postgres minio`. Wait until Postgres accepts connections.
3. Restore Postgres:

   ```sh
   docker compose --env-file .env.selfhost -f compose.selfhost.yml exec -T postgres \
     pg_restore -U docslurp -d docslurp --clean --if-exists < backup/docslurp.dump
   ```

4. Restore the bucket. Export `MC_HOST_local` as in the backup step first.

   ```sh
   docker compose --env-file .env.selfhost -f compose.selfhost.yml run --rm --no-deps \
     --user "$(id -u):$(id -g)" -e HOME=/tmp -e MC_HOST_local \
     --entrypoint mc createbucket mb --ignore-existing local/docslurp-files
   docker compose --env-file .env.selfhost -f compose.selfhost.yml run --rm --no-deps \
     --user "$(id -u):$(id -g)" -e HOME=/tmp -e MC_HOST_local -v "$PWD/backup:/backup" \
     --entrypoint mc createbucket mirror --overwrite /backup/minio local/docslurp-files
   ```

5. Start everything: `docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --build`.

Test a restore on a separate host before you rely on it.

## Local disk cache for LanceDB

When the vector index lives on object storage (`LANCEDB_URI=s3://...`, including
`s3+ddb://`), every search reads index and data ranges over the network: 40-60 ms per
request on most providers, more on others. Lance never rewrites its `data/*.lance`
or `_indices/**` files, so a local copy of those bytes cannot go stale. The optional
cache keeps them on local disk and serves repeat reads in well under a millisecond.

```bash
LANCEDB_S3_CACHE_DIR=/data/lance-cache   # enables the cache (off when unset)
LANCEDB_S3_CACHE_MAX_GB=10               # LRU limit, default 10
LANCEDB_S3_CACHE_BLOCK_KB=1024           # fill granularity, default 1024
```

Setting the directory starts the same localhost re-signing proxy that
`LANCEDB_S3_TRACE` uses (tracing itself stays off) and needs explicit credentials in the
storage URI or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. It works with any
S3-compatible provider.

What is cached, and what is not:

- Cached: `GET` (whole object and byte ranges) and `HEAD` for keys under
  `<table>.lance/data/` and `<table>.lance/_indices/`. Objects are stored as aligned
  blocks, so overlapping ranges share entries. A request is answered with exactly the
  bytes it asked for (`206` and `Content-Range` for ranges) and the origin's `ETag`.
- Never cached: `_versions/` manifests, `_latest`, `_transactions/`, `_deletions/`,
  LIST, `PUT`, deletes, multipart, conditional requests (`If-Match`, `If-None-Match`,
  ...), anything with a query string, and every non-2xx answer. Readers still see new
  table versions as soon as Lance does.
- A read that spans more than 32 blocks (a scan of a large file) streams through
  uncached. Writes and deletes that pass through the proxy drop that object's entries.
- Cache files are written to a temporary name and renamed into place. A missing or
  truncated file is a miss. Eviction is least-recently-used; the index is rebuilt from
  the directory at start, so the cache survives restarts.

Sizing and placement:

- **Fly.io:** create a volume on the machine that runs the API or worker
  (`fly volumes create lance_cache --size 20 --region <region>`), mount it at
  `/data`, and set `LANCEDB_S3_CACHE_DIR=/data/lance-cache`. Volumes attach to one
  machine, so each machine has its own cache; they cost about 0.15 USD/GB/month. Set
  `LANCEDB_S3_CACHE_MAX_GB` to about 80% of the volume. Without a volume the machine
  root filesystem works but is wiped on every deploy.
- **Local or bare metal:** point it at NVMe. Spinning disks work but lose most of the gain.
- **One process per directory.** The server and each worker keep their own size
  accounting, so give each its own directory (or its own volume). Sharing a directory
  does not corrupt data, but the limit is then not enforced across processes.
- The cache costs disk reads of whole blocks: a small range read fetches up to one
  block from the origin the first time. Lower `LANCEDB_S3_CACHE_BLOCK_KB` (for example
  256) if your index reads are small and sparse.

Watch the `[lancedb-s3]` line logged every 60 seconds: `cache_hits`, `cache_misses`,
`cache_hit_ratio`, `cache_bytes_served`, `cache_bytes_filled`, `cache_evictions`,
`cache_size_bytes` and `upstream_requests` (see
[dependency tracing](../dependency-tracing.md)). A steady stream of evictions with a
low hit ratio means the working set is larger than `LANCEDB_S3_CACHE_MAX_GB`. To empty
the cache, stop the process and delete the directory.

## Upgrades

To upgrade, pull the chosen release and run the same `up -d --build` command.
The one-shot `migrate` service applies the checked-in migrations before the
server and worker start. Watch its exit status and the server logs. Breaking schema
changes are possible while DocSlurp is pre-release; read release notes before
upgrading and keep a rollback backup (see [Backups and restore](#backups-and-restore)).

### Moving to per-workspace LanceDB databases (migration 0082)

Vectors used to live in org-level tables
(`<LANCEDB_URI>/<orgId>/vectors/<model>/<dims>`, `chunks_org_…`). Every
workspace now has its own database,
`<LANCEDB_URI>/<orgId>/<workspaceId>/vectors-<model>-<dims>`, and search reads
only that one. Until existing rows are moved, vector search returns nothing
for documents indexed before the upgrade (keyword search still works; the API
counts `lanceTableMissing` and logs `[search] lancedb table missing`).

1. Stop ingest (or let runs finish), then upgrade the server and worker
   together. Migration 0082 repoints pending queued vector writes at their
   workspace database and marks old org-deletion cleanup rows.
2. Move the rows, without re-embedding, from the worker image:
   `node worker/dist/stages/lancedb-relocate-cli.js --all --dry-run`, then
   without `--dry-run`, with ingest still stopped. It routes each row to its
   document's workspace (dedup copies in another workspace get their own
   rebound rows), keeps only rows whose chunk still exists, appends without
   replacing rows already in the workspace database, then builds the vector
   and full-text indexes. Reruns converge. Rows of deleted documents and
   replaced chunks stay behind (`orphan_rows`, `stale_rows`).
   It registers every table it maintains for the maintenance sweep; after
   changing `vectorIndexMinRows`, rerun with `--maintain-all` to index tables
   that already crossed the new threshold.
3. Resume ingest, check search in a few workspaces, then rerun with
   `--drop-legacy` to delete the org-level tables (they hold chunk text). It
   drops only after a run that read every row and had no error. Deleting an
   org queues its org-level tables for the cleanup sweep too.

Rolling back the code reads the org-level tables again, which miss anything
indexed after the upgrade: keep them until step 3 and reprocess documents
uploaded since.

## Monitoring

- `GET /health` returns `{"ok":true,...}` while the server process is up. The
  container healthcheck uses it.
- `GET /ready` checks dependencies and returns 503 when a critical one fails. Only
  Fly deployments redact it for public requests (`arrivedThroughPublicEdge` in
  `server/src/routes/health.ts`, which needs `FLY_APP_NAME`). In the Compose stack
  `/ready` returns full detail to every caller: latencies, schema version and
  error text. For a public deployment, block `/ready` and `/metrics` at the
  reverse proxy. See [Public access](public-access.md#block-internal-endpoints).
- `GET /metrics` returns Prometheus text. It needs
  `Authorization: Bearer <METRICS_SECRET>`, using the `METRICS_SECRET` value from
  `.env.selfhost`. It returns 404 when `METRICS_SECRET` is unset and 401 when the
  header is wrong.
- Container logs: `docker compose --env-file .env.selfhost -f compose.selfhost.yml logs -f server worker`.

Watch disk, memory, worker errors and `/health` before inviting users.

## Scaling workers on one host

Each worker processes `WORKER_DOC_CONCURRENCY` documents at a time (default `1`).
To use more of one machine, either raise that value in `.env.selfhost` or run
more worker containers:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --scale worker=2
```

With the full worker: `docker compose --env-file .env.selfhost -f compose.selfhost.yml --profile full up -d --scale worker=0 --scale worker-full=2`.

Memory is the limit. Raise one setting at a time and watch memory and latency
after each change. See [sizing](requirements.md#sizing) for what has been measured.
This is scaling on a single host, not a multi-host design.

## Troubleshooting

| Symptom or message | Cause | Fix |
| --- | --- | --- |
| `Missing .env.selfhost. Run: node scripts/selfhost-init.mjs` | `scripts/selfhost-check.mjs` found no `.env.selfhost`. | Run `node scripts/selfhost-init.mjs` from the repository root. |
| `.env.selfhost already exists; keeping its credentials unchanged.` | `selfhost-init.mjs` never overwrites an existing file. | Nothing to fix. Delete the file only if you want new credentials and a new database. |
| `Missing self-host values:` followed by names | Required keys are blank in `.env.selfhost`. | Fill them in, or regenerate the file. |
| `Use HTTPS for a non-local SELFHOST_URL.` | `SELFHOST_URL` is plain `http://` on a non-local host. | Put a TLS proxy in front and set `SELFHOST_URL=https://your-domain`. See [Public access](public-access.md). |
| `Run node scripts/selfhost-init.mjs first` from `docker compose` | Compose was run without `--env-file .env.selfhost`, or the file is missing `DATABASE_URL`. | Use the full command from [Docker Compose install](docker-compose.md#start). |
| `Required services are not running` from `selfhost-check.mjs --running` | A service exited or never started. | Run `ps --all` and read that service's logs. |
| `Server health check failed: fetch failed` | The server is still starting (about 15 seconds), or it crashed, or it is not answering on the bound port. | Wait until `ps` shows the server as `healthy`, then run the check again. If it stays down, read `logs server` and check `SERVER_BIND_ADDRESS` and `SERVER_PORT`. |
| The `migrate` service exits non-zero; server and worker never start. Logs show `[migrate] failed:` | A migration failed, or Postgres is unreachable. The server and worker wait for `migrate` to complete successfully. | Read `logs migrate`. `[migrate] waiting for the migration lock` means another migration holds the lock. Fix the cause and run `up -d` again. Restore from backup if a release broke the schema. |
| `<binary> fails inside the parser sandbox (exit <n>): ...` and the worker exits at start | The sandbox works, but a real parser (`ffprobe`, `ffmpeg`, `pdftoppm` or `pandoc`) cannot run in it, usually because a shared library is outside the paths the provider exposes (for example ffmpeg's `libblas.so.3` through `/etc/alternatives`). The text after the colon is the binary's own first stderr line. | Fix the library path or install the missing library in the image. Re-run `node worker/dist/sandbox/probe-cli.js` to reproduce. |
| `parser isolation unavailable` and the worker exits at start | `scripts/check-worker-prerequisites.mjs --sandbox` could not run the selected sandbox provider (bubblewrap by default). The host forbids unprivileged user namespaces or mounts (sysctl or AppArmor), or `systempaths=unconfined` was removed. | Start the worker with `compose.selfhost.yml` as shipped and keep the `security_opt` entries. On Ubuntu 23.10+, check `kernel.apparmor_restrict_unprivileged_userns`. See the host notes in [Requirements](requirements.md#host-requirements) and [Parser sandbox](security.md#parser-sandbox). |
| `parser isolation unavailable: bwrap: No permissions to create a new namespace` or `bubblewrap unavailable; refusing to run parser without isolation` (provider `bubblewrap`) | The container or host blocks user namespaces, or `bwrap` is not installed. | Keep the `security_opt` entries from `compose.selfhost.yml`, or switch to `DOCSLURP_PARSER_SANDBOX=landlock`. See [Parser sandbox providers](sandbox-providers.md#where-these-providers-work-in-containers). |
| `parser isolation unavailable: ... (kernel <version>)` (provider `landlock`) | `landrun` is missing, `DOCSLURP_LANDRUN_BINARY` points at the wrong path, or the kernel does not expose Landlock ABI v9, which landrun v0.1.17 requires (the error says `missing kernel Landlock support`). The text before `(kernel ...)` is landrun's own error. | Use the worker image, or install the pinned release from `worker/sandbox-tools.json` (needs glibc 2.38 or newer). Check the kernel exposes Landlock ABI v9. On an older kernel, such as Fargate's, use `bubblewrap` or `modal`. |
| `missing kernel Landlock support. Got Landlock ABI vN, wanted {Landlock V9; ...}` (inside `parser isolation unavailable: ...`, provider `landlock`) | The kernel is too old for landrun v0.1.17, which needs Landlock ABI v9. AWS Fargate (kernel 6.1, ABI v2) is an example. | Use `bubblewrap` on a host that allows user namespaces, or `modal`. See [Parser sandbox providers](sandbox-providers.md#where-these-providers-work-in-containers). |
| `parser isolation unavailable: modal package not installed` (provider `modal`) | The optional `modal` dependency was not installed. | Install `@docslurp/worker` with optional dependencies, or use the worker image. |
| `Invalid sandbox configuration; missing required: MODAL_TOKEN_ID, MODAL_TOKEN_SECRET` (provider `modal`) | The tokens are unset. | Set both on the worker. Invalid number settings are reported the same way, by variable name. |
| `parser isolation unavailable: ...` with a Modal error, or `modal client rejected configuration` (provider `modal`) | Modal rejected the token, or the app could not be opened. The message is Modal's error with token values redacted. | Check the token pair and `DOCSLURP_MODAL_APP` in the Modal dashboard. |
| `Invalid sandbox configuration; missing required: DOCSLURP_MODAL_IMAGE (DOCSLURP_VERSION is unset, ...)` (provider `modal`) | The worker runs from source or a local image build, which has no release version to pick the default image from. | Set `DOCSLURP_MODAL_IMAGE` to an image that contains the parser binaries. |
| `Invalid sandbox configuration; invalid: DOCSLURP_MODAL_IMAGE_DIGEST (...)` or `invalid: DOCSLURP_MODAL_IMAGE (digest must be sha256:<64 hex>)` (provider `modal`) | The digest is not `sha256:` plus 64 lowercase hex characters, or it differs from the digest already in `DOCSLURP_MODAL_IMAGE`. | Copy the digest from the `worker-images.yml` run summary or `docker buildx imagetools inspect`, after verifying it ([Verifying worker images](security.md#verifying-worker-images)). Set it in one place, or the same value in both. |
| Activities fail with `modal sandbox creation failed: ...` although the worker started (provider `modal`) | The start-up probe only checks the token and app; it does not pull the image. A wrong `DOCSLURP_MODAL_IMAGE`, a private GHCR package, or a missing `DOCSLURP_MODAL_REGISTRY_SECRET` shows up at the first activity that runs a parser. `probe-cli` and `check-worker-prerequisites.mjs --sandbox` skip the binary checks for Modal, so they do not catch it either. | Check the image name and that Modal can pull it: make the GHCR package public, or set `DOCSLURP_MODAL_REGISTRY_SECRET`. |
| `parser sandbox provider 'none' is not allowed in production` | `DOCSLURP_PARSER_SANDBOX=none` with `NODE_ENV=production`. | Choose a real provider, or set `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true` knowing parsers then run on the host. |
| `Unknown DOCSLURP_PARSER_SANDBOX provider` | Typo in the provider id. | Use `bubblewrap`, `landlock`, `modal` or `none`. |
| `TEMPORAL_NAMESPACE must be set to a non-default namespace in production` | `TEMPORAL_NAMESPACE` is unset or `default`. | Compose sets `docslurp`. Set a non-default namespace if you changed it. |
| Full worker shows `[worker-start] installing deferred Python deps` for a long time | With no vendor bundle source, the full worker pip-installs several GB on first boot. | Wait, or set `DOCSLURP_VENDOR_BUNDLE_BASE_URL`. See [Worker image and vendor bundles](../worker-image.md). |
| Storage errors after you edited `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` | MinIO, the server and the worker all read these as one credential. They disagree until every service is recreated. | Recreate them together with `up -d`. If errors continue, change the keys back. |
| Postgres rejects the new password after you edited `POSTGRES_PASSWORD` | Postgres sets its password only when the volume is first created. | Change it inside Postgres with `ALTER USER docslurp PASSWORD '...'`, then update `POSTGRES_PASSWORD` and the `DATABASE_URL` password to match and run `up -d`. |

## Export cleanup

Zip exports (`POST /v1/exports`) are built by the worker on the `docslurp-document-export` task queue (override with `TEMPORAL_DOCUMENT_EXPORT_TASK_QUEUE` on both the API and the worker) and stored at `exports/<orgId>/<workspaceId>/<exportId>.zip`. Each link lives seven days. The API's maintenance sweep (`MAINTENANCE_SWEEP_INTERVAL_MS`) emails finished exports over 250 MB through Resend, deletes objects whose seven days have passed or whose document, workspace or requester was deleted (including organization offboarding), and marks exports unfinished after six hours as failed. Exports hold at most 65,000 files (zip without ZIP64); past that, page-by-page Markdown is left out and the README says so. Look for `[document-export]` log lines.

As a backstop, add a bucket lifecycle rule that expires objects under the `exports/` prefix after 8 days, so a stopped sweep never leaves exports behind:

```json
{ "Rules": [{ "ID": "expire-exports", "Status": "Enabled", "Filter": { "Prefix": "exports/" }, "Expiration": { "Days": 8 } }] }
```

```bash
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --endpoint-url "$S3_ENDPOINT" --lifecycle-configuration file://lifecycle.json
```

Merge this rule into any existing lifecycle configuration (such as incomplete-multipart expiry) rather than replacing it.
