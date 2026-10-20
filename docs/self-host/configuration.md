# Configuration

Edit `.env.selfhost` before running `up`. Recreate affected containers after an
edit with the same `up -d` command (see [Docker Compose install](docker-compose.md)).
The [template](../../.env.selfhost.example) lists all supported first-run options.

| Option | Default | Purpose |
| --- | --- | --- |
| `SELFHOST_URL` | `http://localhost:8787` | Public origin of the server for auth cookies, and OAuth callbacks. Use `https://your-domain` behind TLS. No trailing slash. |
| `DOCSLURP_ALLOW_INSECURE_LOCAL_AUTH_ORIGIN` | `true` in the template, `false` if unset | Allows a plain `http://localhost` or `http://127.0.0.1` `SELFHOST_URL` for local trial runs. Any other origin must use HTTPS regardless of this flag. |
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

The other values in `.env.selfhost` are generated credentials: `POSTGRES_PASSWORD`,
`DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`,
`OAUTH_TOKEN_ENCRYPTION_KEY`, `CREDENTIALS_ENCRYPTION_KEY`, `SECRETS_ENCRYPTION_KEY`
and `METRICS_SECRET`. Keep the
`DATABASE_URL` password in sync with `POSTGRES_PASSWORD` if you rotate them.
Postgres credentials are initialized only when the volume is new; editing the
environment file does not rotate the password inside an existing database.

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
# MinIO (development docker-compose.yml / .env.example)
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

## Temporal connection

The Compose file sets the Temporal connection for the server and workers. Change
these only to point at an external Temporal cluster. The server and the worker
read them through `packages/shared/src/temporal-security.ts`.

- `TEMPORAL_ADDRESS`: host and port of the Temporal frontend. Compose sets `temporal:7233`.
- `TEMPORAL_NAMESPACE`: namespace to use. Compose sets `docslurp`; production mode refuses `default`.
- `TEMPORAL_TASK_QUEUE`: task queue name. Defaults to `docslurp-pipeline`.
- `TEMPORAL_TLS_ENABLED`: set to `true` to connect over TLS.
- `TEMPORAL_TLS_SERVER_NAME`: server name override for certificate verification.
- `TEMPORAL_TLS_CA_CERT_PEM` / `TEMPORAL_TLS_CA_CERT_PATH`: CA certificate, inline or as a file path.
- `TEMPORAL_TLS_CLIENT_CERT_PEM` / `TEMPORAL_TLS_CLIENT_CERT_PATH`: client certificate, inline or as a file path.
- `TEMPORAL_TLS_CLIENT_KEY_PEM` / `TEMPORAL_TLS_CLIENT_KEY_PATH`: client key, inline or as a file path.

## Parser sandbox

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCSLURP_PARSER_SANDBOX` | `bubblewrap` on Linux; `none` elsewhere outside production | Provider: `bubblewrap`, `landlock`, `modal` or `none`. |
| `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED` | unset | `true` allows provider `none` in production and logs `[parser-sandbox] status=unisolated` at start. |
| `DOCSLURP_PARSER_SANDBOX_ROOT` | `/tmp/docslurp-parser-sandbox` | Scratch root (bubblewrap, landlock). |
| `DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS` | empty | Comma-separated private workspaces parsers may write (bubblewrap, landlock). |
| `DOCSLURP_LANDRUN_BINARY` | `landrun` | landrun executable (landlock). |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | required for `modal` | Modal API token. Secrets. |
| `DOCSLURP_MODAL_APP`, `DOCSLURP_MODAL_IMAGE`, `DOCSLURP_MODAL_CPU`, `DOCSLURP_MODAL_MEMORY_MB`, `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS` | `docslurp-parsers`, `ghcr.io/docslurp/worker-full:<version>`, `2`, `4096`, `900` | Modal sandbox settings. |

Details are in [Parser sandbox providers](sandbox-providers.md#configuration).

## Removed and deprecated

`DOCSLURP_PARSER_SANDBOX_ENABLED`, `DOCSLURP_PARSER_SANDBOX_MODE` and
`DOCSLURP_PARSER_SANDBOX_SCRIPT` were removed with no replacement of the same
name. Use `DOCSLURP_PARSER_SANDBOX` to choose a provider; to run without
isolation, set `DOCSLURP_PARSER_SANDBOX=none` (and
`DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true` in production). Setting the old
names has no effect.


The pre-URI variables `S3_BUCKET`, `AWS_ENDPOINT_URL_S3`, and `AWS_REGION` are
deprecated. They are honored only when `STORAGE_URI` is unset and are no longer
forwarded to the sandboxed vector-writer script. The superseded-purge variables
(`DOCSLURP_SUPERSEDED_PURGE_*`, `DOCSLURP_PURGE_SUPERSEDED_SOURCES`) were removed;
use `purgeSupersededSources=true` on `STORAGE_URI` instead.
