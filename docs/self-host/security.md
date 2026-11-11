# Security

What protects a self-hosted install: the parser sandbox, malware scanning, secrets and encryption keys, and network exposure. For how the pieces connect, see the [trust boundaries diagram](architecture.md#trust-boundaries).

## Parser sandbox

Production (`NODE_ENV=production`) requires the Modal provider with an explicit VM runtime. Local namespaces, containers and the unisolated development override do not qualify. Missing credentials, an unpinned image or a failed guest startup contract stop the worker; there is no local fallback. These requirements describe this source revision, not the state of an existing deployment.

The trusted API and worker coordinate storage, database operations and model calls. The parser VM receives only staged inputs and outputs. It has no database, storage, model-provider, authentication or encryption keys, no identity token or mounted volumes, and no network access. Registry pull credentials remain in the provider control plane. Each activity owns a separate VM session, terminated when the activity ends; commands have deadlines and bounded logs and file transfers.

Configure the worker (the API runs no parser and needs no VM credentials):

```dotenv
DOCSLURP_PARSER_SANDBOX=modal
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
DOCSLURP_MODAL_IMAGE=ghcr.io/docslurp/worker-full@sha256:<verified-digest>
DOCSLURP_PDF_ENGINE=off
PAGE_ROUTER_MODE=off
```

Build the parser runtime from the same source revision as the worker. It must contain `worker/scripts/parser-vm-contract.mjs`, image, PDF structure and quarantine entrypoints, and their compiled guest modules. Worker startup runs this contract in a VM. An older image fails startup. For a private registry, import the pinned image during deployment and provide the returned immutable IDs as `DOCSLURP_MODAL_IMAGE_ID`, together with the registry digest. Alternatively set `DOCSLURP_MODAL_REGISTRY_SECRET` to a provider-side registry pull secret; it is never attached to the guest environment. Verify image signatures as described below.

Command-line parsers, native image codecs, PDF.js structure extraction and ZIP/MIME quarantine inspection execute in the VM. The API never parses a PDF: intake estimates its page count from the size, and the worker replaces it with Doppler `pdfpagecount`, run in its boundary, before anything bills. The in-process native PDF binding, its page probe and local image decision sidecars are refused in production. Build the trusted worker without the native binding (`DOCSLURP_NATIVE_PDF=0`); shadow mode is also parsing and is refused.

Guest results remain untrusted. Host validation bounds outline depth, counts, page references and field types; image dimensions and encoded bytes; and archive fields. Generic transfers cap files at 128 MiB, aggregate output at 512 MiB, directory entries at 8,192 and path depth at 64. Oversized outputs fail rather than widening these limits.

### Development providers

Outside production, Linux defaults to bubblewrap and other platforms to `none`. These modes are for trusted development fixtures. Bubblewrap, landlock and seccomp can provide defense in depth inside a VM, but cannot replace the VM boundary for customer files. The unisolated override never permits production parsing.

### Trusted host processes

Vector writers receive backend credentials through a dedicated allowlist. They handle vectors and application projections, not source-file parsing. The local embedding pool handles text, not document or image codecs. Parser jobs never receive those credentials. [Parser sandbox providers](sandbox-providers.md) documents session teardown and development-provider details.

## Malware scanning

Production scans run `clamscan` inside the parser VM, using only named `main`, `daily` and `bytecode` signature assets staged from the trusted updater. Freshness comes from the guest scanner using those same definitions, rather than from an unrelated host database. The worker does not use a host daemon socket. Explicitly requiring a daemon makes this configuration refuse scanning.

At startup, `scripts/start-worker.sh` prepares ClamAV, updates signatures with `freshclam` and checks that `clamd` is ready when the daemon is required or managed. `DOCSLURP_CLAMAV_ENABLED=false` turns that startup step off (default `true`).

The scan policy comes from `resolveMalwareScanPolicy` in `worker/src/tools/runner.ts`:

| Variable | Default in production | Default otherwise | Meaning |
| --- | --- | --- | --- |
| `DOCSLURP_CLAMAV_REQUIRE_DAEMON` | `false` | `false` | Require `clamdscan`. If it is unavailable, the scan returns an error ("clamdscan is required but unavailable"). |
| `DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB` | `false` | `true` | When `false`, a stale or missing signature database blocks scanning. When `true`, it only produces a warning. |
| `DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS` | `24` | `24` | Age after which signatures count as stale. |
| `DOCSLURP_CLAMAV_DB_DIR` | `/var/lib/clamav` | `/var/lib/clamav` | Signature directory. |

Both scan paths apply the same limits (`worker/src/tools/clam-limits.ts`). libclamav's defaults skip files over 100 MB and report them clean. They also stop at a scan size, embedded-file count, nesting depth or scan time and report the remainder clean. DocSlurp raises the size limits above anything quarantine downloads (uploads default to 500 MiB) and sets `AlertExceedsMax`. Any limit that is still hit becomes a `Heuristics.Limits.Exceeded.*` detection, and quarantine refuses the file as `malware-scan-limit-exceeded` whatever the fail-open policy says.

Encrypted content gets the same treatment. libclamav cannot read a password-protected ZIP, RAR or 7z member or a PDF that needs a user password, and by default it skips the content and reports the file clean, even when the encrypted archive is nested inside a plain one. Both scan paths set `AlertEncryptedArchive` and `AlertEncryptedDoc` (`--alert-encrypted-archive=yes --alert-encrypted-doc=yes` for clamscan). Such files become `Heuristics.Encrypted.*` detections, and quarantine refuses them as `malware-scan-encrypted-content`, whatever the fail-open policy says: "file is encrypted or password-protected, so it cannot be scanned for malware; remove the password and upload again". A PDF with only an owner password (no password needed to open it) is decrypted and scanned, and is accepted when clean (ClamAV 1.4.3 scans its compressed streams after decryption but not its unfiltered ones; tracked in `TODO.md`). Two encrypted formats are not alerted on by ClamAV and are refused elsewhere instead: a password-protected Office file (an OLE container holding an `EncryptedPackage`) is refused by extraction, and RAR, which Debian's ClamAV cannot open at all (the unrar module is non-free), is not an accepted upload type, so RAR bytes under any declared type are refused as a MIME mismatch. The worker image applies the scan limits, `AlertExceedsMax` and both encryption options to `/etc/clamav/clamd.conf` (`worker/scripts/apply-clamd-policy.sh`; the distribution default stops at 25 MB and reports the rest clean).

A running clamd's options cannot be read by its client, so the worker never takes them on trust. Before it uses a local daemon (outside production, where `clamdscan` is preferred), it scans two generated canaries through it: a password-protected ZIP, which must be reported as `Heuristics.Encrypted.*`, and ZIPs nested deeper than the recursion limit, which must be reported as `Heuristics.Limits.Exceeded.*`. A daemon that reports either one clean is refused and logged (`[quarantine] status=clamd-policy-refused`); the scan then uses `clamscan` with the same options as command-line flags, or, when `clamscan` is unavailable or `DOCSLURP_CLAMAV_REQUIRE_DAEMON=true`, returns an error verdict, never clean or skipped. The result is cached per config file and signature version for `DOCSLURP_CLAMD_POLICY_TTL_MS` (default 300000) and checked again after any scan that could not reach the daemon. If you point `DOCSLURP_CLAMAV_CLAMD_CONF` at your own clamd config, run `apply-clamd-policy.sh` on the config that daemon starts with, or set the same options yourself. Scanner snapshot VMs run the same canaries before their snapshot is taken.

| Limit | Value | libclamav default |
| --- | --- | --- |
| File size | 1024 MiB | 100 MB |
| Scan size per file | 2000 MiB | 400 MB |
| Embedded files per file | 50,000 | 10,000 |
| Nesting depth | 17 | 17 |
| Scan time per file | 300 s | 120 s |

Measured with ClamAV 1.4.3 on 2 vCPU: a 510 MB file scans in 56–123 s at about 1.07 GB peak memory, most of it the loaded signatures. A synthetic 5,000-page PDF scans in about 106 s. A synthetic 20,000-page PDF exceeds the scan time limit and is refused as unscanned.

With the Modal parser sandbox, `DOCSLURP_QUARANTINE_SCAN_SNAPSHOT` moves the scan into VMs restored from a clean, signature-loaded snapshot. It is off by default, and a provider without scanner sessions keeps the per-command scan:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCSLURP_QUARANTINE_SCAN_SNAPSHOT` | `off` | Run each document's quarantine in its own scanner session, on VMs restored from a memory snapshot. clamd has already loaded the staged signatures in that snapshot, which is built before any job input exists. Freshness is read on the worker from the staged daily header. Any failed check is an error verdict. |
| `DOCSLURP_MODAL_SCANNER_REGIONS` | `us` | Region list for scanner snapshot VMs (memory snapshots of VM sandboxes need a region). Read only when the snapshot flag is on. |

Scanner sessions follow these rules:

- **One document per session.** The session's first command binds it to that document. A command of another document, of no document or of another organization is refused before it reaches a VM. clamd outlives each command, so a document that compromised it could otherwise answer for later documents.
- **Network blocked after restore.** Before a restored VM runs anything, a root check confirms it cannot connect to public addresses. Otherwise the VM is refused.
- **No per-VM secrets in the snapshot.** Every restored VM starts from the same memory, including userspace random-number state. The snapshot holds only the image, the signatures, the clamd config and the loaded daemon. Nothing that needs per-VM randomness, such as keys, tokens or nonces, may be added to it.
- **Platform-cost builds.** The snapshot build serves every organization, so its VM time is logged as platform cost (`[sandbox-usage] status=platform kind=scanner-build`). It is never charged to the organization whose scan triggered it. A failed build is not retried for 60 s, and scans in that window return an error verdict.

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
| `SECRETS_ENCRYPTION_KEY` | Project secrets stored at rest. It is also the first fallback root for file proxy URL tokens. |
| `METRICS_SECRET` | Access to the metrics endpoint. |

### Rotate AES-GCM at-rest keys

This procedure covers `SECRETS_ENCRYPTION_KEY` (project secrets, webhook signing secrets, organization SSO client secrets) and `CREDENTIALS_ENCRYPTION_KEY` (project connectors and user MCP service credentials). It does **not** rotate PostgreSQL PGP encryption, including `OAUTH_TOKEN_ENCRYPTION_KEY` or search history. Back up the database and keys first; protect those backups as secrets.

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
