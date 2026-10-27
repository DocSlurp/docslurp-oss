#!/usr/bin/env bash
# CI-only: two bounded attempts, retaining Ubuntu archive signature verification.
set -euo pipefail

packages=(bubblewrap poppler-data poppler-utils pandoc tesseract-ocr tesseract-ocr-eng ffmpeg)
# Pass packages as positional arguments, rather than through shell interpolation.
bounded_install() {
  sudo timeout --signal=TERM --kill-after=15s 5m bash -euc '
    export DEBIAN_FRONTEND=noninteractive
    count="$1"; shift
    options=("${@:1:count}"); shift "$count"
    apt-get "${options[@]}" update --error-on=any
    apt-get "${options[@]}" install -y --no-install-recommends "$@"
  ' -- "$#" "$@" "${packages[@]}"
}
assert_supported_runner() {
# This fallback is intentionally restricted to the CI runner's supported release/architecture.
. /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 || "$(dpkg --print-architecture)" != amd64 ]]; then
  echo "Unsupported runner for Ubuntu mirror fallback" >&2
  return 1
fi
}

main() {
network=(-o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
if bounded_install "${network[@]}"; then
  return 0
fi

echo "::warning::Default apt sources failed or exceeded five minutes; retrying official Ubuntu mirrors once"
assert_supported_runner
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:?Set TMPDIR or RUNNER_TEMP}}/worker-test-apt.XXXXXX")
trap 'sudo rm -rf -- "$scratch"' EXIT
chmod 755 "$scratch"
mkdir -p "$scratch/lists/partial"
cat > "$scratch/ubuntu.sources" <<'SOURCES'
Types: deb
URIs: https://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
bounded_install "${network[@]}" \
  -o "Dir::Etc::sourcelist=$scratch/ubuntu.sources" \
  -o Dir::Etc::sourceparts=- \
  -o "Dir::State::lists=$scratch/lists"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
