#!/usr/bin/env sh
set -eu

if command -v apk >/dev/null 2>&1; then
  apk add --no-cache \
    bash \
    bubblewrap \
    ffmpeg \
    ca-certificates \
    clamav \
    clamav-daemon \
    ghostscript \
    imagemagick \
    libreoffice \
    nodejs \
    npm \
    ocrmypdf \
    pandoc \
    poppler-data \
    poppler-utils \
    py3-pip \
    python3 \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    tiff-tools
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    bubblewrap \
    ffmpeg \
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
    ocrmypdf \
    pandoc \
    poppler-data \
    poppler-utils \
    python3 \
    python3-pip \
    python3-venv \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-eng \
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
