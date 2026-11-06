#!/usr/bin/env bash
# Build Doppler's command-line utilities (pdfpagecount, pdftotext, pdftoppm, pdfimages, ...) from the public source pinned in
# worker/doppler.json, with the worker images' recipe (worker/Dockerfile.lean, stage doppler-utils), and install them under
# /usr/lib/doppler: off PATH, where the worker looks by default (DOCSLURP_DOPPLER_BIN_DIR=/usr/lib/doppler/bin).
#
#   bash scripts/install-doppler.sh            # CI and Linux developer machines
#
# The source tarball is verified against the pinned sha256 before anything is built. The build is staged under
# DOCSLURP_DOPPLER_STAGE (default ~/.cache/docslurp/doppler-<commit>), so a cached stage is installed without rebuilding.
# The page count also needs prlimit (util-linux); this script checks for it. On Debian/Ubuntu it installs the build
# dependencies with apt when it has to build; elsewhere install the packages listed in BUILD_DEPS' equivalents first.
# Doppler is GPL-2.0-or-later and runs only as separate executables; nothing here links it into DocSlurp.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="$ROOT_DIR/worker/doppler.json"
PREFIX=/usr/lib/doppler
pin() { node -e 'const p = require(process.argv[1]); console.log(process.argv[2].split(".").reduce((v, k) => v[k], p))' "$PIN" "$1"; }
COMMIT="$(pin commit)"
URL="$(pin source.url)"
SHA256="$(pin source.sha256)"
SRC_PREFIX="$(pin source.prefix)"
STAGE="${DOCSLURP_DOPPLER_STAGE:-$HOME/.cache/docslurp/doppler-$COMMIT}"
BUILD_DEPS=(build-essential cmake ninja-build pkg-config ca-certificates curl libfreetype-dev libfontconfig-dev libjpeg-dev
  libopenjp2-7-dev libpng-dev libtiff-dev liblcms2-dev zlib1g-dev libboost-dev)
TOOLS=(pdftotext pdftohtml pdfinfo pdfimages pdftoppm pdfseparate pdfunite pdfpagecount)

as_root() { if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo "$@"; fi; }

staged() {
  [[ -f "$STAGE/.doppler-commit" && "$(cat "$STAGE/.doppler-commit")" == "$COMMIT" ]] || return 1
  for tool in "${TOOLS[@]}"; do [[ -x "$STAGE$PREFIX/bin/$tool" ]] || return 1; done
}

build() {
  if command -v apt-get >/dev/null 2>&1; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -o Acquire::Retries=2
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${BUILD_DEPS[@]}"
  fi
  local work
  work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/doppler-build.XXXXXX")"
  trap 'rm -rf -- "$work"' RETURN
  curl -fsSL --retry 3 -o "$work/src.tar.gz" "$URL"
  echo "$SHA256  $work/src.tar.gz" | sha256sum -c --quiet - || { echo "doppler source sha256 mismatch" >&2; return 1; }
  tar -xzf "$work/src.tar.gz" -C "$work"
  cmake -S "$work/$SRC_PREFIX" -B "$work/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_RPATH="$PREFIX/lib" -DPOPPLER_DATADIR=/usr/share/poppler \
    -DENABLE_QT5=OFF -DENABLE_QT6=OFF -DENABLE_GLIB=OFF -DENABLE_GOBJECT_INTROSPECTION=OFF \
    -DENABLE_CPP=OFF -DENABLE_NSS3=OFF -DENABLE_GPGME=OFF -DENABLE_LIBCURL=OFF \
    -DENABLE_BROTLI=OFF -DENABLE_HARFBUZZ=OFF -DBUILD_GTK_TESTS=OFF -DBUILD_MANUAL_TESTS=OFF \
    -DBUILD_CPP_TESTS=OFF -DENABLE_UNSTABLE_API_ABI_HEADERS=OFF -DRUN_GPERF_IF_PRESENT=OFF
  cmake --build "$work/build" -j"$(nproc)"
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  DESTDIR="$STAGE" cmake --install "$work/build"
  rm -rf "$STAGE$PREFIX/include" "$STAGE$PREFIX/lib/pkgconfig" "$STAGE$PREFIX/lib/cmake" "$STAGE$PREFIX/share/man"
  install -D -m 0644 "$work/$SRC_PREFIX/COPYING" "$STAGE$PREFIX/share/doc/doppler/COPYING"
  echo "$COMMIT" > "$STAGE/.doppler-commit"
}

main() {
  if staged; then echo "Doppler $COMMIT: using the staged build in $STAGE"; else build; fi
  as_root mkdir -p "$PREFIX"
  as_root cp -a "$STAGE$PREFIX/." "$PREFIX/"
  "$PREFIX/bin/pdfpagecount" -v >/dev/null 2>&1 || { echo "$PREFIX/bin/pdfpagecount does not run" >&2; exit 1; }
  command -v prlimit >/dev/null || { echo "prlimit (util-linux) is required for the PDF page count" >&2; exit 1; }
  echo "Doppler $COMMIT installed under $PREFIX (off PATH); pdfpagecount and prlimit are available"
}

main "$@"
