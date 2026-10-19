# Docker Compose install

This is the single-host Docker Compose install. It runs the API server, one lean
worker, Postgres with pgvector, Redis, MinIO, and Temporal. Postgres and MinIO
use named Docker volumes. Only the server binds a host port, on localhost by
default. This setup is suitable for a small private installation or a server
behind a TLS reverse proxy; it is not a multi-host or high-availability design.

Every command on this page runs from the repository root.

## Requirements

- A Linux host with Docker Engine and Compose v2. Docker Desktop is untested. You need enough disk for document artifacts and images.
- At least 8 GB of RAM for the lean worker; the optional full worker needs more
  memory and disk for OCR, LibreOffice, and Python models. See
  [sizing](requirements.md#sizing) for what has and has not been measured.
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

The server takes about 15 seconds to start. Wait until `ps` shows it as `healthy`, then run the `--running` check. Run early, it fails with `Server health check failed: fetch failed`.

Check <http://localhost:8787/health>. There is no bundled web UI: use the REST API, CLI, SDK or MCP. The first build and first
worker start can take several minutes. No seeded developer accounts are created
in this production-mode stack. API routes are available under `/v1`.

The generated `.env.selfhost` contains distinct random values for database,
storage, auth, encryption, and metrics. It is ignored by Git. Store a secure
backup of it: changing encryption keys later can make stored credentials and
secrets unreadable. The [template](../../.env.selfhost.example) lists every
first-run option; see [Configuration](configuration.md) for what each one does.

The worker containers run with `systempaths=unconfined` so the parser sandbox (bubblewrap) can mount a fresh `/proc`; all capabilities remain dropped and the seccomp profile still applies. Without it the worker reports `parser isolation unavailable` and refuses to start. See [Parser sandbox](security.md#parser-sandbox).

To view status or logs:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml ps --all
docker compose --env-file .env.selfhost -f compose.selfhost.yml logs -f server worker
```

## Switch to the full worker

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
bundles](../worker-image.md) for sizes, flags and building bundles yourself. To switch back, run the original
`up -d` command, then stop `worker-full`:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml --profile full stop worker-full
```

## Stop

Stop containers without deleting the named volumes:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml down
```

Do not add `--volumes` unless you intend to remove the stored database and
artifacts.
