# Operations

Commands on this page run from the repository root, with the stack started as
described in [Docker Compose install](docker-compose.md).

## Automatic upload completion and Tigris notifications

Direct upload sessions finalize automatically, one file at a time, and start
ingestion in waves (several runs per upload, one project) while files are still
arriving. For known-size multipart uploads, the API lists stored parts, checks
every part number and size, and assembles the object; single-PUT objects are
verified and sealed. Unknown-size streams must send an end-of-stream completion
with their final byte count; the SDK does this after every part succeeds. The SDK
then polls session status for the accepted runs. Acceptance means ingestion has
started or is queued; it does not mean extraction has finished. There is no separate client
confirmation required to start ingestion.

The API runs the reconciler every 15 seconds. Its fallback checks files still
open after `DOCSLURP_UPLOAD_FINALIZE_GRACE_SECONDS` (default 60) in bounded
batches, with per-file backoff up to five minutes, so self-hosted S3/MinIO
installations do not require notifications. Waves start when
`DOCSLURP_UPLOAD_WAVE_FILES` finalized files (default 5) are waiting, after
`DOCSLURP_UPLOAD_WAVE_DELAY_MS` (default 10000) from the first of them, or when
the last file is finalized. `DOCSLURP_UPLOAD_WAVE_GROWTH` (default 1) multiplies
the file count each later wave waits for: 2 makes waves of 5, 10, 20, ... files,
so a 1,000-file upload becomes a handful of runs instead of one per 5 files. Unfinished transfers expire after 24 hours: files no
run took become `aborted`, and runs already started continue. Keep the API
process running; a process that sleeps between requests cannot execute
background sweeps or wave timers.
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

For Tigris, a notification makes the API finalize the file it names at once, in
the background (`DOCSLURP_UPLOAD_WEBHOOK_FINALIZE_CONCURRENCY` files at a time
per API process, default 8). Configure these **after applying migrations and
deploying the receiver**:

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
   verify that each session's runs together hold every file once. A repeated
   notification must not create another run.

The receiver authenticates the bearer token, matches the configured storage
bucket, refuses keys outside the upload prefixes (`<user>/<id>/raw/...` and
`extracts/<org>/<extract>/raw/...`), maps each remaining key to exactly one open
file of a live session in that prefix, and finalizes that file from storage's own
size and version. It uses nothing from a notification except the key and never
trusts its byte counts. Duplicate or late notifications are harmless; a lost one
is covered by the fallback.
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

Check that it is in use: the `[lancedb-s3]` log line must show `requests` above zero after a
search. A line that stays at zero means Lance is not going through the proxy.

Setting the directory starts the same localhost re-signing proxy that
`LANCEDB_S3_TRACE` uses (tracing itself stays off) and needs explicit credentials in the
storage URI or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. It works with any
S3-compatible provider.

The proxy and the cache directory serve this process only:

- The proxy listens on `127.0.0.1` and answers only requests that carry its own per-process
  session-token header (never a URL capability), for keys under the bucket and first path segment of `LANCEDB_URI` (`lancedb/` in
  `s3://bucket/lancedb`). Anything else gets 403 and counts as `refused` on
  the `[lancedb-s3]` line; a non-zero count means something else on the host is probing it.
- The cache directory must be owned by the server's user and not writable by group or others.
  It is kept at mode 0700. A directory that fails this is not used: the server logs
  `disk cache ... is unusable` and searches without it.
- Changing `LANCEDB_S3_CACHE_BLOCK_KB` empties the cache at the next start.
- With `HTTP_PROXY` or `ALL_PROXY` set, add the literal `127.0.0.1` to `NO_PROXY` (upper case
  if you set it at all; `*` is not enough). Otherwise the proxy and the cache stay off
  (logged), because Lance would send its loopback requests to that proxy.
- The proxy sends to the endpoint a direct connection would use: `AWS_ENDPOINT_URL_S3` when
  set, then the storage URI's endpoint.
- Cache bytes and validation leases are isolated by a nonreversible fingerprint of the upstream
  endpoint and credentials; a less privileged credential cannot reuse another caller's cache.
- Each object is checked against origin before its first cached read after process start,
  then at most every 30 seconds. Set `LANCEDB_S3_CACHE_REVALIDATE_SECONDS=0` to check every
  cached read (allowed range 0–30). A refusal, missing object or failed check drops cached
  bytes and never serves a stale response. Changed ETags invalidate outstanding fills.
- A sweep every 30 seconds removes objects idle for five minutes, including orphan blocks
  whose metadata was evicted. Thus external deletions are noticed on active reads within
  the validation interval, and unused disk copies disappear within five minutes plus the
  sweep interval. This is a disk-cache bound; native memory caches and request result caches
  have their own lifetimes. Delete the cache directory to clear disk bytes immediately.

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

### Moving to per-project LanceDB databases (migration 0082)

Vectors used to live in org-level tables
(`<LANCEDB_URI>/<orgId>/vectors/<model>/<dims>`, `chunks_org_…`). Every
project now has its own database,
`<LANCEDB_URI>/<orgId>/<projectId>/vectors-<model>-<dims>`, and search reads
only that one. Until existing rows are moved, vector search returns nothing
for documents indexed before the upgrade (keyword search still works; the API
counts `lanceTableMissing` and logs `[search] lancedb table missing`).

1. Stop ingest (or let runs finish), then upgrade the server and worker
   together. Migration 0082 repoints pending queued vector writes at their
   project database and marks old org-deletion cleanup rows.
2. Move the rows, without re-embedding, from the worker image:
   `node worker/dist/stages/lancedb-relocate-cli.js --all --dry-run`, then
   without `--dry-run`, with ingest still stopped. It routes each row to its
   document's project (dedup copies in another project get their own
   rebound rows), keeps only rows whose chunk still exists, appends without
   replacing rows already in the project database, then builds the vector
   and full-text indexes. Reruns converge. Rows of deleted documents and
   replaced chunks stay behind (`orphan_rows`, `stale_rows`).
   It registers every table it maintains for the maintenance sweep; after
   changing `vectorIndexMinRows`, rerun with `--maintain-all` to index tables
   that already crossed the new threshold.
3. Resume ingest, check search in a few projects, then rerun with
   `--drop-legacy` to delete the org-level tables (they hold chunk text). It
   drops only after a run that read every row and had no error. Deleting an
   org queues its org-level tables for the cleanup sweep too.

Rolling back the code reads the org-level tables again, which miss anything
indexed after the upgrade: keep them until step 3 and reprocess documents
uploaded since.

### Rescanning documents after the parse-source upgrade (migrations 0134-0135)

Quarantine now records a parse decision on each document it accepts: the scan
version and the sha256 of the bytes parsers read. Every parser, the page
renderer and materialization refuse a document without a decision from the
current scan. That includes every document ingested before this upgrade. Its
existing Markdown, search index and cached page images keep working. A page
image that was never rendered answers the typed state `{ "status":
"unavailable", "reason": "needs-reprocess", "canReprocess": ... }` (HTTP 200,
see [ingest versions](../ingest-version.md)). Search materialization reports
such pages with reason `quarantine-rescan-required` and the same typed
`availability`. Reprocessing a document runs quarantine again
first and records a decision.

1. Drain every worker running an older release before starting new workers.
   An old worker parses without recording a decision, and a new one refuses
   that work.
2. List the documents that need a rescan. Nothing is changed:
   `pnpm -C server reprocess:unscanned` (the same as `--dry-run`). It prints the
   candidates per organization. Candidates are live, completed PDFs without a
   current decision; add `--all-types` to include every format. Use `--org=<id>`
   (repeatable) to scope the run and `--limit=<n>` (default 1000) to cap it.
3. Reprocess them: add `--apply`, optionally with `--batch-size=<n>` (default
   50, at most 500) and `--pause-ms=<ms>` between batches. Each batch is one bulk
   reprocess, run as the organization's earliest owner. Reprocesses are billed
   to the organization like any other reprocess, so make sure it has credits.
   A refused batch is reported in `failedDocuments`/`errors` and is not
   retried. Documents whose newer version is already queued or processing are
   skipped, so you can rerun the command to resume.

Turning on `DOCSLURP_QUARANTINE_SCAN_SNAPSHOT` before a large wave keeps each
scan short. Users can also reprocess a single document from the reader when it
shows the rescan message.

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

## Project search and chat counters

The project list and board read each project's search and chat totals from
`project_activity_stats` instead of counting history on every request. Triggers
on `search_sessions`, `chat_turns` and `chat_sessions` keep those counters equal
to history in the same transaction as each write.

The counters can only drift when a write bypasses the triggers:

- `session_replication_role = replica` (logical replication apply, and some
  restore and copy tools set it);
- `ALTER TABLE ... DISABLE TRIGGER` on one of the three tables;
- a manual change to `project_activity_stats` or to history with triggers off;
- a restore of some of these tables without the others. A full `pg_restore` of
  the database restores the counters with the history and needs nothing.

**Detect.** The server compares a few projects with their history every 10
minutes (`PROJECT_ACTIVITY_STATS_DRIFT_CHECK_INTERVAL_MS`, `0` turns it off) and
logs `[project-activity-stats] counter drift in ...` with the stored and actual
numbers. It reports only; it never repairs. (The same sweep folds the spare
counter rows that concurrent writers leave for a project into one, which changes
no total.) To check every project on demand:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml exec server \
  node server/db/project-activity-stats.mjs            # exit 1 and one line per project on drift
node server/db/project-activity-stats.mjs --project <project-id>   # from a checkout, with DATABASE_URL set
```

The check is one read-only statement (`select * from project_activity_stats_drift()`):
it blocks nothing and is exact while traffic flows. Without `--project` it reads
all search and chat history, about a second per million search sessions, so run
it off-peak on a large database.

**Repair.**

```sh
node server/db/project-activity-stats.mjs --rebuild
```

This recomputes every counter from history (`rebuild_project_activity_stats()`)
in one transaction and then runs the check. While it reads the history, search
and chat writes wait (reads continue): about a second per million search
sessions. It waits at most `PROJECT_ACTIVITY_STATS_LOCK_TIMEOUT_MS` (default
`5000`) for its table locks and retries, so it never queues traffic behind a
long-open transaction, and a failed attempt changes nothing. Running it twice
stores the same totals. After any operation from the list above, run the
rebuild once the triggers are back on.

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
| `parser isolation unavailable: bwrap: No permissions to create a new namespace` or `bubblewrap unavailable; refusing to run parser without isolation` (provider `bubblewrap`) | The container or host blocks user namespaces, or `bwrap` is not installed. | Keep the `security_opt` entries from `compose.selfhost.yml`, or switch to `DOCSLURP_PARSER_SANDBOX=modal`. Landlock is no way around this: it also needs user namespaces for its per-command PID namespace. See [Parser sandbox providers](sandbox-providers.md#where-these-providers-work-in-containers). |
| `parser isolation unavailable: ... (kernel <version>)` (provider `landlock`) | `landrun` is missing, `DOCSLURP_LANDRUN_BINARY` points at the wrong path, or the kernel does not expose Landlock ABI v9, which landrun v0.1.17 requires (the error says `missing kernel Landlock support`). The text before `(kernel ...)` is landrun's own error. | Use the worker image, or install the pinned release from `worker/sandbox-tools.json` (needs glibc 2.38 or newer). Check the kernel exposes Landlock ABI v9. On an older kernel, such as Fargate's, use `bubblewrap` or `modal`. |
| `missing kernel Landlock support. Got Landlock ABI vN, wanted {Landlock V9; ...}` (inside `parser isolation unavailable: ...`, provider `landlock`) | The kernel is too old for landrun v0.1.17, which needs Landlock ABI v9. AWS Fargate (kernel 6.1, ABI v2) is an example. | Use `bubblewrap` on a host that allows user namespaces, or `modal`. See [Parser sandbox providers](sandbox-providers.md#where-these-providers-work-in-containers). |
| `parser isolation unavailable: modal package not installed` (provider `modal`) | The optional `modal` dependency was not installed. | Install `@docslurp/worker` with optional dependencies, or use the worker image. |
| `Invalid sandbox configuration; missing required: MODAL_TOKEN_ID, MODAL_TOKEN_SECRET` (provider `modal`) | The tokens are unset. | Set both on the worker. Invalid number settings are reported the same way, by variable name. |
| `parser isolation unavailable: ...` with a Modal error, or `modal client rejected configuration` (provider `modal`) | Modal rejected the token, or the app could not be opened. The message is Modal's error with token values redacted. | Check the token pair and `DOCSLURP_MODAL_APP` in the Modal dashboard. |
| `Invalid sandbox configuration; missing required: DOCSLURP_MODAL_IMAGE (DOCSLURP_VERSION is unset, ...)` (provider `modal`) | The worker runs from source or a local image build, which has no release version to pick the default image from. | Set `DOCSLURP_MODAL_IMAGE` to an image that contains the parser binaries. |
| `Invalid sandbox configuration; invalid: DOCSLURP_MODAL_IMAGE_DIGEST (...)` or `invalid: DOCSLURP_MODAL_IMAGE (digest must be sha256:<64 hex>)` (provider `modal`) | The digest is not `sha256:` plus 64 lowercase hex characters, or it differs from the digest already in `DOCSLURP_MODAL_IMAGE`. | Copy the digest from the `worker-images.yml` run summary or `docker buildx imagetools inspect`, after verifying it ([Verifying worker images](security.md#verifying-worker-images)). Set it in one place, or the same value in both. |
| Activities fail with `modal sandbox creation failed: ...` although the worker started (provider `modal`) | The start-up probe only checks the token and app; it does not pull the image. A wrong `DOCSLURP_MODAL_IMAGE`, a private GHCR package, or a missing `DOCSLURP_MODAL_REGISTRY_SECRET` shows up at the first activity that runs a parser. `probe-cli` and `check-worker-prerequisites.mjs --sandbox` skip the binary checks for Modal, so they do not catch it either. | Check the image name and that Modal can pull it: make the GHCR package public, or set `DOCSLURP_MODAL_REGISTRY_SECRET`. |
| `parser sandbox provider 'none' runs parsers on the host ... allowed only in development or test` | Provider `none` (set, or the non-Linux default) outside development or test. | Configure the VM provider in production, or `bubblewrap` or `landlock` elsewhere. Only development runs parsers on the host unisolated. |
| `... weakens untrusted-file protection as set and is allowed only in development or test ...; refusing to start` | A [development-only setting](configuration.md#development-only-settings) is set outside development or test. | Unset it, or set it to `false`. |
| `Unknown DOCSLURP_PARSER_SANDBOX provider` | Typo in the provider id. | Use `bubblewrap`, `landlock`, `modal` or `none`. |
| `TEMPORAL_NAMESPACE must be set to a non-default namespace in production` | `TEMPORAL_NAMESPACE` is unset or `default`. | Compose sets `docslurp`. Set a non-default namespace if you changed it. |
| Full worker shows `[worker-start] installing deferred Python deps` for a long time | With no vendor bundle source, the full worker pip-installs several GB on first boot. | Wait, or set `DOCSLURP_VENDOR_BUNDLE_BASE_URL`. See [Worker image and vendor bundles](../worker-image.md). |
| Storage errors after you edited `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` | MinIO, the server and the worker all read these as one credential. They disagree until every service is recreated. | Recreate them together with `up -d`. If errors continue, change the keys back. |
| Postgres rejects the new password after you edited `POSTGRES_PASSWORD` | Postgres sets its password only when the volume is first created. | Change it inside Postgres with `ALTER USER docslurp PASSWORD '...'`, then update `POSTGRES_PASSWORD` and the `DATABASE_URL` password to match and run `up -d`. |

## Export cleanup

Zip exports (`POST /v1/exports`) are built by the worker: exports under 250 MB on the `docslurp-document-export` task queue and larger, emailed ones on `docslurp-document-export-large` (override with `TEMPORAL_DOCUMENT_EXPORT_TASK_QUEUE` and `TEMPORAL_LARGE_DOCUMENT_EXPORT_TASK_QUEUE` on both the API and the worker), one slot each per worker. Set `WORKER_DOCUMENT_EXPORTS=off` on workers that scale in or restart often, so exports run on long-lived machines; streaming a 2 GB export peaks around 185 MB of worker memory. Exports are stored under `exports/<orgId>/<projectId>/<exportId>/`, one zip per attempt. Each link lives seven days from when the export is ready. Downloads redirect to a two-minute presigned storage link, so the bucket's public endpoint (`DOCSLURP_STORAGE_PUBLIC_BUCKET_URL`, when set) must serve signed GETs; the link sets the download filename and `Cache-Control: private, no-store`. The API's maintenance sweep (`MAINTENANCE_SWEEP_INTERVAL_MS`) emails finished exports over 250 MB through Resend (five attempts with backoff), when the worker has woken the app via `WORKER_APP_KEEPALIVE_URL`, deletes objects whose seven days have passed or whose document, project or requester was deleted (including organization and account deletion), and marks exports unfinished after ten hours as failed. Exports hold at most 65,000 files (zip without ZIP64); past that, page-by-page Markdown is left out and the README says so. Look for `[document-export]` log lines.

As a backstop, add a bucket lifecycle rule that expires objects under the `exports/` prefix after 8 days, so a stopped sweep never leaves exports behind:

```json
{ "Rules": [{ "ID": "expire-exports", "Status": "Enabled", "Filter": { "Prefix": "exports/" }, "Expiration": { "Days": 8 }, "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } }] }
```

```bash
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --endpoint-url "$S3_ENDPOINT" --lifecycle-configuration file://lifecycle.json
```

Merge this rule into any existing lifecycle configuration (such as incomplete-multipart expiry) rather than replacing it.

## Worker notification events

Workers never send email. Run completed/failed, extraction plausibility warnings, budget alerts and secret-expiry alerts are written to the in-app notification inbox and emitted as `notification.<event>` OTLP log records (logger `docslurp.events`), so they show up in SigNoz with the run, document, project and organization IDs as attributes. The API sends email only for sign-in codes and links, organization and project invites, and export or extract downloads, and it never sends to reserved domains (`*.local`, `*.test`, `*.invalid`, `*.example`, `localhost`, `example.com/net/org`); those sends are logged as `provider=suppressed`.


### Search readiness and warm-up admission

In production, startup awaits the most recently searched projects' selected indexes before
standalone listening or embedded `/ready` can succeed. `SEARCH_BOOT_WARM_PROJECTS` defaults
to 5 (maximum 50); 0 disables this readiness warm-up. The startup attempt is shared across
requests and has a 30-second deadline. Exceeding it keeps readiness unsuccessful for that
process, even if a native load later completes: restart after resolving storage/size trouble,
or explicitly set the warm-up limit to 0. Liveness remains separate in the embedded app.

Eager loading requires known manifest size. Twice the table's total on-disk bytes must fit
within both half the configured index cache and one eighth of usable machine RAM. Unknown
or oversized tables skip eager loading and search them on demand. At most two native eager
loads run concurrently; a caller timeout does not release a still-running native load's slot,
and expired queued jobs do not begin native work. These conservative estimates are admission
limits, not a guarantee of exact allocator memory use.

### Partitioned vector indexes and index-only reindexing

New and consolidated HNSW-SQ indexes target 1,000 rows per partition, rounded up to a
power of two, at most 4,096 partitions and with at least 256 training rows per partition.
`LANCEDB_VECTOR_PARTITION_ROWS` changes this target; 0 restores the former one-partition
per million-row policy. Existing indexes are not rebuilt merely because the setting changes.

Search uses L2 with scalar quantization, at least 100 HNSW candidates for unfiltered
queries, 32 probes and refinement of two candidates per returned hit. Document/page filters
probe all partitions (up to the build cap) and remain prefilters. This preserves narrow-scope
recall at the cost of cold-read savings for filtered searches. `LANCEDB_REFINE_FACTOR` can
explicitly select 1–16. Recall and latency remain corpus-dependent: validate a new corpus
before changing build policy, and retain the per-scope results rather than only an average.

Reindexing replaces only the vector index, without extraction, embedding calls, table
replacement, compaction, pruning, or touching the FTS index. Stop writers to the selected
project while applying it: the row/memory estimate is a preflight check, not a transactional
limit on concurrent ingestion. Use the deployment's normal storage environment:

```sh
pnpm --filter @docslurp/worker exec tsx scripts/reindex-vector.ts \
  --org ORG_ID --project PROJECT_ID --model provider/model --dimensions 1024
# Review the dry-run plan, then repeat with --apply.
```

The default row budget is 100,000; `--max-rows` raises it explicitly, while the machine-memory
check still applies. A catalogued legacy URI may be selected with `--uri`, but must remain
inside that exact organization's project root and its vector dimension must match. Apply
one project at a time. Replacement commits a new index version atomically; older table
versions remain available for the configured retention window. A rollback changes the build
policy and rebuilds the vector index again; rolling back application code alone does not
restore the previous on-disk index layout.

For a bounded local comparison, prepare a local table with only `id`, `documentId` and
`vector` columns and run `worker/scripts/vector-index-recall.ts --database PATH --table NAME
--output NEW_DIRECTORY --tuned`. It holds out 64 real vectors, compares both arms against
exact flat search, reports screening/confirmation separately for unfiltered and document
scopes, records production query policy, and exits nonzero if either scope misses 95% mean
recall@10 or regresses more than one percentage point. Its output stays local; do not publish
customer vectors/identifiers. `vector-index-cold.ts` measures process-cold local read bytes;
these are neither physical I/O nor a production S3 latency measurement.
