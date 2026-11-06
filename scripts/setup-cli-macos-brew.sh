#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# --with-ocr (or DOCSLURP_INSTALL_OCR=1) also builds the local OCR runtime: a hash-checked venv and the
# sha256-pinned models under ~/.cache/docslurp/ocr (scripts/install-ocr-runtime.sh, docs/extraction/ocr.md).
INSTALL_OCR="${DOCSLURP_INSTALL_OCR:-0}"
for arg in "$@"; do
  case "${arg}" in
    --with-ocr) INSTALL_OCR=1 ;;
    *) echo "Usage: $0 [--with-ocr]" >&2; exit 2 ;;
  esac
done

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Install it from https://brew.sh first." >&2
  exit 1
fi

brew update
brew install \
  clamav \
  ghostscript \
  imagemagick \
  libtiff \
  node \
  pandoc \
  poppler \
  webp \
  python \
  qpdf \
  unrtf \
  uv
brew install --cask libreoffice

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
node scripts/check-worker-prerequisites.mjs --profile=full
