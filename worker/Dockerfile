# Build stage: compile TypeScript
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS builder
# TypeScript compilation never executes GPU inference; runtime installs stay unchanged.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
COPY worker/package.json worker/tsconfig.json worker/LICENSE ./worker/
RUN pnpm install --frozen-lockfile
COPY worker/src ./worker/src
COPY worker/scripts/copy-routing-assets.mjs ./worker/scripts/copy-routing-assets.mjs
COPY scripts/lib/model-prices.json ./scripts/lib/model-prices.json
RUN pnpm --filter @docslurp/worker build

# Optional native-pdf runtime assets, default off. With neither flag set this stage
# leaves /opt/native-pdf empty, so the default image does not grow. Sources and
# every file are sha256-pinned in scripts/fetch-native-pdf-assets.mjs.
#   DOCSLURP_NATIVE_PDF_OCR_MODELS=1  PP-OCRv6 small OCR models (~30 MB, Apache-2.0)
#   DOCSLURP_NATIVE_PDF_CJK_FONTS=1   Noto CJK fallback fonts (~54 MB, OFL-1.1)
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS native-pdf-assets
ARG DOCSLURP_NATIVE_PDF_OCR_MODELS=
ARG DOCSLURP_NATIVE_PDF_CJK_FONTS=
COPY scripts/fetch-native-pdf-assets.mjs /tmp/fetch-native-pdf-assets.mjs
RUN node /tmp/fetch-native-pdf-assets.mjs --out /opt/native-pdf \
      --ocr-models="${DOCSLURP_NATIVE_PDF_OCR_MODELS}" --cjk-fonts="${DOCSLURP_NATIVE_PDF_CJK_FONTS}"

# landrun (Landlock sandbox provider, MIT, pinned by worker/sandbox-tools.json), built from its pinned commit with a fixed Go
# toolchain (the v0.1.17 release binary was built with Go 1.26.5, which carries standard-library CVEs). The checkout must be
# exactly the pinned commit, and module downloads are verified against the repository's go.sum. Static (CGO_ENABLED=0).
FROM golang:1.27-trixie@sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80 AS landrun
ARG TARGETARCH=amd64
COPY worker/sandbox-tools.json /tmp/sandbox-tools.json
RUN set -e; \
    commit="$(sed -n 's/.*"commit": "\([0-9a-f]\{40\}\)".*/\1/p' /tmp/sandbox-tools.json)"; \
    test -n "$commit"; \
    git clone -q --filter=blob:none https://github.com/Zouuup/landrun /src/landrun; \
    cd /src/landrun && git checkout -q "$commit" && test "$(git rev-parse HEAD)" = "$commit"; \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" GOFLAGS=-mod=readonly go build -trimpath -ldflags="-s -w" -o /usr/local/bin/landrun ./cmd/landrun; \
    /usr/local/bin/landrun --version

# Production stage: runtime only (no TypeScript toolchain or devDeps)
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
# Node's bundled npm 11.19.1 carries undici 6.28.0 and brace-expansion 5.0.9 (Trivy HIGH); npm 11.21.2 bundles the fixed
# versions. Installed from its registry tarball, checked against the pinned sha512 first. Nothing at runtime runs npm.
RUN node -e ' \
      const fs = require("node:fs"); const crypto = require("node:crypto"); \
      fetch("https://registry.npmjs.org/npm/-/npm-11.21.2.tgz").then((r) => { if (!r.ok) throw new Error("npm download failed: " + r.status); return r.arrayBuffer(); }).then((buf) => { \
        const data = Buffer.from(buf); \
        const sum = "sha512-" + crypto.createHash("sha512").update(data).digest("base64"); \
        if (sum !== "sha512-7HPApk+AflMUavSseL1Pm6CnYqMIHk53x+KmuhqmTDqPkjPMgxIpTPcTqsE91EKNw4gFBJV9fnXiSdGm1DXq9A==") throw new Error("npm integrity mismatch: " + sum); \
        fs.writeFileSync("/tmp/npm-11.21.2.tgz", data); \
      }).catch((e) => { console.error(e.message); process.exit(1); });' \
    && npm install -g --no-audit --no-fund /tmp/npm-11.21.2.tgz && rm -f /tmp/npm-11.21.2.tgz && test "$(npm -v)" = 11.21.2
WORKDIR /app
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
COPY --from=landrun /usr/local/bin/landrun /usr/local/bin/landrun
RUN corepack enable

# Install CLI tools and the base Python parsers. Heavy Python dependencies are
# installed by start-worker.sh on first boot instead of inflating image layers.
COPY worker/requirements.txt ./worker/requirements.txt
COPY worker/requirements.lock.txt ./worker/requirements.lock.txt
COPY worker/requirements-fallback.txt ./worker/requirements-fallback.txt
COPY worker/requirements-fallback.lock.txt ./worker/requirements-fallback.lock.txt
COPY worker/requirements-base.txt ./worker/requirements-base.txt
COPY worker/requirements-base.lock.txt ./worker/requirements-base.lock.txt
COPY worker/requirements-heavy.txt ./worker/requirements-heavy.txt
COPY scripts/setup-cli-docker.sh /tmp/setup-cli-docker.sh
COPY scripts/uv-installer.lock.txt /tmp/uv-installer.lock.txt
COPY scripts/setup-worker-python-venv.sh /tmp/setup-worker-python-venv.sh
# The venv stays root-owned (council W #1): parsers run as uid 10001 and must not rewrite it for the next document.
RUN sh /tmp/setup-cli-docker.sh \
    && rm -f /tmp/setup-cli-docker.sh /tmp/uv-installer.lock.txt

# Install production Node.js dependencies only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/LICENSE packages/shared/NOTICE ./packages/shared/
COPY worker/package.json worker/tsconfig.json worker/LICENSE ./worker/
RUN pnpm install --filter @docslurp/worker... --prod --frozen-lockfile
# Optional private native PDF engine: pinned by vendor-artifacts/native-pdf/manifest.json,
# tarball supplied in the build context (gitignored). Absent tarball = no-op (Poppler path).
# DOCSLURP_NATIVE_PDF=1 requires it (missing or unloadable binding fails the build) and
# sets DOCSLURP_NATIVE_PDF_INSTALLED=1. Without the flag, a tarball that installs and
# loads is still used; vendor-artifacts/native-pdf/node_modules then marks it installed.
ARG DOCSLURP_NATIVE_PDF=
ARG DOCSLURP_NATIVE_PDF_OCR_MODELS=
ARG DOCSLURP_NATIVE_PDF_CJK_FONTS=
COPY scripts/install-native-pdf.mjs ./scripts/install-native-pdf.mjs
COPY vendor-artifact[s]/native-pdf/ ./vendor-artifacts/native-pdf/
RUN node scripts/install-native-pdf.mjs --optional
COPY --from=native-pdf-assets /opt/native-pdf /opt/native-pdf

# Copy compiled output from builder
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/worker/dist ./worker/dist
COPY worker/scripts ./worker/scripts
COPY worker/security ./worker/security
COPY scripts/check-worker-prerequisites.mjs ./scripts/check-worker-prerequisites.mjs
COPY scripts/setup-worker-python-venv.sh ./scripts/setup-worker-python-venv.sh
COPY scripts/start-worker.sh ./scripts/start-worker.sh
RUN node scripts/check-worker-prerequisites.mjs --profile=full

RUN groupadd --system --gid 10001 docslurp \
    && useradd --system --uid 10001 --gid docslurp --home-dir /home/docslurp --create-home --shell /usr/sbin/nologin docslurp \
    && usermod -a -G clamav docslurp \
    && sed -ri 's/^#?User .*/User docslurp/' /etc/clamav/clamd.conf \
    && sed -ri 's|^#?LocalSocket .*|LocalSocket /tmp/clamav/clamd.ctl|' /etc/clamav/clamd.conf \
    && sed -ri 's/^#?LocalSocketGroup .*/LocalSocketGroup docslurp/' /etc/clamav/clamd.conf \
    && sed -ri 's|^#?PidFile .*|PidFile /tmp/clamav/clamd.pid|' /etc/clamav/clamd.conf \
    && sed -ri 's/^#?DatabaseOwner .*/DatabaseOwner docslurp/' /etc/clamav/freshclam.conf \
    && mkdir -p /tmp/docslurp-parser-sandbox /tmp/clamav /var/log/clamav /var/lib/clamav \
    && chmod +x ./worker/scripts/parser-sandbox.sh ./scripts/start-worker.sh \
    && chown -R docslurp:docslurp /home/docslurp /tmp/docslurp-parser-sandbox /tmp/clamav /var/log/clamav /var/lib/clamav

# No OCR engine, package, binary or language data is installed or linked: no native addon embeds Tesseract, Leptonica
# or PaddleOCR (worker/src/__tests__/no-tesseract.test.ts and scripts/scan-ocr-engines.mjs check this). OCR runs only
# in the configured boundary (docs/extraction/ocr.md).
ENV HOME=/home/docslurp
ENV DOCSLURP_CLAMAV_RUN_DIR=/tmp/clamav
ENV DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS=
ENV DOCSLURP_DEPLOYMENT_PROFILE=heavy
ENV DOCSLURP_WORKER_IMAGE=worker-default
ENV DOCSLURP_ALLOCATED_VCPU=2
ENV DOCSLURP_ALLOCATED_MEMORY_GB=4

# Empty unless the matching build flag above was set (the worker ignores empty values).
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

CMD ["bash", "/app/scripts/start-worker.sh"]
