#!/usr/bin/env bash
# Build the worker's base Python venv for an image build stage.
#
#   bash scripts/build-worker-venv.sh /app/.venv worker/requirements-base.lock.txt worker/requirements-base.txt
#
# Wheels only (no sdists, so no compiler and no setup.py runs at build time),
# no pip cache, then trimmed: pip/setuptools removed from the venv (runtime
# pip installs are disabled in images), test suites deleted, and bytecode
# precompiled because the non-root runtime user cannot write __pycache__ under
# /app and every parser call is a fresh interpreter.
set -euo pipefail

VENV="${1:?venv path}"
LOCK="${2:?lock file}"
CONSTRAINTS="${3:-}"

python3 -m venv "${VENV}"
pip_args=(install --no-cache-dir --disable-pip-version-check --only-binary=:all: -r "${LOCK}")
if [[ -n "${CONSTRAINTS}" ]]; then pip_args+=(-c "${CONSTRAINTS}"); fi
"${VENV}/bin/python" -m pip "${pip_args[@]}"

SITE="$("${VENV}/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
# DOCSLURP_VENV_KEEP_PIP=1 keeps pip for images that still allow the deferred
# startup install (Dockerfile.full with DOCSLURP_WORKER_INSTALL_HEAVY_DEPS_ON_STARTUP).
if [[ "${DOCSLURP_VENV_KEEP_PIP:-0}" != "1" ]]; then
  "${VENV}/bin/python" -m pip uninstall --yes --quiet pip setuptools wheel >/dev/null 2>&1 || true
  rm -rf "${VENV}"/bin/pip* "${SITE}"/pip "${SITE}"/pip-*.dist-info "${SITE}"/setuptools* "${SITE}"/_distutils_hack "${SITE}"/distutils-precedence.pth
fi
find "${SITE}" -depth -type d \( -name tests -o -name test -o -name __pycache__ \) -prune -exec rm -rf {} +
"${VENV}/bin/python" -m compileall -q -j 0 -o 0 "${SITE}" >/dev/null
echo "[build-worker-venv] ${VENV}: $(du -sm "${VENV}" | cut -f1) MiB"
