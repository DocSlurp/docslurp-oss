#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${DOCSLURP_ROOT_DIR:-}"

if [[ -z "${ROOT_DIR}" ]]; then
  if [[ -f "${SCRIPT_ROOT}/worker/requirements.txt" ]]; then
    ROOT_DIR="${SCRIPT_ROOT}"
  elif [[ -f "${PWD}/worker/requirements.txt" ]]; then
    ROOT_DIR="${PWD}"
  else
    ROOT_DIR="${SCRIPT_ROOT}"
  fi
fi

ROOT_DIR="$(cd "${ROOT_DIR}" && pwd)"
VENV="${DOCSLURP_WORKER_VENV:-${ROOT_DIR}/.venv}"
REQUIREMENTS_MODE="${DOCSLURP_WORKER_REQUIREMENTS_MODE:-auto}"
VENV_CREATOR="${DOCSLURP_WORKER_VENV_CREATOR:-auto}"
REQUIREMENTS_INSTALLER="${DOCSLURP_WORKER_REQUIREMENTS_INSTALLER:-auto}"
FULL_REQUIREMENTS="${ROOT_DIR}/worker/requirements.txt"
FALLBACK_REQUIREMENTS="${ROOT_DIR}/worker/requirements-fallback.txt"
LOCKED_FULL_REQUIREMENTS="${ROOT_DIR}/worker/requirements.lock.txt"
LOCKED_FALLBACK_REQUIREMENTS="${ROOT_DIR}/worker/requirements-fallback.lock.txt"
SKIP_FALLBACK="${DOCSLURP_WORKER_SKIP_FALLBACK:-0}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to create the worker virtual environment." >&2
  exit 1
fi

export UV_TORCH_BACKEND="${UV_TORCH_BACKEND:-cpu}"
export UV_NO_CACHE="${UV_NO_CACHE:-1}"
export PIP_NO_CACHE_DIR="${PIP_NO_CACHE_DIR:-1}"

supports_locked_requirements() {
  [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]
}

resolve_default_requirements() {
  local loose_file="$1"
  local locked_file="$2"

  case "${REQUIREMENTS_MODE}" in
    locked)
      if [[ ! -f "${locked_file}" ]]; then
        echo "Expected locked requirements file at ${locked_file}, but it does not exist." >&2
        exit 1
      fi
      printf '%s\n' "${locked_file}"
      ;;
    loose)
      printf '%s\n' "${loose_file}"
      ;;
    auto)
      if supports_locked_requirements && [[ -f "${locked_file}" ]]; then
        printf '%s\n' "${locked_file}"
      else
        printf '%s\n' "${loose_file}"
      fi
      ;;
    *)
      echo "Unsupported DOCSLURP_WORKER_REQUIREMENTS_MODE=${REQUIREMENTS_MODE}. Use auto, locked, or loose." >&2
      exit 1
      ;;
  esac
}

PRIMARY_REQUIREMENTS="${DOCSLURP_WORKER_REQUIREMENTS_FILE:-$(resolve_default_requirements "${FULL_REQUIREMENTS}" "${LOCKED_FULL_REQUIREMENTS}")}"
SECONDARY_REQUIREMENTS="${DOCSLURP_WORKER_FALLBACK_REQUIREMENTS_FILE:-$(resolve_default_requirements "${FALLBACK_REQUIREMENTS}" "${LOCKED_FALLBACK_REQUIREMENTS}")}"

if [[ ! -f "${PRIMARY_REQUIREMENTS}" ]]; then
  echo "Worker requirements file not found: ${PRIMARY_REQUIREMENTS}" >&2
  exit 1
fi

if [[ ! -f "${SECONDARY_REQUIREMENTS}" ]]; then
  echo "Worker fallback requirements file not found: ${SECONDARY_REQUIREMENTS}" >&2
  exit 1
fi

if [[ "${1:-}" == "--recreate" ]]; then
  rm -rf "${VENV}"
fi

VENV_PYTHON="${VENV}/bin/python"
if [[ ! -x "${VENV_PYTHON}" ]]; then
  case "${VENV_CREATOR}" in
    auto)
      if command -v uv >/dev/null 2>&1; then
        uv venv --seed "${VENV}"
      else
        python3 -m venv "${VENV}"
      fi
      ;;
    python)
      python3 -m venv "${VENV}"
      ;;
    uv)
      uv venv --seed "${VENV}"
      ;;
    *)
      echo "Unsupported DOCSLURP_WORKER_VENV_CREATOR=${VENV_CREATOR}. Use auto, python, or uv." >&2
      exit 1
      ;;
  esac
else
  echo "Reusing existing worker virtual environment at ${VENV}"
fi

if [[ ! -x "${VENV_PYTHON}" ]]; then
  echo "Failed to locate the venv python at ${VENV_PYTHON}." >&2
  exit 1
fi

install_with_uv() {
  uv pip install --no-cache --python "${VENV_PYTHON}" -r "$1"
}

install_with_pip() {
  "${VENV_PYTHON}" -m pip install --no-cache-dir --upgrade pip setuptools wheel
  local index_args=()
  if [[ "${UV_TORCH_BACKEND}" == "cpu" ]]; then
    index_args=(--extra-index-url https://download.pytorch.org/whl/cpu)
  fi
  "${VENV_PYTHON}" -m pip install --no-cache-dir "${index_args[@]}" -r "$1"
}

install_requirements() {
  case "${REQUIREMENTS_INSTALLER}" in
    auto)
      if command -v uv >/dev/null 2>&1; then
        install_with_uv "$1"
        return
      fi

      install_with_pip "$1"
      ;;
    pip)
      install_with_pip "$1"
      ;;
    uv)
      install_with_uv "$1"
      ;;
    *)
      echo "Unsupported DOCSLURP_WORKER_REQUIREMENTS_INSTALLER=${REQUIREMENTS_INSTALLER}. Use auto, pip, or uv." >&2
      exit 1
      ;;
  esac
}

cleanup_caches() {
  local home_dir="${HOME:-/root}"
  rm -rf "${home_dir}/.cache/uv" "${home_dir}/.cache/pip" /tmp/uv-* /tmp/pip-*
}

trap cleanup_caches EXIT

if ! install_requirements "${PRIMARY_REQUIREMENTS}"; then
  if [[ "${SKIP_FALLBACK}" == "1" || "${PRIMARY_REQUIREMENTS}" == "${SECONDARY_REQUIREMENTS}" ]]; then
    exit 1
  fi

  echo "Warning: worker Python install failed for ${PRIMARY_REQUIREMENTS}. Falling back to ${SECONDARY_REQUIREMENTS}." >&2
  install_requirements "${SECONDARY_REQUIREMENTS}"
fi

echo "Worker Python environment is ready at ${VENV}"
echo "Resolved worker requirements mode=${REQUIREMENTS_MODE} primary=${PRIMARY_REQUIREMENTS} fallback=${SECONDARY_REQUIREMENTS}"
echo "Set PYTHON_VENV=${VENV} or keep the repo default (.venv)."
