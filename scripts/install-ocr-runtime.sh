#!/usr/bin/env bash
# Local OCR runtime for development and customer-owned self-hosting (docs/extraction/ocr.md).
#
#   bash scripts/install-ocr-runtime.sh [PREFIX]
#
# Creates a wheel-only, hash-checked venv from worker/requirements-ocr.lock.txt at PREFIX/venv and
# fetches the models pinned in worker/ocr-models.json into PREFIX/models, verifying each sha256.
# PREFIX defaults to ${XDG_CACHE_HOME:-~/.cache}/docslurp/ocr. Uses uv when it is installed, else pip.
# Prints the environment variables to set; it does not enable OCR by itself.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${1:-${XDG_CACHE_HOME:-${HOME}/.cache}/docslurp/ocr}"
LOCK="${ROOT_DIR}/worker/requirements-ocr.lock.txt"
MANIFEST="${ROOT_DIR}/worker/ocr-models.json"
CLI="${ROOT_DIR}/worker/scripts/docslurp_ocr.py"
VENV="${PREFIX}/venv"
MODELS="${PREFIX}/models"

for required in "${LOCK}" "${MANIFEST}"; do
  if [[ ! -f "${required}" ]]; then
    echo "[ocr-runtime] missing ${required}" >&2
    exit 1
  fi
done
if ! grep -q -- '--hash=sha256:' "${LOCK}"; then
  echo "[ocr-runtime] ${LOCK} has no --hash entries" >&2
  exit 1
fi

mkdir -p "${PREFIX}"
if command -v uv >/dev/null 2>&1; then
  uv venv --quiet --python python3 "${VENV}"
  uv pip install --quiet --python "${VENV}/bin/python3" --only-binary :all: --require-hashes -r "${LOCK}"
else
  python3 -m venv "${VENV}"
  "${VENV}/bin/python3" -m pip install --quiet --no-cache-dir --disable-pip-version-check \
    --only-binary=:all: --require-hashes -r "${LOCK}"
fi

# A rerun replaces the read-only models of an earlier run.
if [[ -d "${MODELS}" ]]; then chmod -R u+w "${MODELS}"; fi
node "${ROOT_DIR}/scripts/fetch-ocr-models.mjs" --manifest "${MANIFEST}" --out "${MODELS}" \
  --cache "${XDG_CACHE_HOME:-${HOME}/.cache}/docslurp/ocr-downloads"
# Models are inputs, never written at runtime.
chmod -R a-w "${MODELS}"

if [[ -f "${CLI}" ]]; then
  "${VENV}/bin/python3" -I "${CLI}" --self-test --models "${MODELS}" --manifest "${MANIFEST}"
else
  echo "[ocr-runtime] ${CLI} not found; skipped the self-test" >&2
fi

cat <<EOF
[ocr-runtime] ready. To use local OCR (customer-owned self-hosting only), set:
  DOCSLURP_SERVICE_PROFILE=self-hosted
  DOCSLURP_OCR_MODE=local
  DOCSLURP_OCR_PYTHON=${VENV}/bin/python3
  DOCSLURP_OCR_MODEL_DIR=${MODELS}
EOF
