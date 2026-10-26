# Dockerfile.lean - Production worker image (fly.worker.toml)
#
# Contents: Node 24 + the worker's production node_modules (pnpm deploy, pruned),
# poppler-utils (with poppler-data CMaps), Tesseract (21 languages, ~107 MiB), pandoc, ffmpeg, ClamAV, bubblewrap, and a wheel-only Python venv
# with the base parsers (trafilatura, ebooklib, python-pptx,
# openpyxl, xlsx2csv, Pillow; PDFs use Kreuzberg, Poppler and the optional native-pdf engine). No LibreOffice or ML stacks: Docling and
# Unstructured come from sha256-pinned vendor bundles fetched on demand
# (worker/vendor-bundles.json, docs/worker-image.md). Runtime pip installs are off.
#
# Every build stage starts from the same pinned base so the venv (which links
# /usr/bin/python3) and native addons match the runtime stage exactly.

# Build stage: compile TypeScript, then produce a self-contained production
# node_modules for the worker only (no pnpm store, no workspace-root deps).
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS builder
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
COPY worker/package.json worker/tsconfig.json worker/LICENSE ./worker/
RUN \
    pnpm install --frozen-lockfile
COPY worker/src ./worker/src
COPY worker/scripts/copy-routing-assets.mjs ./worker/scripts/copy-routing-assets.mjs
COPY scripts/lib/model-prices.json ./scripts/lib/model-prices.json
RUN pnpm --filter @docslurp/worker build
COPY scripts/prune-worker-node-modules.mjs ./scripts/prune-worker-node-modules.mjs
RUN \
    pnpm --filter @docslurp/worker deploy --prod --legacy /prod/worker \
    && node scripts/prune-worker-node-modules.mjs --dir /prod/worker --arch "$(node -p process.arch)"

# Base Python parsers: wheel-only venv built against the runtime image's python3.
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS python-venv
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY worker/requirements-base.txt worker/requirements-base.lock.txt /tmp/req/
COPY scripts/build-worker-venv.sh /tmp/build-worker-venv.sh
RUN bash /tmp/build-worker-venv.sh /app/.venv /tmp/req/requirements-base.lock.txt /tmp/req/requirements-base.txt

# Optional private native PDF engine: pinned by vendor-artifacts/native-pdf/manifest.json,
# tarball supplied in the build context (gitignored). Absent tarball = no-op (Kreuzberg path).
# DOCSLURP_NATIVE_PDF=1 requires it (missing or unloadable binding fails the build).
# Installed in its own stage so the tarball itself never lands in an image layer.
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS native-pdf
ARG DOCSLURP_NATIVE_PDF=
WORKDIR /app
COPY scripts/install-native-pdf.mjs ./scripts/install-native-pdf.mjs
COPY vendor-artifact[s]/native-pdf/ ./vendor-artifacts/native-pdf/
RUN mkdir -p vendor-artifacts/native-pdf \
    && node scripts/install-native-pdf.mjs --optional \
    && rm -f vendor-artifacts/native-pdf/*.tgz

# Optional native-pdf runtime assets, default off. With neither flag set this stage
# leaves /opt/native-pdf empty, so the default image does not grow. Sources and
# every file are sha256-pinned in scripts/fetch-native-pdf-assets.mjs.
#   DOCSLURP_NATIVE_PDF_OCR_MODELS=1  PP-OCRv6 small OCR models (~30 MB, Apache-2.0)
#   DOCSLURP_NATIVE_PDF_CJK_FONTS=1   Noto CJK fallback fonts (~54 MB, OFL-1.1)
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS native-pdf-assets
ARG DOCSLURP_NATIVE_PDF_OCR_MODELS=
ARG DOCSLURP_NATIVE_PDF_CJK_FONTS=
COPY scripts/fetch-native-pdf-assets.mjs /tmp/fetch-native-pdf-assets.mjs
RUN node /tmp/fetch-native-pdf-assets.mjs --out /opt/native-pdf \
      --ocr-models="${DOCSLURP_NATIVE_PDF_OCR_MODELS}" --cjk-fonts="${DOCSLURP_NATIVE_PDF_CJK_FONTS}"

# landrun (Landlock sandbox provider, MIT, pinned by worker/sandbox-tools.json). Downloaded for
# TARGETARCH and sha256-verified. The release binary is dynamically linked and needs glibc >= 2.38:
# it runs on Debian trixie (this base image) but fails on bookworm, so do not downgrade the base.
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS landrun
ARG TARGETARCH=amd64
COPY worker/sandbox-tools.json /tmp/sandbox-tools.json
RUN node -e ' \
      const fs = require("node:fs"); const crypto = require("node:crypto"); \
      const tool = JSON.parse(fs.readFileSync("/tmp/sandbox-tools.json", "utf8")).landrun["linux-" + process.argv[1]]; \
      if (!tool) throw new Error("no pinned landrun for arch " + process.argv[1]); \
      fetch(tool.url).then((r) => { if (!r.ok) throw new Error("landrun download failed: " + r.status); return r.arrayBuffer(); }).then((buf) => { \
        const data = Buffer.from(buf); \
        const sum = crypto.createHash("sha256").update(data).digest("hex"); \
        if (sum !== tool.sha256) throw new Error("landrun sha256 mismatch: " + sum); \
        fs.writeFileSync("/usr/local/bin/landrun", data, { mode: 0o755 }); \
      }).catch((e) => { console.error(e.message); process.exit(1); });' "${TARGETARCH}" \
    && /usr/local/bin/landrun --version

# Production stage: runtime only (no TypeScript toolchain, pnpm store or devDeps)
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
WORKDIR /app

# System dependencies first: they change least often, so this layer is reused.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       bash \
       bubblewrap \
       ca-certificates \
       clamav \
       clamav-daemon \
       clamdscan \
       ffmpeg \
       fonts-droid-fallback \
       fonts-liberation \
       fonts-noto-core \
       fonts-urw-base35 \
       pandoc \
       poppler-data \
       poppler-utils \
       python3 \
       tesseract-ocr \
       tesseract-ocr-eng \
       tesseract-ocr-fra \
       tesseract-ocr-deu \
       tesseract-ocr-spa \
       tesseract-ocr-ara \
       tesseract-ocr-chi-sim \
       tesseract-ocr-chi-tra \
       tesseract-ocr-ell \
       tesseract-ocr-heb \
       tesseract-ocr-hin \
       tesseract-ocr-ita \
       tesseract-ocr-jpn \
       tesseract-ocr-kor \
       tesseract-ocr-nld \
       tesseract-ocr-pol \
       tesseract-ocr-por \
       tesseract-ocr-rus \
       tesseract-ocr-tha \
       tesseract-ocr-tur \
       tesseract-ocr-ukr \
       tesseract-ocr-vie \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/* \
    && rm -rf /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

RUN groupadd --system --gid 10001 docslurp \
    && useradd --system --uid 10001 --gid docslurp --home-dir /home/docslurp --create-home --shell /usr/sbin/nologin docslurp \
    && usermod -a -G clamav docslurp \
    && sed -ri 's/^#?User .*/User docslurp/' /etc/clamav/clamd.conf \
    && sed -ri 's|^#?LocalSocket .*|LocalSocket /tmp/clamav/clamd.ctl|' /etc/clamav/clamd.conf \
    && sed -ri 's/^#?LocalSocketGroup .*/LocalSocketGroup docslurp/' /etc/clamav/clamd.conf \
    && sed -ri 's|^#?PidFile .*|PidFile /tmp/clamav/clamd.pid|' /etc/clamav/clamd.conf \
    && sed -ri 's/^#?DatabaseOwner .*/DatabaseOwner docslurp/' /etc/clamav/freshclam.conf \
    && mkdir -p /tmp/docslurp-parser-sandbox /tmp/clamav /var/log/clamav /var/lib/clamav /home/docslurp/.cache/docslurp/vendor-bundles \
    && chown -R docslurp:docslurp /home/docslurp /tmp/docslurp-parser-sandbox /tmp/clamav /var/log/clamav /var/lib/clamav

# One clamd per machine serves all 8 slots. Without concurrent reloads clamd
# briefly pauses scans on signature reload instead of doubling its ~1.2 GB RSS.
# DOCSLURP_BAKE_CLAMAV_SIGNATURES=true downloads signatures once per image
# build, so 125 starting machines do not each hit the ClamAV CDN.
ARG DOCSLURP_BAKE_CLAMAV_SIGNATURES=false
RUN if grep -q '^#\?ConcurrentDatabaseReload' /etc/clamav/clamd.conf; then \
      sed -ri 's/^#?ConcurrentDatabaseReload .*/ConcurrentDatabaseReload no/' /etc/clamav/clamd.conf; \
    else echo 'ConcurrentDatabaseReload no' >> /etc/clamav/clamd.conf; fi \
    && if [ "${DOCSLURP_BAKE_CLAMAV_SIGNATURES}" = "true" ]; then \
      freshclam --stdout --config-file=/etc/clamav/freshclam.conf || echo "warning: freshclam bake failed; workers will refresh on start"; \
      chown -R docslurp:docslurp /var/lib/clamav; \
    fi

COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
COPY --from=landrun /usr/local/bin/landrun /usr/local/bin/landrun
# Python base parsers (root-owned, read-only for the worker user).
COPY --from=python-venv /app/.venv /app/.venv
# Production node_modules, then compiled output (changes most often, so last).
COPY --from=builder /prod/worker/package.json ./worker/package.json
COPY --from=builder /prod/worker/node_modules ./worker/node_modules
COPY --from=native-pdf /app/vendor-artifacts ./vendor-artifacts
COPY --from=native-pdf-assets /opt/native-pdf /opt/native-pdf
COPY worker/LICENSE ./worker/LICENSE
COPY worker/scripts ./worker/scripts
# Allowlist + lock for Python provisioning (worker/src/tools/python-deps.ts) and the
# vendor bundle trust root (worker/src/tools/vendor-bundles.ts).
COPY worker/requirements*.txt worker/vendor-bundles.json ./worker/
COPY worker/security ./worker/security
COPY scripts/check-worker-prerequisites.mjs ./scripts/check-worker-prerequisites.mjs
COPY scripts/start-worker.sh ./scripts/start-worker.sh
COPY --from=builder /app/worker/dist ./worker/dist
RUN rm -rf ./worker/scripts/__pycache__ \
    && chmod +x ./worker/scripts/parser-sandbox.sh ./scripts/start-worker.sh \
    && PYTHON_VENV=/app/.venv node scripts/check-worker-prerequisites.mjs --profile=lean

ENV HOME=/home/docslurp
ENV PYTHON_VENV=/app/.venv
ENV DOCSLURP_CLAMAV_RUN_DIR=/tmp/clamav
ENV DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS=
ENV DOCSLURP_DEPLOYMENT_PROFILE=lean
ENV DOCSLURP_WORKER_IMAGE=worker-lean
ENV DOCSLURP_ALLOCATED_VCPU=1
ENV DOCSLURP_ALLOCATED_MEMORY_GB=1
# The base parsers are baked into /app/.venv; anything else comes from a vendor
# bundle. /app is root-owned and the worker runs as `docslurp`, so a runtime pip
# install could never succeed here: keep it off so optional extractors fail fast.
ENV DOCSLURP_PYTHON_LAZY_INSTALL=false
# Vendor bundles stay off until DOCSLURP_VENDOR_BUNDLE_BASE_URL is set; they
# unpack under the writable DOCSLURP_VENDOR_BUNDLE_DIR (or /data when mounted).
ENV DOCSLURP_VENDOR_BUNDLE_DIR=/home/docslurp/.cache/docslurp/vendor-bundles

# Empty unless the matching build flag above was set (the worker ignores empty values).
ARG DOCSLURP_NATIVE_PDF=
ARG DOCSLURP_NATIVE_PDF_OCR_MODELS=
ARG DOCSLURP_NATIVE_PDF_CJK_FONTS=
ENV DOCSLURP_NATIVE_PDF_INSTALLED=${DOCSLURP_NATIVE_PDF:+1}
ENV NATIVE_PDF_OCR_MODEL_DIR=${DOCSLURP_NATIVE_PDF_OCR_MODELS:+/opt/native-pdf/ocr-models}
ENV NATIVE_PDF_FONTS_DIR=${DOCSLURP_NATIVE_PDF_CJK_FONTS:+/opt/native-pdf/fonts}

# Release version of this image (set by .github/workflows/worker-images.yml; empty for
# local builds). The Modal parser sandbox defaults to worker-full:<this version>.
ARG DOCSLURP_VERSION=
ENV DOCSLURP_VERSION=${DOCSLURP_VERSION}

# Temporal Build ID for this image (worker/src/temporal/worker-versioning.ts).
# Last, so a new SHA does not invalidate earlier layers.
ARG DOCSLURP_GIT_SHA=
ENV DOCSLURP_GIT_SHA=${DOCSLURP_GIT_SHA}

USER docslurp

CMD ["bash", "-lc", "DOCSLURP_WORKER_INSTALL_HEAVY_DEPS_ON_STARTUP=false /app/scripts/start-worker.sh"]
