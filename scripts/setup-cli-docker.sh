#!/usr/bin/env sh
set -eu

if command -v apk >/dev/null 2>&1; then
  # No system OCR engine and no ocrmypdf (it depends on one). OCR runs through
  # worker/scripts/docslurp_ocr.py (docs/extraction/ocr.md), which this image does not bake.
  apk add --no-cache \
    bash \
    bubblewrap \
    ffmpeg \
    font-liberation \
    font-noto \
    font-noto-cjk \
    font-urw-base35 \
    ca-certificates \
    clamav \
    clamav-daemon \
    ghostscript \
    imagemagick \
    libreoffice \
    nodejs \
    npm \
    pandoc \
    poppler-data \
    poppler-utils \
    py3-pip \
    python3 \
    qpdf \
    libwebp-tools \
    tiff-tools
elif command -v apt-get >/dev/null 2>&1; then
  # No system OCR engine and no ocrmypdf (it depends on one); see docs/extraction/ocr.md.
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    bubblewrap \
    ffmpeg \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-core \
    fonts-urw-base35 \
    ca-certificates \
    catdoc \
    clamav \
    clamav-daemon \
    clamav-freshclam \
    clamdscan \
    ghostscript \
    imagemagick \
    libtiff-tools \
    libreoffice \
    npm \
    pandoc \
    poppler-data \
    poppler-utils \
    python3 \
    python3-pip \
    python3-venv \
    qpdf \
    webp \
    unrtf
  rm -rf /var/lib/apt/lists/*
else
  echo "Unsupported package manager for setup-cli-docker.sh" >&2
  exit 1
fi

# Pinned, hash-checked installer (scripts/uv-installer.lock.txt, copied by the Dockerfile).
pip3 install --break-system-packages --no-cache-dir --only-binary=:all: --require-hashes -r /tmp/uv-installer.lock.txt

# Bake only the common parser dependencies into the image. start-worker.sh installs
# the larger toolchains on first startup, outside the image layers.
BASE_REQUIREMENTS=/app/worker/requirements-base.txt
if [ "$(uname -m)" = "x86_64" ]; then
  BASE_REQUIREMENTS=/app/worker/requirements-base.lock.txt
fi
DOCSLURP_WORKER_VENV=/app/.venv \
  DOCSLURP_WORKER_REQUIREMENTS_FILE="${BASE_REQUIREMENTS}" \
  DOCSLURP_WORKER_FALLBACK_REQUIREMENTS_FILE="${BASE_REQUIREMENTS}" \
  DOCSLURP_WORKER_SKIP_FALLBACK=1 \
  bash /tmp/setup-worker-python-venv.sh
