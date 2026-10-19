#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: parser-sandbox.sh <binary> [args...]" >&2
  exit 64
fi

umask 077

SANDBOX_ROOT="${DOCSLURP_PARSER_SANDBOX_ROOT:-/tmp/docslurp-parser-sandbox}"
# The worker creates its private scratch workspaces under the host temp root,
# which follows TMPDIR and is not always /tmp. TMPDIR is rewritten below.
HOST_TMP_ROOT="${DOCSLURP_PARSER_SANDBOX_TMP_ROOT:-${TMPDIR:-/tmp}}"
HOST_TMP_ROOT="${HOST_TMP_ROOT%/}"
[[ -n "${HOST_TMP_ROOT}" ]] || HOST_TMP_ROOT=/tmp
SANDBOX_MODE="${DOCSLURP_PARSER_SANDBOX_MODE:-isolated}"
WRITABLE_PATHS_RAW="${DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS:-}"
mkdir -p "${SANDBOX_ROOT}"
SANDBOX_INSTANCE="$(mktemp -d "${SANDBOX_ROOT%/}/run-XXXXXX")"

cleanup() {
  rm -rf "${SANDBOX_INSTANCE}"
}

trap cleanup EXIT INT TERM

export HOME="${SANDBOX_INSTANCE}/home"
export TMPDIR="${SANDBOX_INSTANCE}/tmp"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"
export XDG_CACHE_HOME="${SANDBOX_INSTANCE}/xdg-cache"
export XDG_CONFIG_HOME="${SANDBOX_INSTANCE}/xdg-config"
export XDG_DATA_HOME="${SANDBOX_INSTANCE}/xdg-data"

mkdir -p "${HOME}" "${TMPDIR}" "${XDG_CACHE_HOME}" "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}" "${SANDBOX_INSTANCE}/work"
cd "${SANDBOX_INSTANCE}/work"

if [[ "${SANDBOX_MODE}" != "isolated" ]]; then
  exec "$@"
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo "[parser-sandbox] bubblewrap unavailable; refusing to run parser without isolation" >&2
  exit 70
fi

bwrap_args=(
  --die-with-parent
  --new-session
  --unshare-net
  --unshare-pid
  --unshare-ipc
  --unshare-uts
  --cap-drop ALL
  --tmpfs /tmp
  --bind "${SANDBOX_INSTANCE}" "${SANDBOX_INSTANCE}"
  --proc /proc
  --dev /dev
  --chdir "${PWD}"
  --setenv HOME "${HOME}"
  --setenv TMPDIR "${TMPDIR}"
  --setenv TMP "${TMP}"
  --setenv TEMP "${TEMP}"
  --setenv XDG_CACHE_HOME "${XDG_CACHE_HOME}"
  --setenv XDG_CONFIG_HOME "${XDG_CONFIG_HOME}"
  --setenv XDG_DATA_HOME "${XDG_DATA_HOME}"
)

# Start from an empty filesystem. Never expose worker credentials, other jobs,
# host process environments, or the complete application checkout.
# /etc/alternatives holds only Debian alternatives symlinks; shared libraries
# such as ffmpeg's libblas.so.3 resolve through it.
for runtime_path in /usr /bin /sbin /lib /lib64 /etc/ld.so.cache /etc/alternatives /etc/fonts /etc/ssl /etc/localtime /etc/passwd /etc/group /etc/ImageMagick-6 /etc/ImageMagick-7 /var/cache/fontconfig; do
  if [[ -e "${runtime_path}" ]]; then
    bwrap_args+=(--ro-bind "${runtime_path}" "${runtime_path}")
  fi
done
IFS=',' read -r -a readable_paths <<< "${DOCSLURP_PARSER_SANDBOX_READABLE_PATHS:-}"
for readable_path in "${readable_paths[@]}"; do
  if [[ -n "${readable_path}" && -e "${readable_path}" ]]; then
    bwrap_args+=(--ro-bind "${readable_path}" "${readable_path}")
  fi
done

IFS=',' read -r -a writable_paths <<< "${WRITABLE_PATHS_RAW}"
for raw_path in "${writable_paths[@]}"; do
  writable_path="$(printf '%s' "${raw_path}" | xargs)"
  if [[ -z "${writable_path}" ]]; then
    continue
  fi
  case "${writable_path}" in
    /tmp/docslurp-*|/tmp/docslurp-*/*) ;;
    "${HOST_TMP_ROOT}"/docslurp-*) ;;
    *) echo "[parser-sandbox] refusing broad writable mount" >&2; exit 70 ;;
  esac
  if [[ "${writable_path}" == *"/../"* || "${writable_path}" == */.. ]]; then
    echo "[parser-sandbox] refusing traversal in writable mount" >&2; exit 70
  fi
  if [[ ! -e "${writable_path}" ]]; then
    case "${writable_path}" in
      /tmp/docslurp-*|/tmp/docslurp-*/*|"${HOST_TMP_ROOT}"/docslurp-*)
        mkdir -p "${writable_path}"
        ;;
      *)
        continue
        ;;
    esac
  fi
  bwrap_args+=(--bind "${writable_path}" "${writable_path}")
done

bwrap "${bwrap_args[@]}" -- "$@"
