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
WRITABLE_PATHS_RAW="${DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS:-}"
mkdir -p "${SANDBOX_ROOT}"
# The worker creates the instance (and its owner file) so it can remove both once the command's
# teardown is verified, even if this launcher was SIGKILLed before its EXIT trap ran.
if [[ -n "${DOCSLURP_PARSER_SANDBOX_INSTANCE:-}" ]]; then
  SANDBOX_INSTANCE="${DOCSLURP_PARSER_SANDBOX_INSTANCE}"
  instance_name="${SANDBOX_INSTANCE#"${SANDBOX_ROOT%/}"/}"
  if [[ "${instance_name}" == "${SANDBOX_INSTANCE}" || ! "${instance_name}" =~ ^run-[A-Za-z0-9]+$ \
        || -L "${SANDBOX_INSTANCE}" || ! -d "${SANDBOX_INSTANCE}" || ! -O "${SANDBOX_INSTANCE}" ]]; then
    echo "[parser-sandbox] refusing instance directory outside the sandbox root" >&2
    exit 70
  fi
else
  SANDBOX_INSTANCE="$(mktemp -d "${SANDBOX_ROOT%/}/run-XXXXXX")"
fi

cleanup() {
  rm -rf "${SANDBOX_INSTANCE}"
  rm -f "${SANDBOX_INSTANCE}.owner"
}

trap cleanup EXIT
# Until bwrap starts there is nothing to stop: a signal ends the launcher and EXIT cleans up.
trap 'exit 143' TERM
trap 'exit 130' INT

export HOME="${SANDBOX_INSTANCE}/home"
export TMPDIR="${SANDBOX_INSTANCE}/tmp"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"
export XDG_CACHE_HOME="${SANDBOX_INSTANCE}/xdg-cache"
export XDG_CONFIG_HOME="${SANDBOX_INSTANCE}/xdg-config"
export XDG_DATA_HOME="${SANDBOX_INSTANCE}/xdg-data"

mkdir -p "${HOME}" "${TMPDIR}" "${XDG_CACHE_HOME}" "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}" "${SANDBOX_INSTANCE}/work"
cd "${SANDBOX_INSTANCE}/work"

# Only the bubblewrap provider runs this launcher, and it always isolates: there is
# no unisolated mode. Without bwrap, refuse to run the parser.
if ! command -v bwrap >/dev/null 2>&1; then
  echo "[parser-sandbox] bubblewrap unavailable; refusing to run parser without isolation" >&2
  exit 70
fi
# The sandbox never gets the worker's stdio: stdio-relay.pl runs bwrap on pipes of its own and
# copies the output, so a descriptor the parser parks somewhere (an SCM_RIGHTS garbage cycle the
# kernel frees seconds later) holds only the relay's pipe, and the worker's pipes close when the
# relay exits after bwrap. Without perl or the relay, refuse to run.
STDIO_RELAY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/stdio-relay.pl"
if ! command -v perl >/dev/null 2>&1 || [[ ! -f "${STDIO_RELAY}" ]]; then
  echo "[parser-sandbox] stdio relay unavailable (perl or ${STDIO_RELAY}); refusing to run parser" >&2
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
# such as ffmpeg's libblas.so.3 resolve through it. Debian LibreOffice also
# links its packaged registry and printer configuration into /etc/libreoffice.
for runtime_path in /usr /bin /sbin /lib /lib64 /etc/ld.so.cache /etc/alternatives /etc/libreoffice /etc/fonts /etc/ssl /etc/localtime /etc/passwd /etc/group /etc/ImageMagick-6 /etc/ImageMagick-7 /var/cache/fontconfig; do
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

# The relay (with bwrap under it) runs in the background so a TERM or INT to this launcher reaches
# bwrap at once: bash defers traps while a foreground child runs, which left the parser running
# after the worker signalled us. bwrap exits on TERM; --die-with-parent and the PID namespace then
# take the whole parser tree with it. Async jobs ignore SIGINT in a non-interactive shell, so both
# signals forward as TERM. The EXIT trap still removes the instance directory, after bwrap exited.
# A seccomp filter the worker wrote (sandbox/seccomp.ts: io_uring denied, and for socketless tools
# socket/socketpair(AF_UNIX) too). The worker's bubblewrap provider passes one for every command. It
# is opened here, outside the sandbox, and bwrap installs it for the parser.
SECCOMP_FILE="${DOCSLURP_PARSER_SANDBOX_SECCOMP:-}"
if [[ -n "${SECCOMP_FILE}" ]]; then
  # Directly inside the sandbox root (a `*` in a [[ ]] pattern would also match `/` and `..`).
  if [[ "$(dirname -- "${SECCOMP_FILE}")" != "${SANDBOX_ROOT%/}" || "$(basename -- "${SECCOMP_FILE}")" != seccomp-*.bpf \
        || -L "${SECCOMP_FILE}" \
        || ! -f "${SECCOMP_FILE}" || ! -O "${SECCOMP_FILE}" ]]; then
    echo "[parser-sandbox] refusing seccomp filter outside the sandbox root" >&2
    exit 70
  fi
  exec 9<"${SECCOMP_FILE}"
  bwrap_args+=(--seccomp 9)
fi

# The relay forwards TERM (and INT, HUP) to bwrap and exits with bwrap's status.
perl -- "${STDIO_RELAY}" bwrap "${bwrap_args[@]}" -- "$@" &
relay_pid=$!
# bwrap has read the filter (or will from its own copy of fd 9); the launcher needs no copy.
if [[ -n "${SECCOMP_FILE}" ]]; then exec 9<&-; fi
forward_term() {
  kill -TERM "${relay_pid}" 2>/dev/null || true
}
trap forward_term INT TERM
status=0
# wait returns early (status > 128) when a trapped signal arrives; keep waiting until the relay
# (and so bwrap) is gone. Stop on 127 (the relay was already reaped; keep the status we had) and on
# any status <= 128, which is the relay's own exit status (bwrap's): kill -0 alone could spin if
# its pid were reused.
while :; do
  wait "${relay_pid}" && waited=0 || waited=$?
  if (( waited == 127 )); then break; fi
  status=${waited}
  if (( waited <= 128 )); then break; fi
  kill -0 "${relay_pid}" 2>/dev/null || break
done
exit "${status}"
