# Operations

Commands on this page run from the repository root, with the stack started as
described in [Docker Compose install](docker-compose.md).

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

## Upgrades

To upgrade, pull the chosen release and run the same `up -d --build` command.
The one-shot `migrate` service applies the checked-in migrations before the
server and worker start. Watch its exit status and the server logs. Breaking schema
changes are possible while DocSlurp is pre-release; read release notes before
upgrading and keep a rollback backup (see [Backups and restore](#backups-and-restore)).

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
| `parser isolation unavailable: ... (kernel <version>)` (provider `landlock`) | `landrun` is missing, `DOCSLURP_LANDRUN_BINARY` points at the wrong path, or the kernel has no Landlock support. The text before `(kernel ...)` is landrun's own error. | Use the worker image, or install the pinned release from `worker/sandbox-tools.json` (needs glibc 2.38 or newer). Check the kernel has Landlock enabled. |
| `parser sandbox provider 'landlock' does not isolate the network` and the worker exits in production | Kernel older than 6.8, so landlock cannot deny TCP. | Use a 6.8+ kernel, or choose `bubblewrap` or `modal`. |
| `parser isolation unavailable: modal package not installed` (provider `modal`) | The optional `modal` dependency was not installed. | Install `@docslurp/worker` with optional dependencies, or use the worker image. |
| `Invalid sandbox configuration; missing required: MODAL_TOKEN_ID, MODAL_TOKEN_SECRET` (provider `modal`) | The tokens are unset. | Set both on the worker. Invalid number settings are reported the same way, by variable name. |
| `parser isolation unavailable: ...` with a Modal error, or `modal client rejected configuration` (provider `modal`) | Modal rejected the token, or the app could not be opened. The message is Modal's error with token values redacted. | Check the token pair and `DOCSLURP_MODAL_APP` in the Modal dashboard. |
| `Invalid sandbox configuration; missing required: DOCSLURP_MODAL_IMAGE (DOCSLURP_VERSION is unset, ...)` (provider `modal`) | The worker runs from source or a local image build, which has no release version to pick the default image from. | Set `DOCSLURP_MODAL_IMAGE` to an image that contains the parser binaries. |
| Activities fail with `modal sandbox creation failed: ...` although the worker started (provider `modal`) | The start-up probe only checks the token and app; it does not pull the image. A wrong `DOCSLURP_MODAL_IMAGE`, a private GHCR package, or a missing `DOCSLURP_MODAL_REGISTRY_SECRET` shows up at the first activity that runs a parser. `probe-cli` and `check-worker-prerequisites.mjs --sandbox` skip the binary checks for Modal, so they do not catch it either. | Check the image name and that Modal can pull it: make the GHCR package public, or set `DOCSLURP_MODAL_REGISTRY_SECRET`. |
| `parser sandbox provider 'none' is not allowed in production` | `DOCSLURP_PARSER_SANDBOX=none` with `NODE_ENV=production`. | Choose a real provider, or set `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true` knowing parsers then run on the host. |
| `Unknown DOCSLURP_PARSER_SANDBOX provider` | Typo in the provider id. | Use `bubblewrap`, `landlock`, `modal` or `none`. |
| `TEMPORAL_NAMESPACE must be set to a non-default namespace in production` | `TEMPORAL_NAMESPACE` is unset or `default`. | Compose sets `docslurp`. Set a non-default namespace if you changed it. |
| Full worker shows `[worker-start] installing deferred Python deps` for a long time | With no vendor bundle source, the full worker pip-installs several GB on first boot. | Wait, or set `DOCSLURP_VENDOR_BUNDLE_BASE_URL`. See [Worker image and vendor bundles](../worker-image.md). |
| Storage errors after you edited `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` | MinIO, the server and the worker all read these as one credential. They disagree until every service is recreated. | Recreate them together with `up -d`. If errors continue, change the keys back. |
| Postgres rejects the new password after you edited `POSTGRES_PASSWORD` | Postgres sets its password only when the volume is first created. | Change it inside Postgres with `ALTER USER docslurp PASSWORD '...'`, then update `POSTGRES_PASSWORD` and the `DATABASE_URL` password to match and run `up -d`. |
