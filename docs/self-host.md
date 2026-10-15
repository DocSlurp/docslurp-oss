# Self-host DocSlurp

This is the single-host Docker Compose install. It runs the API server, one lean
worker, Postgres with pgvector, Redis, MinIO, and Temporal. Postgres and MinIO
use named Docker volumes. Only the server binds a host port, on localhost by
default. This setup is suitable for a small private installation or a server
behind a TLS reverse proxy; it is not a multi-host or high-availability design.

## Requirements

- Docker Engine with Compose v2 and enough disk for document artifacts and images.
- At least 8 GB of RAM for the lean worker; the optional full worker needs more
  memory and disk for OCR, LibreOffice, and Python models.
- A recent Node.js installation for the one-time configuration generator. Node
  is not needed to run the containers after setup.

## Start

From a clean checkout:

```sh
node scripts/selfhost-init.mjs
node scripts/selfhost-check.mjs
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --build
node scripts/selfhost-check.mjs --running
```

Check <http://localhost:8787/health>. There is no bundled web UI: use the REST API, CLI, SDK or MCP. The first build and first
worker start can take several minutes. No seeded developer accounts are created
in this production-mode stack. API routes are available under `/v1`.

The generated `.env.selfhost` contains distinct random values for database,
storage, auth, encryption, and metrics. It is ignored by Git. Store a secure
backup of it: changing encryption keys later can make stored credentials and
secrets unreadable.

The worker containers run with `systempaths=unconfined` so the parser sandbox (bubblewrap) can mount a fresh `/proc`; all capabilities remain dropped and the seccomp profile still applies. Without it the worker reports `parser isolation unavailable` and refuses to start.

To view status or logs:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml ps --all
docker compose --env-file .env.selfhost -f compose.selfhost.yml logs -f server worker
```

## Configuration

Edit `.env.selfhost` before running `up`. Recreate affected containers after an
edit with the same `up -d` command. The [template](../.env.selfhost.example)
lists all supported first-run options.

| Option | Default | Purpose |
| --- | --- | --- |
| `SELFHOST_URL` | `http://localhost:8787` | Public origin of the server for auth cookies, and OAuth callbacks. Use `https://your-domain` behind TLS. |
| `SERVER_BIND_ADDRESS` / `SERVER_PORT` | `127.0.0.1` / `8787` | Host listener. Keep it on loopback when a reverse proxy runs on the same host. |
| `BETTER_AUTH_TRUST_PROXY_HEADERS` | `false` | Set to `true` only behind a reverse proxy you control, after it overwrites forwarded host and protocol headers. |
| `WORKER_DOC_CONCURRENCY` | `1` | Documents processed concurrently by each worker. Increase after observing memory and latency. |
| `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | blank | Optional hosted AI models. Default local embedding mode needs no provider key; LLM-powered stages need a configured provider. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | blank | Optional OAuth sign-in. Configure provider callbacks at `SELFHOST_URL/api/auth/callback/github` or `/google`. |

Storage is preconfigured in `compose.selfhost.yml` as
`STORAGE_URI=s3://docslurp-files?endpoint=http://minio:9000&region=us-east-1`
and `LANCEDB_URI=s3://docslurp-files/lancedb`; the generated
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are the MinIO root credentials.
See [Storage configuration](#storage-configuration) for external buckets.

The other values in `.env.selfhost` are generated credentials. Keep the
`DATABASE_URL` password in sync with `POSTGRES_PASSWORD` if you rotate them.
Postgres credentials are initialized only when the volume is new; editing the
environment file does not rotate the password inside an existing database.

The default lean worker handles text-centric documents. For scans, images,
spreadsheets, and heavier extraction, switch to the full worker:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml --profile full up -d --build --scale worker=0
```

This switches the queue consumer to the full worker. It needs more resources.
Both workers bake the base Python parsers (the Office/EPUB/HTML
readers; PDFs go through Kreuzberg and Poppler). Docling and Unstructured come from prebuilt vendor bundles when
`DOCSLURP_VENDOR_BUNDLE_BASE_URL` is set: an `https://` mirror or a
`file:///path` directory of bundle archives, verified against the sha256 pins in
`worker/vendor-bundles.json`. The bucket DocSlurp's own workers read is private, so build the bundles yourself and serve them from your own mirror. Without a bundle source, the full worker falls back
to pip-installing them on first boot (several GB; set
`DOCSLURP_WORKER_INSTALL_HEAVY_DEPS_ON_STARTUP=false` to skip that). Watch its
logs before submitting heavy files. See [Worker image and vendor
bundles](worker-image.md) for sizes, flags and building bundles yourself. To switch back, run the original
`up -d` command, then stop `worker-full`:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml --profile full stop worker-full
```

## Storage configuration

Each storage adapter is configured by one URI. These rules apply to every
deployment (Compose, self-host, Fly, ECS) and to local development.

**Object storage** — `STORAGE_URI`:

```text
s3://[ACCESS_KEY:SECRET@]bucket?endpoint=...&region=...&pathStyle=...&purgeSupersededSources=...
```

| Query parameter | Default | Purpose |
| --- | --- | --- |
| `endpoint` | none (AWS) | S3-compatible endpoint for MinIO, Tigris, R2, etc. |
| `region` | `us-west-2` | Signing region; use `auto` for Tigris and R2. |
| `pathStyle` | `true` | Path-style addressing. Set `false` for AWS S3 virtual-hosted buckets. |
| `purgeSupersededSources` | `false` | Also delete the raw upload when a document version is replaced. |

Credentials come from URL-encoded userinfo or, as with any AWS SDK, from
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN`). The
Compose stacks use those two variables as the MinIO root user and password, so
keep them there for MinIO. The host `minio` is rewritten to `localhost` when a
process runs outside Docker, so one `.env` works for both.

```sh
# MinIO (Docker Compose; the default in .env.example)
STORAGE_URI=s3://docslurp-files?endpoint=http://minio:9000&region=us-west-2
# Fly Tigris
STORAGE_URI=s3://docslurp-files?endpoint=https://fly.storage.tigris.dev&region=auto
# Cloudflare R2
STORAGE_URI=s3://docslurp-files?endpoint=https://<account-id>.r2.cloudflarestorage.com&region=auto
# AWS S3 (no endpoint; credentials from the instance role or AWS_* variables)
STORAGE_URI=s3://docslurp-files?region=us-east-1&pathStyle=false
# Credentials inline (URL-encode reserved characters in the secret)
STORAGE_URI=s3://AKIA...:wJal%2Fr...@docslurp-files?region=us-east-1&pathStyle=false
```

**Vector indexes** — `LANCEDB_URI` is a bare path, `file:///path`, or an
`s3://bucket/prefix` root. Per-org tables are created under it. An `s3://` root
inherits endpoint, region, and credentials from `STORAGE_URI`; override them for
the index only with `?endpoint=`, `?region=`, or `?allowHttp=`.

```sh
# Local development (single machine only)
LANCEDB_URI=/tmp/docslurp-lancedb
LANCEDB_URI=file:///var/lib/docslurp/lancedb
# Shared by server and worker in the object-storage bucket
LANCEDB_URI=s3://docslurp-files/lancedb
# Different region for the index bucket
LANCEDB_URI=s3://docslurp-vectors/lancedb?region=eu-west-1
```

Use a shared `s3://` root whenever the server and worker run in separate containers
or machines. Log URIs only after redaction because `STORAGE_URI` may hold a
secret.

The pre-URI variables `S3_BUCKET`, `AWS_ENDPOINT_URL_S3`, and `AWS_REGION` are
deprecated. They are honored only when `STORAGE_URI` is unset and are no longer
forwarded to the sandboxed vector-writer script. The superseded-purge variables
(`DOCSLURP_SUPERSEDED_PURGE_*`, `DOCSLURP_PURGE_SUPERSEDED_SOURCES`) were removed;
use `purgeSupersededSources=true` on `STORAGE_URI` instead.

## Public access

Put a TLS reverse proxy such as Caddy, nginx, or Traefik in front of the
localhost server port. Set `SELFHOST_URL=https://your-domain` and
`BETTER_AUTH_TRUST_PROXY_HEADERS=true` if your proxy overwrites forwarded
headers. Keep `SERVER_BIND_ADDRESS=127.0.0.1` when the proxy runs on the same machine. Forward
normal HTTP requests and long-lived event streams without buffering; the server
uses live progress updates. If the proxy is on another host, bind the server to an
address reachable only on your private network and firewall the port.

For Caddy on the same host, a minimal site block is:

```caddyfile
your-domain.example {
  reverse_proxy 127.0.0.1:8787
}
```

### Client IP behind a proxy or CDN

Rate limits, audit logs and sign-in limits key on the client address. With no
proxy configured the server uses the right-most `X-Forwarded-For` entry
(`API_TRUSTED_PROXY_HOPS`, default 1) or `X-Real-IP`. Set `TRUSTED_PROXIES` to
a comma-separated list of the `cloudflare` keyword and/or CIDRs for the proxies
in front of the app:

| Setup | `TRUSTED_PROXIES` | Client address comes from |
| --- | --- | --- |
| Caddy/nginx only | unset (or the proxy's CIDR) | `X-Forwarded-For` the proxy appends |
| Cloudflare, then your proxy | `cloudflare,127.0.0.1` | `X-Forwarded-For`, skipping trusted hops from the right |
| Fly.io behind Cloudflare | `cloudflare` | `CF-Connecting-IP`, only if `Fly-Client-IP` is a Cloudflare address |

Forwarded headers are never read from a peer outside this set, so a client that
reaches the origin directly cannot choose its own address. `CF-Connecting-IP` is
honoured only for peers in Cloudflare's published ranges (pinned in
`packages/shared/src/cloudflare-ips.ts`; refresh with
`node scripts/update-cloudflare-ips.mjs`). Your proxy must overwrite, not
append to, any client-supplied `X-Forwarded-For`/`X-Real-IP`. To refuse
requests that skip the proxy, set `REQUIRE_TRUSTED_PROXY=true` (default off;
health and metrics paths stay open).

Do not publish the Postgres, Redis, MinIO, or Temporal ports. This Compose file
does not bind them to the host. For public use, configure backups and monitor
disk, memory, worker errors, and the `/health` endpoint before inviting users.

## Data, upgrades, and recovery

The named volumes `postgres_data` and `minio_data` hold database records and
raw/derived artifacts. LanceDB vector indexes live in MinIO under
`docslurp-files/lancedb`. Redis is an ephemeral rate-limit cache. Back up both
Postgres and MinIO, plus `.env.selfhost`, before upgrading. Test restores to a
separate host before relying on them.

To upgrade, pull the chosen release and run the same `up -d --build` command.
The one-shot `migrate` service applies the checked-in migrations before the
server and worker start. Watch its exit status and the server logs. Breaking schema
changes are possible while DocSlurp is pre-release; read release notes before
upgrading and keep a rollback backup.

Stop containers without deleting the named volumes:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml down
```

Do not add `--volumes` unless you intend to remove the stored database and
artifacts.
