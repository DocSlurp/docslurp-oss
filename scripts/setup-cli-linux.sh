#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUDO=""

if [[ "${EUID}" -ne 0 ]]; then
  SUDO="sudo"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script currently supports Debian/Ubuntu systems with apt-get." >&2
  exit 1
fi

${SUDO} apt-get update
${SUDO} apt-get install -y \
  build-essential \
  bubblewrap \
  catdoc \
  clamav \
  clamav-daemon \
  clamav-freshclam \
  clamdscan \
  curl \
  fonts-liberation \
  fonts-noto-cjk \
  fonts-noto-core \
  fonts-urw-base35 \
  git \
  ghostscript \
  imagemagick \
  libtiff-tools \
  libreoffice \
  nodejs \
  npm \
  ocrmypdf \
  pandoc \
  poppler-utils \
  python3 \
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

# Check kernel/container policy as the user who will run the worker.
bash "${ROOT_DIR}/worker/scripts/parser-sandbox.sh" /usr/bin/true

curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

VENV="${ROOT_DIR}/.venv"
DOCSLURP_WORKER_VENV="${VENV}" bash "${ROOT_DIR}/scripts/setup-worker-python-venv.sh"

if command -v corepack >/dev/null 2>&1; then
  corepack enable
fi

cd "${ROOT_DIR}"
pnpm install
node scripts/check-worker-prerequisites.mjs --profile=full --sandbox
