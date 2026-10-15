#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${DOCSLURP_WORKER_VENV:-${ROOT_DIR}/.venv}"
INSTALL_ON_STARTUP="${DOCSLURP_WORKER_INSTALL_HEAVY_DEPS_ON_STARTUP:-true}"
REQUIREMENTS_MODE="${DOCSLURP_WORKER_REQUIREMENTS_MODE:-auto}"
LOCKED_STARTUP_REQUIREMENTS="${ROOT_DIR}/worker/requirements.lock.txt"
LOCKED_FALLBACK_REQUIREMENTS="${ROOT_DIR}/worker/requirements-fallback.lock.txt"
READY_MARKER="${DOCSLURP_WORKER_STARTUP_SENTINEL:-${VENV}/.docslurp-heavy-ready}"
CLAMAV_ENABLED="${DOCSLURP_CLAMAV_ENABLED:-true}"
CLAMAV_MANAGE_DAEMON="${DOCSLURP_CLAMAV_MANAGE_DAEMON:-}"
CLAMAV_REQUIRE_DAEMON="${DOCSLURP_CLAMAV_REQUIRE_DAEMON:-}"
# true = always run freshclam, false = never, if-stale = only when the newest
# signature file is older than DOCSLURP_CLAMAV_UPDATE_IF_OLDER_THAN_HOURS.
# A 125-machine fleet running freshclam on every start gets rate-limited by the
# ClamAV CDN; bake signatures into the image and/or set a private mirror.
CLAMAV_UPDATE_ON_STARTUP="${DOCSLURP_CLAMAV_UPDATE_ON_STARTUP:-if-stale}"
CLAMAV_UPDATE_IF_OLDER_THAN_HOURS="${DOCSLURP_CLAMAV_UPDATE_IF_OLDER_THAN_HOURS:-12}"
CLAMAV_PRIVATE_MIRROR="${DOCSLURP_CLAMAV_PRIVATE_MIRROR:-}"
CLAMAV_FAIL_OPEN_ON_STALE_DB="${DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB:-}"
CLAMAV_MAX_DB_AGE_HOURS="${DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS:-24}"
CLAMAV_DB_DIR="${DOCSLURP_CLAMAV_DB_DIR:-/var/lib/clamav}"
CLAMAV_RUN_DIR="${DOCSLURP_CLAMAV_RUN_DIR:-/run/clamav}"
CLAMAV_LOG_DIR="${DOCSLURP_CLAMAV_LOG_DIR:-/var/log/clamav}"
CLAMAV_CLAMD_CONF="${DOCSLURP_CLAMAV_CLAMD_CONF:-/etc/clamav/clamd.conf}"
CLAMAV_FRESHCLAM_CONF="${DOCSLURP_CLAMAV_FRESHCLAM_CONF:-/etc/clamav/freshclam.conf}"
CLAMD_PID=""
CLAMD_BIN="${DOCSLURP_CLAMD_BIN:-}"

is_production_env() {
  [[ "${NODE_ENV:-}" == "production" ]]
}

default_bool_for_env() {
  local production_value="$1"
  local development_value="$2"

  if is_production_env; then
    echo "${production_value}"
  else
    echo "${development_value}"
  fi
}

if [[ -z "${CLAMAV_MANAGE_DAEMON}" ]]; then
  CLAMAV_MANAGE_DAEMON="$(default_bool_for_env true false)"
fi

if [[ -z "${CLAMAV_REQUIRE_DAEMON}" ]]; then
  CLAMAV_REQUIRE_DAEMON="$(default_bool_for_env true false)"
fi

if [[ -z "${CLAMAV_FAIL_OPEN_ON_STALE_DB}" ]]; then
  CLAMAV_FAIL_OPEN_ON_STALE_DB="$(default_bool_for_env false true)"
fi

bool_env() {
  local value="${1:-}"
  local fallback="${2:-false}"
  local normalized="${value,,}"

  if [[ -z "${normalized}" ]]; then
    normalized="${fallback,,}"
  fi

  case "${normalized}" in
    1|true|yes|on) return 0 ;;
    0|false|no|off) return 1 ;;
    *) [[ "${fallback,,}" == "true" ]] ;;
  esac
}

clamav_warn_or_exit() {
  local message="$1"
  local fail_open="${2:-false}"

  if bool_env "${fail_open}" false; then
    echo "[worker-start] warning: ${message}" >&2
    return 0
  fi

  echo "[worker-start] error: ${message}" >&2
  exit 1
}

clamav_cleanup() {
  if [[ -n "${CLAMD_PID}" ]]; then
    kill "${CLAMD_PID}" >/dev/null 2>&1 || true
  fi
}

trap clamav_cleanup EXIT

requirements_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    cat "$@" | sha256sum | awk '{print $1}'
    return
  fi

  cat "$@" | shasum -a 256 | awk '{print $1}'
}

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

STARTUP_REQUIREMENTS="${DOCSLURP_WORKER_STARTUP_REQUIREMENTS:-$(resolve_default_requirements "${ROOT_DIR}/worker/requirements.txt" "${LOCKED_STARTUP_REQUIREMENTS}")}"
FALLBACK_REQUIREMENTS="${DOCSLURP_WORKER_STARTUP_FALLBACK_REQUIREMENTS:-$(resolve_default_requirements "${ROOT_DIR}/worker/requirements-fallback.txt" "${LOCKED_FALLBACK_REQUIREMENTS}")}"

detect_memory_limit_mb() {
  local candidate raw
  for candidate in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    if [[ ! -r "${candidate}" ]]; then
      continue
    fi

    raw="$(tr -d '\n' < "${candidate}")"
    if [[ -z "${raw}" || "${raw}" == "max" || ! "${raw}" =~ ^[0-9]+$ ]]; then
      continue
    fi

    if (( raw <= 0 || raw > 9000000000000000 )); then
      continue
    fi

    echo $(( raw / 1024 / 1024 ))
    return 0
  done

  if [[ -r /proc/meminfo ]]; then
    raw="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
    if [[ -n "${raw}" && "${raw}" =~ ^[0-9]+$ && "${raw}" -gt 0 ]]; then
      echo $(( raw / 1024 ))
      return 0
    fi
  fi

  return 1
}

configure_runtime_memory_budgets() {
  local memory_limit_mb=""
  local node_old_space_mb=""

  if memory_limit_mb="$(detect_memory_limit_mb 2>/dev/null)"; then
    if [[ -z "${WORKER_NODE_MAX_OLD_SPACE_MB:-}" ]]; then
      node_old_space_mb=$(( memory_limit_mb * 35 / 100 ))
      if (( node_old_space_mb < 768 )); then
        node_old_space_mb=768
      fi
      if (( node_old_space_mb > 1536 )); then
        node_old_space_mb=1536
      fi
      export WORKER_NODE_MAX_OLD_SPACE_MB="${node_old_space_mb}"
    fi

    if [[ -z "${WORKER_COMMAND_MAX_RSS_MB:-}" ]]; then
      local command_rss_budget_mb=$(( memory_limit_mb * 60 / 100 ))
      if (( command_rss_budget_mb < 1024 )); then
        command_rss_budget_mb=1024
      fi
      export WORKER_COMMAND_MAX_RSS_MB="${command_rss_budget_mb}"
    fi
  fi

  if [[ -n "${WORKER_NODE_MAX_OLD_SPACE_MB:-}" && "${NODE_OPTIONS:-}" != *"--max-old-space-size="* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${WORKER_NODE_MAX_OLD_SPACE_MB}"
    NODE_OPTIONS="${NODE_OPTIONS#" "}"
  fi

  echo "[worker-start] memory_limit_mb=${memory_limit_mb:-unknown} node_old_space_mb=${WORKER_NODE_MAX_OLD_SPACE_MB:-auto} command_rss_budget_mb=${WORKER_COMMAND_MAX_RSS_MB:-unbounded}"
}

ensure_clamav_dir() {
  local dir="$1"

  if [[ -d "${dir}" ]]; then
    return 0
  fi

  if mkdir -p "${dir}" 2>/dev/null; then
    return 0
  fi

  clamav_warn_or_exit \
    "ClamAV directory ${dir} is missing and cannot be created by user $(id -un); rebuild the worker image so the directory is created before USER switches to docslurp" \
    "$(default_bool_for_env false true)"
  return 1
}

require_clamav_writable_dir() {
  local dir="$1"
  local purpose="$2"

  if [[ ! -d "${dir}" ]]; then
    clamav_warn_or_exit "ClamAV ${purpose} directory ${dir} is unavailable" "$(default_bool_for_env false true)"
    return 1
  fi

  if [[ ! -w "${dir}" ]]; then
    clamav_warn_or_exit "ClamAV ${purpose} directory ${dir} is not writable by user $(id -un)" "$(default_bool_for_env false true)"
    return 1
  fi
}

prepare_clamav_runtime() {
  local prepared=true

  ensure_clamav_dir "${CLAMAV_DB_DIR}" || prepared=false
  ensure_clamav_dir "${CLAMAV_RUN_DIR}" || prepared=false
  ensure_clamav_dir "${CLAMAV_LOG_DIR}" || prepared=false

  if [[ "${prepared}" != "true" ]]; then
    return 1
  fi

  if [[ "$(id -u)" == "0" ]] && id clamav >/dev/null 2>&1; then
    chown -R clamav:clamav "${CLAMAV_DB_DIR}" "${CLAMAV_RUN_DIR}" "${CLAMAV_LOG_DIR}" >/dev/null 2>&1 || true
  fi

  if [[ "${CLAMAV_UPDATE_ON_STARTUP,,}" != "false" ]]; then
    require_clamav_writable_dir "${CLAMAV_DB_DIR}" "signature database" || prepared=false
    require_clamav_writable_dir "${CLAMAV_LOG_DIR}" "log" || prepared=false
  fi

  if bool_env "${CLAMAV_MANAGE_DAEMON}" false; then
    require_clamav_writable_dir "${CLAMAV_RUN_DIR}" "daemon socket" || prepared=false
    require_clamav_writable_dir "${CLAMAV_LOG_DIR}" "log" || prepared=false
  fi

  [[ "${prepared}" == "true" ]]
}

latest_clamav_signature_epoch() {
  local file mtime latest=0
  shopt -s nullglob
  for file in "${CLAMAV_DB_DIR}"/*.cld "${CLAMAV_DB_DIR}"/*.cvd "${CLAMAV_DB_DIR}"/*.inc; do
    [[ -e "${file}" ]] || continue
    mtime="$(stat -c '%Y' "${file}" 2>/dev/null || stat -f '%m' "${file}" 2>/dev/null || echo 0)"
    if [[ "${mtime}" =~ ^[0-9]+$ ]] && (( mtime > latest )); then
      latest="${mtime}"
    fi
  done
  shopt -u nullglob

  echo "${latest}"
}

verify_clamav_signature_freshness() {
  local latest age_seconds age_hours
  latest="$(latest_clamav_signature_epoch)"

  if [[ -z "${latest}" || "${latest}" == "0" ]]; then
    clamav_warn_or_exit "ClamAV signature database is missing under ${CLAMAV_DB_DIR}" "${CLAMAV_FAIL_OPEN_ON_STALE_DB}"
    return
  fi

  age_seconds=$(( $(date +%s) - latest ))
  if (( age_seconds < 0 )); then
    age_seconds=0
  fi
  age_hours=$(( age_seconds / 3600 ))

  if (( age_hours > CLAMAV_MAX_DB_AGE_HOURS )); then
    clamav_warn_or_exit \
      "ClamAV signature database is stale (${age_hours}h old, max ${CLAMAV_MAX_DB_AGE_HOURS}h)" \
      "${CLAMAV_FAIL_OPEN_ON_STALE_DB}"
    return
  fi

  echo "[worker-start] clamav signatures age_hours=${age_hours} max_age_hours=${CLAMAV_MAX_DB_AGE_HOURS}"
}

run_clamav_command() {
  # Antivirus processes do not need database, object-store or AI credentials.
  env -i PATH="${PATH}" HOME="${HOME:-/tmp}" LANG="${LANG:-C.UTF-8}" TZ="${TZ:-UTC}" "$@"
}

clamav_signature_age_hours() {
  local latest
  latest="$(latest_clamav_signature_epoch)"
  if [[ -z "${latest}" || "${latest}" == "0" ]]; then
    echo 999999
    return
  fi
  echo $(( ( $(date +%s) - latest ) / 3600 ))
}

clamav_update_wanted() {
  case "${CLAMAV_UPDATE_ON_STARTUP,,}" in
    if-stale|stale|auto)
      local age_hours
      age_hours="$(clamav_signature_age_hours)"
      if (( age_hours < CLAMAV_UPDATE_IF_OLDER_THAN_HOURS )); then
        echo "[worker-start] clamav signatures age_hours=${age_hours} < ${CLAMAV_UPDATE_IF_OLDER_THAN_HOURS}; skipping freshclam"
        return 1
      fi
      return 0
      ;;
    *)
      bool_env "${CLAMAV_UPDATE_ON_STARTUP}" true
      ;;
  esac
}

freshclam_config_file() {
  if [[ -z "${CLAMAV_PRIVATE_MIRROR}" ]]; then
    echo "${CLAMAV_FRESHCLAM_CONF}"
    return
  fi
  # A shared mirror (e.g. cvdupdate behind object storage) serves the fleet; the
  # public CDN is then hit once per update, not once per machine start.
  local conf="${CLAMAV_RUN_DIR}/freshclam.mirror.conf"
  grep -Ev '^[[:space:]]*(DatabaseMirror|PrivateMirror|ScriptedUpdates)[[:space:]]' "${CLAMAV_FRESHCLAM_CONF}" > "${conf}"
  printf 'PrivateMirror %s\nScriptedUpdates no\n' "${CLAMAV_PRIVATE_MIRROR}" >> "${conf}"
  echo "${conf}"
}

run_freshclam_update() {
  if ! clamav_update_wanted; then
    return
  fi

  if ! command -v freshclam >/dev/null 2>&1; then
    clamav_warn_or_exit "freshclam is unavailable" "$(default_bool_for_env false true)"
    return
  fi

  echo "[worker-start] refreshing ClamAV signatures mirror=${CLAMAV_PRIVATE_MIRROR:-default}"
  if ! run_clamav_command freshclam --stdout --config-file="$(freshclam_config_file)"; then
    # A failed refresh (mirror cool-down, 429) is fine while the existing
    # signatures are within DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS; the freshness
    # check below still fails closed when they are not.
    if (( $(clamav_signature_age_hours) <= CLAMAV_MAX_DB_AGE_HOURS )); then
      echo "[worker-start] warning: freshclam failed; continuing with existing signatures" >&2
      return
    fi
    clamav_warn_or_exit "freshclam failed to update signatures" "$(default_bool_for_env false true)"
  fi
}

wait_for_clamd() {
  local retries="${1:-30}"
  local attempt

  if ! command -v clamdscan >/dev/null 2>&1; then
    return 1
  fi

  for (( attempt = 1; attempt <= retries; attempt += 1 )); do
    if run_clamav_command clamdscan --config-file="${CLAMAV_CLAMD_CONF}" --ping=1 >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  return 1
}

ensure_clamd_ready() {
  if ! bool_env "${CLAMAV_REQUIRE_DAEMON}" false && ! bool_env "${CLAMAV_MANAGE_DAEMON}" false; then
    return
  fi

  if bool_env "${CLAMAV_MANAGE_DAEMON}" false; then
    if [[ -z "${CLAMD_BIN}" ]]; then
      CLAMD_BIN="$(command -v clamd || true)"
    fi
    if [[ -z "${CLAMD_BIN}" && -x /usr/sbin/clamd ]]; then
      CLAMD_BIN="/usr/sbin/clamd"
    fi
    if [[ -z "${CLAMD_BIN}" ]]; then
      clamav_warn_or_exit "clamd binary is unavailable" false
      return
    fi

    echo "[worker-start] starting clamd"
    run_clamav_command "${CLAMD_BIN}" --foreground=true --config-file="${CLAMAV_CLAMD_CONF}" &
    CLAMD_PID="$!"
  fi

  if wait_for_clamd "${DOCSLURP_CLAMAV_READY_TIMEOUT_SECONDS:-180}"; then
    echo "[worker-start] clamd is ready"
    return
  fi

  clamav_warn_or_exit "clamd did not become ready via clamdscan --ping" false
}

bootstrap_clamav() {
  if ! bool_env "${CLAMAV_ENABLED}" true; then
    return
  fi

  prepare_clamav_runtime || return
  run_freshclam_update
  verify_clamav_signature_freshness
  ensure_clamd_ready
}

bootstrap_deferred_python() {
  local expected_hash
  local current_hash=""

  if [[ ! -f "${STARTUP_REQUIREMENTS}" ]]; then
    echo "[worker-start] worker requirements file not found: ${STARTUP_REQUIREMENTS}" >&2
    exit 1
  fi

  if [[ ! -f "${FALLBACK_REQUIREMENTS}" ]]; then
    echo "[worker-start] worker fallback requirements file not found: ${FALLBACK_REQUIREMENTS}" >&2
    exit 1
  fi

  expected_hash="$(requirements_hash "${STARTUP_REQUIREMENTS}" "${FALLBACK_REQUIREMENTS}")"
  if [[ -f "${READY_MARKER}" ]]; then
    current_hash="$(tr -d '\n' < "${READY_MARKER}")"
  fi

  if [[ "${current_hash}" == "${expected_hash}" ]]; then
    echo "[worker-start] deferred Python deps already present (${expected_hash})."
    return
  fi

  echo "[worker-start] installing deferred Python deps from ${STARTUP_REQUIREMENTS} (mode=${REQUIREMENTS_MODE})"
  DOCSLURP_ROOT_DIR="${ROOT_DIR}" \
  DOCSLURP_WORKER_VENV="${VENV}" \
  DOCSLURP_WORKER_REQUIREMENTS_FILE="${STARTUP_REQUIREMENTS}" \
  DOCSLURP_WORKER_FALLBACK_REQUIREMENTS_FILE="${FALLBACK_REQUIREMENTS}" \
  bash "${ROOT_DIR}/scripts/setup-worker-python-venv.sh"

  mkdir -p "$(dirname "${READY_MARKER}")"
  printf '%s\n' "${expected_hash}" > "${READY_MARKER}"
}

if [[ "${INSTALL_ON_STARTUP}" != "false" ]]; then
  bootstrap_deferred_python
fi

profile="${DOCSLURP_DEPLOYMENT_PROFILE:-heavy}"
if [[ "${profile}" == "lean" ]]; then
  node "${ROOT_DIR}/scripts/check-worker-prerequisites.mjs" --profile=lean --sandbox
else
  node "${ROOT_DIR}/scripts/check-worker-prerequisites.mjs" --profile=full --sandbox
fi

bootstrap_clamav

configure_runtime_memory_budgets

exec node "${ROOT_DIR}/worker/dist/temporal/worker.js"
