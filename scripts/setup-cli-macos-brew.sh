#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
  ocrmypdf \
  pandoc \
  poppler \
  python \
  qpdf \
  tesseract \
  tesseract-lang \
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
node scripts/check-worker-prerequisites.mjs --profile=full
