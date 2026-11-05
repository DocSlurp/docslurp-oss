# Dockerfile.lean - Production worker image (fly.worker.toml)
#
# Contents: Node 24 + the worker's production node_modules (pnpm deploy, pruned),
# Doppler (the DocSlurp Poppler fork, built from worker/doppler.json; with poppler-data CMaps), cwebp (lossless WebP page images), pandoc, ffmpeg, ClamAV, bubblewrap, and a wheel-only Python venv
# with the base parsers (trafilatura, ebooklib, python-pptx,
# openpyxl, xlsx2csv, Pillow; PDFs use Poppler, the optional native-pdf engine or the sandboxed PDF provider). No LibreOffice or ML stacks: Docling and
# Unstructured come from sha256-pinned vendor bundles fetched on demand
# (worker/vendor-bundles.json, docs/worker-image.md). Runtime pip installs are off.
# No OCR engine: lean workers OCR through an extractor plugin's VM provider
# (DOCSLURP_OCR_MODE=vm), hosted mode, or not at all (docs/extraction/ocr.md).
#
# Every build stage starts from the same pinned base so the venv (which links
# /usr/bin/python3) and native addons match the runtime stage exactly.

# Build stage: compile TypeScript, then produce a self-contained production
# node_modules for the worker only (no pnpm store, no workspace-root deps).
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS builder
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
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS python-venv
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY worker/requirements-base.txt worker/requirements-base.lock.txt /tmp/req/
COPY scripts/build-worker-venv.sh /tmp/build-worker-venv.sh
RUN bash /tmp/build-worker-venv.sh /app/.venv /tmp/req/requirements-base.lock.txt /tmp/req/requirements-base.txt

# Optional private native PDF engine: pinned by vendor-artifacts/native-pdf/manifest.json,
# tarball supplied in the build context (gitignored). Absent tarball = no-op (Poppler path).
# DOCSLURP_NATIVE_PDF=1 requires it (missing or unloadable binding fails the build).
# Installed in its own stage so the tarball itself never lands in an image layer.
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS native-pdf
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
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS native-pdf-assets
ARG DOCSLURP_NATIVE_PDF_OCR_MODELS=
ARG DOCSLURP_NATIVE_PDF_CJK_FONTS=
COPY scripts/fetch-native-pdf-assets.mjs /tmp/fetch-native-pdf-assets.mjs
RUN node /tmp/fetch-native-pdf-assets.mjs --out /opt/native-pdf \
      --ocr-models="${DOCSLURP_NATIVE_PDF_OCR_MODELS}" --cjk-fonts="${DOCSLURP_NATIVE_PDF_CJK_FONTS}"

# landrun (Landlock sandbox provider, MIT, pinned by worker/sandbox-tools.json). Downloaded for
# TARGETARCH and sha256-verified. The release binary is dynamically linked and needs glibc >= 2.38:
# it runs on Debian trixie (this base image) but fails on bookworm, so do not downgrade the base.
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS landrun
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

# Doppler (DocSlurp/doppler, GPL-2.0-or-later): the Poppler fork's command-line utilities and the doppler-md /
# pdftomarkdown converter, built from the public source pinned in worker/doppler.json (sha256-verified). They replace
# Debian's poppler-utils and run only as separate executables in the parser sandbox; nothing links them.
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS doppler-src
COPY worker/doppler.json /tmp/doppler.json
RUN node -e ' \
      const fs = require("node:fs"); const crypto = require("node:crypto"); \
      const pin = JSON.parse(fs.readFileSync("/tmp/doppler.json", "utf8")).source; \
      fetch(pin.url).then((r) => { if (!r.ok) throw new Error("doppler source download failed: " + r.status); return r.arrayBuffer(); }).then((buf) => { \
        const data = Buffer.from(buf); \
        const sum = crypto.createHash("sha256").update(data).digest("hex"); \
        if (sum !== pin.sha256) throw new Error("doppler source sha256 mismatch: " + sum); \
        fs.writeFileSync("/tmp/doppler-src.tar.gz", data); \
      }).catch((e) => { console.error(e.message); process.exit(1); });' \
    && mkdir -p /src \
    && tar -xzf /tmp/doppler-src.tar.gz -C /src \
    && mv "/src/$(node -p 'require("/tmp/doppler.json").source.prefix')" /src/doppler

FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS doppler-utils
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build pkg-config ca-certificates \
      libfreetype-dev libfontconfig-dev libjpeg-dev libopenjp2-7-dev libpng-dev \
      libtiff-dev liblcms2-dev zlib1g-dev libboost-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=doppler-src /src/doppler /src/doppler
RUN cmake -S /src/doppler -B /src/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_INSTALL_RPATH=/usr/local/lib -DPOPPLER_DATADIR=/usr/share/poppler \
      -DENABLE_QT5=OFF -DENABLE_QT6=OFF -DENABLE_GLIB=OFF -DENABLE_GOBJECT_INTROSPECTION=OFF \
      -DENABLE_CPP=OFF -DENABLE_NSS3=OFF -DENABLE_GPGME=OFF -DENABLE_LIBCURL=OFF \
      -DENABLE_BROTLI=OFF -DENABLE_HARFBUZZ=OFF -DBUILD_GTK_TESTS=OFF -DBUILD_MANUAL_TESTS=OFF \
      -DBUILD_CPP_TESTS=OFF -DENABLE_UNSTABLE_API_ABI_HEADERS=OFF -DRUN_GPERF_IF_PRESENT=OFF \
    && cmake --build /src/build -j"$(nproc)" \
    && DESTDIR=/out cmake --install /src/build \
    && rm -rf /out/usr/local/include /out/usr/local/lib/pkgconfig /out/usr/local/lib/cmake /out/usr/local/share/man \
    && install -D -m 0644 /src/doppler/COPYING /out/usr/local/share/doc/doppler/COPYING \
    && install -D -m 0644 /src/doppler/COPYING3 /out/usr/local/share/doc/doppler/COPYING3 \
    && printf 'Doppler (GPL-2.0-or-later). Corresponding source: https://github.com/DocSlurp/doppler/tree/827b3cccecfdcfe61ad89335ec2fb5476df014da (tarball: https://github.com/DocSlurp/doppler/releases/download/docslurp-827b3cc/doppler-827b3cc-src.tar.gz)\n' > /out/usr/local/share/doc/doppler/SOURCE \
    && for tool in pdftotext pdftohtml pdfinfo pdfimages pdftoppm pdfseparate pdfunite; do test -x "/out/usr/local/bin/$tool"; done

FROM rust:1.99-slim-trixie@sha256:7eab7ce19273ce785e0ca7578bdf7bc1fcbae621775a8197379a04c9f6e03cd5 AS doppler-md
COPY --from=doppler-src /src/doppler/docslurp/doppler-md /src/doppler-md
RUN cargo build --release --locked --manifest-path /src/doppler-md/Cargo.toml \
    && install -D -m 0755 /src/doppler-md/target/release/doppler-md /out/usr/local/bin/doppler-md \
    && install -D -m 0755 /src/doppler-md/target/release/pdftomarkdown /out/usr/local/bin/pdftomarkdown

# Production stage: runtime only (no TypeScript toolchain, pnpm store or devDeps)
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
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
       libfontconfig1 \
       libfreetype6 \
       libjpeg62-turbo \
       liblcms2-2 \
       libopenjp2-7 \
       libpng16-16t64 \
       libtiff6 \
       zlib1g \
       python3 \
       webp \
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
# Doppler: Poppler-fork utilities (pdftotext, pdfinfo, pdfimages, pdftoppm, pdftohtml, pdfseparate, pdfunite) with
# libpoppler, and doppler-md / pdftomarkdown, all under /usr/local (on PATH, inside the sandbox's read-only /usr).
COPY --from=doppler-utils /out/usr/local/ /usr/local/
COPY --from=doppler-md /out/usr/local/bin/ /usr/local/bin/
RUN ldconfig && test -x /usr/local/bin/pdftomarkdown && pdftotext -v
ENV DOCSLURP_DOPPLER_REQUIRED=1
# Python base parsers (root-owned, read-only for the worker user).
COPY --from=python-venv /app/.venv /app/.venv
# Production node_modules, then compiled output (changes most often, so last).
COPY --from=builder /prod/worker/package.json ./worker/package.json
COPY --from=builder /prod/worker/node_modules ./worker/node_modules
COPY --from=native-pdf /app/vendor-artifacts ./vendor-artifacts
# Optional extractor plugins a deployment stages into the build context; the worker loads only the ones
# DOCSLURP_EXTRACTOR_PLUGINS names (docs/extraction/extractor-plugins.md). Absent by default.
COPY vendor-artifact[s]/extractor-plugin[s] ./vendor-artifacts/extractor-plugins/
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

# No OCR engine, package, binary or language data is installed or linked: no native addon embeds Tesseract, Leptonica
# or PaddleOCR (worker/src/__tests__/no-tesseract.test.ts and scripts/scan-ocr-engines.mjs check this). OCR runs only
# in the configured boundary (docs/extraction/ocr.md).
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

# Provenance of the third-party native components (Doppler; the native PDF engine when installed): license texts and
# PROVENANCE.json under /usr/share/licenses/<name>/, and an SPDX document. A component without a public repository
# and pinned commit fails the build.
COPY scripts/write-component-provenance.mjs ./scripts/write-component-provenance.mjs
COPY worker/doppler.json ./worker/doppler.json
RUN node scripts/write-component-provenance.mjs --doppler worker/doppler.json --doppler-prefix /usr/local \
      --engine-manifest /app/vendor-artifacts/native-pdf/manifest.json
LABEL io.docslurp.doppler.source="https://github.com/DocSlurp/doppler" \
      io.docslurp.doppler.commit="827b3cccecfdcfe61ad89335ec2fb5476df014da" \
      io.docslurp.doppler.license="GPL-2.0-or-later" \
      io.docslurp.doppler.corresponding-source="https://github.com/DocSlurp/doppler/tree/827b3cccecfdcfe61ad89335ec2fb5476df014da" \
      io.docslurp.sbom.native-components="/usr/share/doc/docslurp/sbom/native-components.spdx.json"
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
