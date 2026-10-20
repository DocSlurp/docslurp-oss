# Build stage: compile TypeScript
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
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

# Production stage: runtime only (no TypeScript toolchain or devDeps)
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
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
COPY scripts/setup-worker-python-venv.sh /tmp/setup-worker-python-venv.sh
RUN sh /tmp/setup-cli-docker.sh \
    && chown -R 10001:10001 /app/.venv \
    && rm /tmp/setup-cli-docker.sh

# Install production Node.js dependencies only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/LICENSE packages/shared/NOTICE ./packages/shared/
COPY worker/package.json worker/tsconfig.json worker/LICENSE ./worker/
RUN pnpm install --filter @docslurp/worker... --prod --frozen-lockfile
# Optional private native PDF engine: pinned by vendor-artifacts/native-pdf/manifest.json,
# tarball supplied in the build context (gitignored). Absent tarball = no-op (Kreuzberg path).
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

ENV HOME=/home/docslurp
ENV DOCSLURP_CLAMAV_RUN_DIR=/tmp/clamav
ENV DOCSLURP_PARSER_SANDBOX_ENABLED=true
ENV DOCSLURP_PARSER_SANDBOX_NETWORK=none
ENV DOCSLURP_PARSER_SANDBOX_MODE=isolated
ENV DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS=
ENV DOCSLURP_DEPLOYMENT_PROFILE=heavy
ENV DOCSLURP_WORKER_IMAGE=worker-default
ENV DOCSLURP_ALLOCATED_VCPU=2
ENV DOCSLURP_ALLOCATED_MEMORY_GB=4

# Empty unless the matching build flag above was set (the worker ignores empty values).
ENV DOCSLURP_NATIVE_PDF_INSTALLED=${DOCSLURP_NATIVE_PDF:+1}
ENV NATIVE_PDF_OCR_MODEL_DIR=${DOCSLURP_NATIVE_PDF_OCR_MODELS:+/opt/native-pdf/ocr-models}
ENV NATIVE_PDF_FONTS_DIR=${DOCSLURP_NATIVE_PDF_CJK_FONTS:+/opt/native-pdf/fonts}

# Temporal Build ID for this image (worker/src/temporal/worker-versioning.ts).
# Last, so a new SHA does not invalidate earlier layers.
ARG DOCSLURP_GIT_SHA=
ENV DOCSLURP_GIT_SHA=${DOCSLURP_GIT_SHA}

USER docslurp

CMD ["bash", "/app/scripts/start-worker.sh"]
