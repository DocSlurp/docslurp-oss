#!/usr/bin/env bash
# Install pinned gitleaks + trufflehog (linux x86_64) into a bin dir with sha256 verification.
# Usage: install-scanners.sh [bin-dir]   (default: ./.scratch/bin). Also exported as scripts/install-scanners.sh.
# Hashes are pinned from the upstream *_checksums.txt of each release.
set -euo pipefail
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
TRUFFLEHOG_VERSION=3.99.2
TRUFFLEHOG_SHA256=3c7b0d1dc4278294269bfdd7594bca8bb28c78da0a4a06ad202ded37b48deca4

fetch() { # browser-url sha256 dest-file pinned-public-asset-api-url
  # Public release endpoints only: no token is needed or forwarded to redirects.
  # Both routes identify the same pinned asset; integrity failure is never retried
  # through a different route. Bound connection, transfer and retry time.
  local args=(-fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-max-time 60)
  if ! curl "${args[@]}" -o "$3" "$1"; then
    echo "release download failed; trying the pinned public asset API" >&2
    curl "${args[@]}" -H 'Accept: application/octet-stream' -o "$3" "$4" || return 1
  fi
  echo "$2  $3" | sha256sum -c - >/dev/null || { echo "checksum mismatch for $1" >&2; return 1; }
}

main() {
  bin="${1:-$PWD/.scratch/bin}"
  mkdir -p "$bin"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  # API asset IDs are pinned alongside their release versions and checksums.
  if ! "$bin/gitleaks" version 2>/dev/null | grep -q "$GITLEAKS_VERSION"; then
    fetch "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" "$GITLEAKS_SHA256" "$work/gl.tgz" \
      'https://api.github.com/repos/gitleaks/gitleaks/releases/assets/378332058'
    tar -xzf "$work/gl.tgz" -C "$work" gitleaks && install -m 0755 "$work/gitleaks" "$bin/gitleaks"
  fi
  if ! "$bin/trufflehog" --version 2>&1 | grep -q "$TRUFFLEHOG_VERSION"; then
    fetch "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_linux_amd64.tar.gz" "$TRUFFLEHOG_SHA256" "$work/th.tgz" \
      'https://api.github.com/repos/trufflesecurity/trufflehog/releases/assets/622011676'
    tar -xzf "$work/th.tgz" -C "$work" trufflehog && install -m 0755 "$work/trufflehog" "$bin/trufflehog"
  fi
  "$bin/gitleaks" version
  "$bin/trufflehog" --version 2>&1 | head -1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
