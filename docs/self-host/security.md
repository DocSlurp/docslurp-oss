# Security

What protects a self-hosted install: the parser sandbox, malware scanning, secrets and encryption keys, and network exposure. For how the pieces connect, see the [trust boundaries diagram](architecture.md#trust-boundaries).

## Parser sandbox

Document parsers run untrusted input. The worker starts each parser through a sandbox provider: `bubblewrap` (the default on Linux), `landlock`, `modal` or `none`. [Parser sandbox providers](sandbox-providers.md) compares them and covers setup. What each isolates:

| Provider | Filesystem | Network | Processes |
| --- | --- | --- | --- |
| `bubblewrap` | Read-only runtime paths, private scratch | Blocked | Separate PID, IPC and UTS namespaces |
| `landlock` | Landlock rules: read-only runtime paths and inputs, writes only to scratch and declared outputs | TCP connect and bind denied. Runs only on kernels with Landlock ABI v9 (landrun v0.1.17); on older kernels the probe fails and the worker does not start | Not isolated |
| `modal` | Separate remote sandbox, files staged in and out per command | Blocked | Separate remote sandbox |
| `none` | Not isolated | Not isolated | Not isolated |

In all cases the parser gets an allowlisted environment and none of the worker's secrets.

### Bubblewrap

The default provider runs `worker/scripts/parser-sandbox.sh`, which wraps the parser in bubblewrap (`bwrap`). What it does:

- **Unshares** the network, PID, IPC and UTS namespaces (`--unshare-net`, `--unshare-pid`, `--unshare-ipc`, `--unshare-uts`). The parser has no network.
- **Drops all capabilities** (`--cap-drop ALL`), starts a new session, and dies with its parent.
- **Mounts a fresh `/proc`** and `/dev`, and an empty `/tmp`.
- **Binds read-only** only the runtime paths it needs: `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, and a few files under `/etc` (`ld.so.cache`, `fonts`, `ssl`, `localtime`, `passwd`, `group`, ImageMagick config) plus `/var/cache/fontconfig`, where they exist. The worker adds the input files and any unpacked vendor bundles through `DOCSLURP_PARSER_SANDBOX_READABLE_PATHS`, also read-only. The application checkout, other jobs and worker credentials are not mounted.
- **Binds writable** only the per-run scratch directory and the paths the worker lists in `DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS`. The script refuses any writable path that is not under `/tmp/docslurp-*` or `<host temp root>/docslurp-*`, and any path with `..` in it. It exits with code 70 (`refusing broad writable mount` or `refusing traversal in writable mount`) rather than mounting more.
- **Rewrites** `HOME`, `TMPDIR`, `TMP`, `TEMP` and the `XDG_*` directories to a private per-run directory, which is deleted when the command exits.
- **Passes a small environment**. Only these variables reach a parser, when set: `LANG`, `LC_ALL`, `LC_CTYPE`, `PATH`, `SSL_CERT_DIR`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `OPENSSL_CONF`, `PYTHON_VENV`, `TMP`, `TMPDIR`, `TEMP` and `TZ` (`defaultParserEnvAllowlist` in `worker/src/tools/process-env.ts`). Add more names, comma-separated, with `DOCSLURP_PARSER_ENV_ALLOWLIST`. Database, storage, auth and AI keys are not on the list.

If `bwrap` is missing, the launcher exits with code 70 and `refusing to run parser without isolation`. It never falls back to running the parser unsandboxed.

### Choosing and enforcing a provider

The sandbox provider is chosen with `DOCSLURP_PARSER_SANDBOX` (`bubblewrap`, `landlock`, `modal` or `none`). Unset, it is `bubblewrap` on Linux and `none` on macOS outside production. The worker probes the provider at startup and refuses to start if isolation is unavailable. With `NODE_ENV=production` it also requires filesystem isolation and at least `tcp-only` network isolation. Provider `none` runs parsers directly on the host and is accepted in production only with `DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED=true`, which logs `[parser-sandbox] status=unisolated` on every start. Startup logs one line, `[parser-sandbox] provider=<id> filesystem=<bool> network=<level> processes=<bool> location=<local|remote>`. Each Temporal activity gets its own sandbox session, closed when the activity ends (`worker/src/sandbox/`).

### Why Compose sets `systempaths=unconfined`

This applies to the default `bubblewrap` provider. The worker services in `compose.selfhost.yml` set `systempaths=unconfined` so bubblewrap can mount a fresh `/proc`. Docker masks some `/proc` paths by default, and that blocks the mount. The worker keeps `cap_drop: [ALL]`, `no-new-privileges:true`, a pids limit of 256 and the seccomp profile `worker/security/seccomp-doc-extract.json`. The parser still runs inside the bubblewrap namespaces.

### The error you see without it

At startup, `scripts/start-worker.sh` runs `scripts/check-worker-prerequisites.mjs` with `--sandbox`. It probes the selected provider, then runs the installed `ffprobe`, `ffmpeg`, `pdftoppm` and `pandoc` inside it (local providers only). If that fails, the worker prints a line like this and exits without starting:

```text
[worker-prerequisites] parser isolation unavailable: <reason from the provider>
```

Common causes for bubblewrap are a host that forbids unprivileged user namespaces or mounts (sysctl or AppArmor), or removing `systempaths=unconfined` from the Compose file. See [Requirements](requirements.md#host-requirements) and the per-provider rows in [Operations](operations.md#troubleshooting). The output ends with `status=failed`.

### Commands that skip the sandbox

Three kinds of code do not go through a sandbox provider:

- **In-process Node parsers** (Kreuzberg and LiteParse). They run inside the worker process, so no provider sandboxes them, and they share the worker's environment. Treat the worker as the trust boundary for these.
- **The vector writer** (`vector_backend_write.py` and `orama_write.mjs`). It has to reach object storage, and the sandbox has no network. It is not sandboxed by any provider. It receives the vector backend URIs (`LANCEDB_URI`, `STORAGE_URI`, `CHROMA_PATH`, `CHROMA_URL`, `MILVUS_URI`, `ORAMA_PATH`) and AWS credentials including `AWS_SESSION_TOKEN`, and nothing else beyond the default allowlist. Only these two trusted scripts get that list; an input filename cannot ask for it (`isVectorBackendCommand` in `worker/src/tools/runner.ts`).
- **The embedding pool**. It is a long-lived Python process started by the worker (`getEmbedPool` in the same file) rather than a per-call command. It has its own environment allowlist (`defaultPythonPoolEnvAllowlist`, extended with `DOCSLURP_PYTHON_POOL_ENV_ALLOWLIST`). It handles text to embed, not file parsing.

## Malware scanning

The worker scans files with ClamAV. At startup, `scripts/start-worker.sh` prepares ClamAV, updates signatures with `freshclam` and checks that `clamd` is ready when the daemon is required or managed. `DOCSLURP_CLAMAV_ENABLED=false` turns that startup step off (default `true`).

The scan policy comes from `resolveMalwareScanPolicy` in `worker/src/tools/runner.ts`:

| Variable | Default in production | Default otherwise | Meaning |
| --- | --- | --- | --- |
| `DOCSLURP_CLAMAV_REQUIRE_DAEMON` | `true` | `false` | Require `clamdscan`. If it is unavailable, the scan returns an error ("clamdscan is required but unavailable"). |
| `DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB` | `false` | `true` | When `false`, a stale or missing signature database blocks scanning. When `true`, it only produces a warning. |
| `DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS` | `24` | `24` | Age after which signatures count as stale. |
| `DOCSLURP_CLAMAV_DB_DIR` | `/var/lib/clamav` | `/var/lib/clamav` | Signature directory. |

"Production" means `NODE_ENV=production`, which the Compose stack sets. If no scan engine is available at all and the daemon is not required, the scan result is `skipped-unavailable`.

## Secrets and encryption keys

`node scripts/selfhost-init.mjs` generates distinct random values and writes them to `.env.selfhost`, which Git ignores. Back this file up somewhere private. Losing the encryption keys makes stored data unreadable. Use the procedure below when changing AES-GCM keys.

| Variable | What it protects |
| --- | --- |
| `POSTGRES_PASSWORD`, `DATABASE_URL` | The database. Keep the password in `DATABASE_URL` in step with `POSTGRES_PASSWORD`. Postgres reads the password only when its volume is created, so editing the file does not change an existing database. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Object storage. In this stack they are also the MinIO root user and password. |
| `BETTER_AUTH_SECRET` | Better Auth, the sign-in layer. It is also the last fallback root for file proxy URL tokens. |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | OAuth tokens persisted in `oauth_accounts`. |
| `CREDENTIALS_ENCRYPTION_KEY` | Connector credentials. |
| `SECRETS_ENCRYPTION_KEY` | Workspace secrets stored at rest. It is also the first fallback root for file proxy URL tokens. |
| `METRICS_SECRET` | Access to the metrics endpoint. |

### Rotate AES-GCM at-rest keys

This procedure covers `SECRETS_ENCRYPTION_KEY` (workspace secrets, webhook signing secrets, organization SSO client secrets) and `CREDENTIALS_ENCRYPTION_KEY` (workspace connectors and user MCP service credentials). It does **not** rotate PostgreSQL PGP encryption, including `OAUTH_TOKEN_ENCRYPTION_KEY` or search history. Back up the database and keys first; protect those backups as secrets.

1. Use a maintenance window for the initial envelope upgrade: stop API and worker processes, deploy code supporting `v2:<key-id>:<iv>:<tag>:<ciphertext>` everywhere, then restart with the existing key and ID. New code immediately writes v2, so do not mix old readers with new writers. Existing `v1` and unversioned AES-GCM rows remain readable. Keep the current key and ID unchanged during this rollout.
2. For each key being replaced, generate a random 32-byte hex key (`openssl rand -hex 32`), set `<ENV_NAME>_ID` to a new unique ID, and put the previous key in `<ENV_NAME>_PREVIOUS_KEYS`, a JSON object such as `{"default":"<previous 64 hex characters>"}`. Old deployments without an explicit ID used `default`. IDs permit letters, digits, `_` and `-`, up to 64 characters. Never reuse an ID for different key material. Keyrings accept at most 16 old keys; use real 32-byte hex/base64 values even outside production. If the old development key was a passphrase, supply its SHA-256 digest as the legacy key.
3. Restart **all** API and worker processes with the same current key and keyring. New writes now use the new ID; old keys are read-only. Do not let old writers continue during retirement.
4. From the core root, run `pnpm --filter @docslurp/server exec tsx scripts/rotate-at-rest-secrets.ts --dry-run --limit=100`. Dry-run decrypts candidates without updating rows. Logs contain counts only. Then run the same command with `--apply`. Each invocation visits at most the limit per store (default 100, maximum 10000); rerun until every store reports zero candidates. Failed decryptions stop the run; preserve all old keys and investigate. Applied rows remain safely resumable. Concurrent changes are skipped using compare-and-update and reported as conflicts; rerun for those rows. Legacy plaintext webhook and SSO secrets are encrypted too. Empty credential fields are skipped.
5. Verify normal reads and take a fresh backup, then remove old keys from every process only after all stores report zero candidates and all writers use the new ID. Retain old keys securely for any database backups that still need them. Counts describe the bounded candidate pass, not a full integrity scan of already-current rows. The command does not rotate the underlying provider/webhook credentials.

Set `FILE_TOKEN_SECRET` independently before rotating `SECRETS_ENCRYPTION_KEY` if existing short-lived file capability URLs must remain usable. Without it, file URL signing falls back to the secrets key (then Better Auth secret), and changing that root invalidates outstanding URLs. The AES-GCM keyring does not preserve those signing tokens. Search capability tokens use the same fallback root and also require reissuance when it changes. Set `SEARCH_QUERY_ENCRYPTION_KEY` to the **old** secrets-key value before changing that root if search-history PGP encryption previously used its fallback; restart all writers with that explicit value. The rotation command does not migrate search-history PGP ciphertext.

`OAUTH_TOKEN_ENCRYPTION_KEY` protects separate PostgreSQL PGP ciphertext and has no rotation command here; preserve that key until a separate migration is implemented.

Provider keys (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) and OAuth client secrets are optional and live in the same file. See [Configuration](configuration.md).

## Verifying worker images

`.github/workflows/worker-images.yml` publishes `ghcr.io/docslurp/worker-lean` and `ghcr.io/docslurp/worker-full` on each release tag. Every pushed image index carries:

- BuildKit SLSA provenance in `mode=max` (sources, build arguments and materials) and an SPDX SBOM, as attestation manifests in the index.
- A keyless cosign signature on the image digest. The Fulcio certificate names this repository's `worker-images.yml` workflow and the ref it ran on, and the signature is logged in the public Rekor transparency log.
- A GitHub build provenance attestation for the same digest, also pushed to the registry.

Tags such as `1.2.3` are mutable. Resolve the tag to a digest once, verify that digest, then run only the digest. The workflow run summary lists each pushed digest, or resolve it yourself:

```sh
docker buildx imagetools inspect ghcr.io/docslurp/worker-full:1.2.3 --format '{{.Manifest.Digest}}'
```

Verify the signature with cosign 3 or later. The identity must be this repository's workflow on a release tag or on `main` (manual republish); a signature from any other workflow, repository or branch fails:

```sh
cosign verify ghcr.io/docslurp/worker-full@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/DocSlurp/docslurp-oss/\.github/workflows/worker-images\.yml@refs/(tags/v[0-9].*|heads/main)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

For one release, pin the identity exactly with `--certificate-identity https://github.com/DocSlurp/docslurp-oss/.github/workflows/worker-images.yml@refs/tags/v1.2.3`.

Check the GitHub provenance attestation and read the SBOM and BuildKit provenance:

```sh
gh attestation verify oci://ghcr.io/docslurp/worker-full@sha256:<digest> --repo DocSlurp/docslurp-oss
docker buildx imagetools inspect ghcr.io/docslurp/worker-full@sha256:<digest> --format '{{json .SBOM}}'
docker buildx imagetools inspect ghcr.io/docslurp/worker-full@sha256:<digest> --format '{{json .Provenance}}'
```

Then run the digest, not the tag. For the Modal parser sandbox, set `DOCSLURP_MODAL_IMAGE_DIGEST=sha256:<digest>` to pin the default `worker-full` release image, or set `DOCSLURP_MODAL_IMAGE=ghcr.io/docslurp/worker-full@sha256:<digest>` ([Parser sandbox providers](sandbox-providers.md#modal)). Elsewhere, reference `ghcr.io/docslurp/worker-<profile>@sha256:<digest>` in your deployment.

Inside the images, the worker's Python dependencies are installed with `pip`/`uv --require-hashes` from lock files that record a sha256 for every artifact (`worker/requirements*.lock.txt`, regenerated with `uv pip compile --generate-hashes`; the command is at the top of each file). CI rejects a lock without hashes and fails on critical vulnerabilities in the worker's source SBOM; the only accepted exceptions are listed, with reasons, in `.grype.yaml`.

## Network exposure

The Compose file publishes only the server, on `${SERVER_BIND_ADDRESS:-127.0.0.1}:${SERVER_PORT:-8787}`. Do not publish the Postgres, Redis, MinIO or Temporal ports, and do not add `ports:` entries for them. None of them is meant to face the internet or an untrusted network. If you run a reverse proxy on another host, bind the server to an address that only your private network can reach and firewall the port.

For TLS, a reverse proxy, forwarded headers and client IP handling, see [Public access](public-access.md).
