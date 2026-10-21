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

**Separate index store** — set `LANCEDB_STORAGE_URI` (same shape as
`STORAGE_URI`, with its own credentials) to keep the index on a different store
than blobs, for example blobs on Backblaze B2 (which rejects conditional
`PutObject`, so Lance cannot commit there) and the index on Tigris or S3. When
`LANCEDB_URI` is unset the root is `s3://<that bucket>/lancedb`. Unset, the
index inherits `STORAGE_URI` as before.

**Client tuning** — all optional; unset keeps AWS SDK and Lance defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `S3_MAX_SOCKETS` | SDK (50) | Max concurrent sockets per host. |
| `S3_KEEPALIVE` / `S3_KEEPALIVE_INITIAL_DELAY_MS` | SDK (on) | TCP keepalive. |
| `S3_CONNECTION_TIMEOUT_MS` / `S3_REQUEST_TIMEOUT_MS` / `S3_SOCKET_TIMEOUT_MS` | SDK | Connect, request and idle-socket timeouts. |
| `S3_MAX_ATTEMPTS` / `S3_RETRY_MODE` | SDK (3, `standard`) | Retries; mode `standard` or `adaptive`. |
| `S3_CHECKSUM_MODE` | SDK | `when_supported` or `when_required`; sets request and response checksum handling. Providers such as B2 and R2 often need `when_required`. |
| `S3_FORCE_PATH_STYLE` | `STORAGE_URI` `pathStyle` | Overrides path-style addressing. |
| `S3_MULTIPART_PART_SIZE_MB` | `8` | Part size for streamed server uploads (5-5120). |
| `LANCEDB_CONNECT_TIMEOUT_SECONDS`, `LANCEDB_REQUEST_TIMEOUT_SECONDS`, `LANCEDB_CLIENT_MAX_RETRIES`, `LANCEDB_POOL_MAX_IDLE_PER_HOST` | Lance | Lance object-store options (`connect_timeout`, `timeout`, `client_max_retries`, `pool_max_idle_per_host`) for `s3://` roots. |
| `LANCEDB_S3_CACHE_DIR`, `LANCEDB_S3_CACHE_MAX_GB` (10), `LANCEDB_S3_CACHE_BLOCK_KB` (1024) | off | Read-through disk cache for Lance's immutable `data/` and `_indices/` files on `s3://` roots; see [Local disk cache for LanceDB](operations.md#local-disk-cache-for-lancedb). |

**Search cache, prewarm and freshness** — the server shares one LanceDB `Session`
across its connections and loads the vector (and full-text) indexes into it when a
table opens. The worker shares one `Session` per process but does not prewarm: it is
a different process from the server, so warming there would not fill the cache that
answers searches. Instead the server re-prewarms open tables every
`LANCEDB_PREWARM_REFRESH_SECONDS` to pick up indexes the worker rebuilt.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LANCEDB_INDEX_CACHE_MB` | 25% of usable memory, 64 MB to 6 GB | Index cache size. LanceDB's own default is a fixed 6 GB. Usable memory is the container limit when one is set. |
| `LANCEDB_METADATA_CACHE_MB` | 5% of usable memory, 32 MB to 1 GB | File footer and schema cache size. LanceDB's own default is a fixed 1 GB. |
| `LANCEDB_PREWARM_INDEX` | `false` | Prewarm vector and FTS indexes when a table opens. Off by default: on MinIO with injected 40 ms latency it did not measurably change search latency (`server/scripts/lancedb-session-bench.ts`). Failures are logged (`[lancedb-session] prewarm ... errors=`), never thrown. |
| `LANCEDB_PREWARM_BLOCKING` | `false` | `true` makes the first search wait for the prewarm. Off, the first searches run while it loads. |
| `LANCEDB_PREWARM_REFRESH_SECONDS` | `60` | With `LANCEDB_PREWARM_INDEX=true`, re-prewarm open tables this often. `0` disables. |
| `LANCEDB_PREWARM_DATA` | `false` | Also load the `vector`, `id` and `documentId` columns, so refine and `documentId` filters read memory. Costs RAM of that size. |
| `LANCEDB_READ_CONSISTENCY_SECONDS` | `30` | How often an open table checks for a new version. Higher means fewer manifest reads, but new rows take that long to become searchable. While documents are being ingested, a longer interval avoids re-reading each new unindexed fragment (see the benchmark in the PR). `0` checks on every query. |

The server logs `[lancedb-session] created ...` at startup with the configured sizes.

Use a shared `s3://` root whenever the server and worker run in separate containers
or machines. Log URIs only after redaction because `STORAGE_URI` may hold a
secret.

## Database pool and health checks

The API process keeps one postgres.js pool for requests, plus one LISTEN
connection and one probe connection that answers only health checks. The
probe never queues behind requests, so search load cannot fail `/ready` or
trip the watchdog.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | `20` | Request pool connections per API process. Budget `DATABASE_POOL_MAX + 12` per process against Postgres `max_connections` (LISTEN, the probe and Better Auth's own pool of 10), and double it for deploys that overlap old and new machines. |
| `SEARCH_STATEMENT_TIMEOUT_MS` | `8000` | `SET LOCAL statement_timeout` for each search statement (lexical, page, community and graph branches). A timed-out branch contributes no results and the search continues with the others; `0` disables. Search SQL is also cancelled when the client disconnects. |
| `CHAT_AGENT_TURN_DEADLINE_MS` | `100000` | Deadline for one search-agent chat turn, kept below the ~120 s edge proxy timeout. Near it, tools are disabled and the turn answers from the evidence it has (`stopReason: "deadline"`, HTTP 200); with no answer text at all it returns 504 `chat_deadline_exceeded`. All model, tool, search and SQL work of the turn is cancelled at it. |
| `CHAT_AGENT_STEP_TIMEOUT_MS` | `45000` | Longest model call for a tool-calling agent step (capped to end before the final reserve). |
| `CHAT_AGENT_TOOL_TIMEOUT_MS` | `30000` | Longest agent tool call (capped to end before the final reserve); a slower tool is cancelled and the model gets a `tool_timeout` result. |
| `CHAT_AGENT_FINAL_RESERVE_MS` | `20000` | Part of the turn deadline kept for the final answer, at most half of it. |
| `SEARCH_LEXICAL_CANDIDATES` | `1000` | Keyword matches ranked per lexical statement. Broader queries rank the first N matches; only the top results fetch their text. |
| `SEARCH_MAX_CONCURRENCY` | `max(2, DATABASE_POOL_MAX / 3)` (6) | Concurrent hybrid searches per process. Extra searches wait in the app instead of the pool. `0` disables the limit. Nested searches (decompose, stepback, multi-hop) share their parent's slot. |
| `SEARCH_QUEUE_MAX` | `200` | Searches allowed to wait for a slot; beyond it a search fails at once with 503. |
| `SEARCH_QUEUE_TIMEOUT_MS` | `30000` | Longest wait for a slot before a 503 with `Retry-After`. The wait appears as `queueMs` in search timings. |
| `SEARCH_FAIR_ADMISSION` | with `SEARCH_LANCEDB_NATIVE` | Serve waiting searches round-robin per organization, so one tenant's fan-out cannot starve another. Off (the default while `SEARCH_LANCEDB_NATIVE` is off, including per-workspace trials), the queue is one FIFO. |
| `SEARCH_MAX_SLOTS_PER_TURN` | `2` with fair admission, else `0` | Slots one chat agent turn or one batch request (`queries`) holds at once; its other searches wait. `0` removes the per-turn cap. |
| `SEARCH_LANCEDB_NATIVE` | off | Serve keyword (BM25), vector and citation hydration from LanceDB instead of Postgres: the LanceDB table's full-text index replaces Postgres FTS, the row's hydration columns replace the `document_chunks` read, and the eligible-document set and coverage are cached per workspace. Needs `LANCEDB_FTS_INDEX=1` on workers, or the backfill below, for keyword search; tables without an FTS index keep using Postgres FTS, as do queries with "quoted phrases" or `-negation` (the BM25 index honours neither). Batch searches (`queries`) of native workspaces embed their queries in one provider request. |
| `SEARCH_LANCEDB_NATIVE_WORKSPACES` | empty | Comma-separated workspace ids that use native search while `SEARCH_LANCEDB_NATIVE` is off. |
| `SEARCH_ELIGIBLE_CACHE_TTL_MS` | `15000` | Native search: how long a workspace's eligible documents and coverage are cached. Worker `run_events` hints drop a workspace's entries sooner. |
| `SEARCH_SESSION_WRITE_BEHIND` | with `SEARCH_LANCEDB_NATIVE` | Write search sessions, result ranks, usage and zero-result diagnostics after the response. Writes for one session stay ordered; `GET /v1/search/diagnostics` waits for them. |
| `SEARCH_WRITE_BEHIND_CONCURRENCY` | `2` | Background search writes running at once. |
| `SEARCH_WRITE_BEHIND_MAX_PENDING` | `200` | Background search writes allowed to wait for a slot. Past it a search waits for its own writes, so the backlog (usage a crash could lose, spend budgets cannot see yet) stays bounded. The standalone server drains the backlog on `SIGTERM`. |
| `LANCEDB_FTS_INDEX` | off | Worker: LanceDB maintenance also builds and refreshes a full-text index on chunk text, which native search queries. Existing tables: run `worker/scripts/lancedb-native-backfill.ts --workspace <id>` (adds the hydration columns, fills them from Postgres, builds the index and optimizes the table so the rewritten rows return to the vector index; no re-embedding). It is idempotent and safe beside ingest, but it rewrites rows in the org's shared table: run it off-peak and do not pass `--skip-optimize` unless maintenance will optimize the table soon after. |
| `DB_WATCHDOG_INTERVAL_MS` | `15000` | How often the production watchdog probes. |
| `DB_WATCHDOG_TIMEOUT_MS` | `5000` | Timeout of one probe. |
| `DB_WATCHDOG_EXIT_AFTER_MS` | `60000` | Exit (and let the platform restart the machine) after the probe connection has failed this long. `0` disables the watchdog. |
| `DB_WATCHDOG_POOL_STALL_MS` | `60000` | Also exit when the request pool has had queries in flight with none completing this long, the database answers the probe and `pg_stat_activity` shows none of the pool's queries running (connections that died silently). A saturated pool keeps completing queries and never trips it. `0` disables this check. |

`/ready` runs its `database` and `migrations` checks on the probe connection;
the `database` detail reports the pool's in-flight queries and the search
queue, so overload is visible without failing readiness.

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
| `DOCSLURP_MODAL_APP`, `DOCSLURP_MODAL_IMAGE`, `DOCSLURP_MODAL_REGISTRY_SECRET`, `DOCSLURP_MODAL_CPU`, `DOCSLURP_MODAL_MEMORY_MB`, `DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS` | `docslurp-parsers`, `ghcr.io/docslurp/worker-full:<DOCSLURP_VERSION>` (required when `DOCSLURP_VERSION` is unset), unset, `2`, `4096`, `900` | Modal sandbox settings. |
| `DOCSLURP_VERSION` | set by release worker images; unset in source installs | Release version the image was built from. Picks the default Modal image. |

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
