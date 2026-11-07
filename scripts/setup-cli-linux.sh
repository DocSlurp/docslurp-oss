#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUDO=""
# --with-ocr (or DOCSLURP_INSTALL_OCR=1) also builds the local OCR runtime: a hash-checked venv and the
# sha256-pinned models under ~/.cache/docslurp/ocr (scripts/install-ocr-runtime.sh, docs/extraction/ocr.md).
INSTALL_OCR="${DOCSLURP_INSTALL_OCR:-0}"
for arg in "$@"; do
  case "${arg}" in
    --with-ocr) INSTALL_OCR=1 ;;
    *) echo "Usage: $0 [--with-ocr]" >&2; exit 2 ;;
  esac
done

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
  pandoc \
  poppler-utils \
  poppler-data \
  python3 \
  python3-venv \
  qpdf \
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
if [[ "${INSTALL_OCR}" == 1 ]]; then
  OCR_PREFIX="${XDG_CACHE_HOME:-${HOME}/.cache}/docslurp/ocr"
  bash "${ROOT_DIR}/scripts/install-ocr-runtime.sh" "${OCR_PREFIX}"
  # Lets the prerequisite check below run the OCR self-test against this install.
  export DOCSLURP_OCR_PYTHON="${OCR_PREFIX}/venv/bin/python3" DOCSLURP_OCR_MODEL_DIR="${OCR_PREFIX}/models"
fi
node scripts/check-worker-prerequisites.mjs --profile=full --sandbox
