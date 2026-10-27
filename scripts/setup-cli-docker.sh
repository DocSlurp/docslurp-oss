#!/usr/bin/env sh
set -eu

if command -v apk >/dev/null 2>&1; then
  # Alpine has no tesseract-ocr-data-ell (Greek); the prerequisite check skips ell on Alpine.
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
    ocrmypdf \
    pandoc \
    poppler-data \
    poppler-utils \
    py3-pip \
    python3 \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    tesseract-ocr-data-deu \
    tesseract-ocr-data-fra \
    tesseract-ocr-data-spa \
    tesseract-ocr-data-ara \
    tesseract-ocr-data-chi_sim \
    tesseract-ocr-data-chi_tra \
    tesseract-ocr-data-heb \
    tesseract-ocr-data-hin \
    tesseract-ocr-data-ita \
    tesseract-ocr-data-jpn \
    tesseract-ocr-data-kor \
    tesseract-ocr-data-nld \
    tesseract-ocr-data-pol \
    tesseract-ocr-data-por \
    tesseract-ocr-data-rus \
    tesseract-ocr-data-tha \
    tesseract-ocr-data-tur \
    tesseract-ocr-data-ukr \
    tesseract-ocr-data-vie \
    libwebp-tools \
    tiff-tools
elif command -v apt-get >/dev/null 2>&1; then
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
    tesseract-ocr-deu \
    tesseract-ocr-fra \
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
