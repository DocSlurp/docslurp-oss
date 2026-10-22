#!/usr/bin/env bash
# Build one vendor bundle archive (docs/worker-image.md#vendor-bundles).
#
#   bash scripts/vendor-bundles/build.sh <bundle> <out-dir> [repo-root]
#
# Runs inside worker/Dockerfile.bundles (same pinned base image as the worker,
# so the bundle targets the worker's exact python3 and glibc). Produces:
#   <out-dir>/<bundle>-<platform>.tar.zst   normalised tar (sorted, mtime 0, uid 0), zstd -19
#   <out-dir>/<bundle>-<platform>.json      manifest entry: platform, sha256, size, unpackedSize
#
# Bundle layout (relocatable; the worker unpacks it anywhere):
#   site-packages/   wheel-only `--target` install, CPU-only torch, deduplicated
#                    against the image's base venv, bytecode compiled with
#                    unchecked-hash so it stays valid after unpacking
#   bin/<tool>       python shims that put ../site-packages first on sys.path
#   models/          model weights fetched at build time (the parser sandbox has no network)
set -euo pipefail

NAME="${1:?bundle name}"
OUT="${2:?output dir}"
REPO="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BASE_VENV="${DOCSLURP_BUNDLE_BASE_VENV:-/app/.venv}"
UV_VERSION="${DOCSLURP_BUNDLE_UV_VERSION:-0.13.0}"
REQUIREMENTS="${REPO}/worker/requirements-bundle-${NAME}.txt"
# Fixed build path: bytecode records its source path, so a random temp dir would
# make every build's archive differ.
ROOT="/tmp/docslurp-vendor-bundle/${NAME}"
rm -rf "${ROOT}"
SITE="${ROOT}/site-packages"

[[ "${NAME}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "invalid bundle name ${NAME}" >&2; exit 2; }
[[ -f "${REQUIREMENTS}" ]] || { echo "missing ${REQUIREMENTS}" >&2; exit 2; }

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 2 ;;
esac
PY_MINOR="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
PLATFORM="linux-${ARCH}-py${PY_MINOR}"
mkdir -p "${OUT}" "${SITE}" "${ROOT}/bin" "${ROOT}/models"

# Pinned uv in a throwaway venv (not shipped).
python3 -m venv /tmp/uv-venv
/tmp/uv-venv/bin/pip install --quiet --no-cache-dir --only-binary=:all: "uv==${UV_VERSION}"
UV=/tmp/uv-venv/bin/uv

# Drop the GUI OpenCV build (needs libGL); the headless wheel provides the same cv2 module.
# Drop pypandoc-binary (a 155 MB second copy of pandoc); the plain pypandoc wrapper
# uses the image's /usr/bin/pandoc, which the parser sandbox already mounts.
printf '%s\n' "opencv-python; sys_platform == 'never'" "pypandoc-binary; sys_platform == 'never'" > /tmp/overrides.txt
extra=()
if grep -q '^unstructured' "${REQUIREMENTS}"; then extra+=(opencv-python-headless pypandoc); fi
# Wheels only, except pure-Python packages a requirements file explicitly allows
# ("# docslurp: allow-sdist <pkg> ...") because upstream publishes no wheel.
sdist=()
for package in $(sed -n 's/^# docslurp: allow-sdist //p' "${REQUIREMENTS}"); do sdist+=(--no-binary "${package}"); done

# Shared packages resolve to the image's base versions so dedupe can drop them.
"${UV}" pip install \
  --python "$(command -v python3)" \
  --target "${SITE}" \
  --torch-backend cpu \
  --only-binary :all: "${sdist[@]}" \
  --no-cache --link-mode copy --no-compile \
  --constraints "${REPO}/worker/requirements-base.lock.txt" \
  --overrides /tmp/overrides.txt \
  -r "${REQUIREMENTS}" "${extra[@]}"

# Fail if anything GPU-only slipped in.
if ls "${SITE}" | grep -Ei '^(nvidia|triton|cuda|cupy)' ; then
  echo "GPU packages found in ${NAME} bundle; refusing" >&2
  exit 1
fi

# Dedupe: delete distributions the base venv already ships at the same version.
python3 - "${SITE}" "${BASE_VENV}" <<'PY'
import csv, os, pathlib, shutil, sys, sysconfig
site, base_venv = map(pathlib.Path, sys.argv[1:3])
base_sites = list(base_venv.glob("lib/python3*/site-packages"))
base = {p.name.lower() for s in base_sites for p in s.glob("*.dist-info")}
removed = 0
for info in sorted(site.glob("*.dist-info")):
    if info.name.lower() not in base:
        continue
    record = info / "RECORD"
    for row in csv.reader(record.read_text().splitlines()) if record.exists() else []:
        target = (site / row[0]).resolve()
        if target.is_relative_to(site.resolve()) and target.is_file():
            removed += target.stat().st_size
            target.unlink()
    shutil.rmtree(info, ignore_errors=True)
# Empty package directories left behind.
for directory in sorted((p for p in site.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
    if not any(directory.iterdir()):
        directory.rmdir()
print(f"[bundle] dedupe removed {removed / 1048576:.1f} MiB already in {base_venv}")
PY

# Console scripts written by --target hard-code the build interpreter; the shims below replace them.
rm -rf "${SITE}/bin"

write_shim() {
  local tool="$1" module="$2" func="$3"
  cat > "${ROOT}/bin/${tool}" <<SHIM
#!/usr/bin/env python3
# DocSlurp vendor bundle shim: runs ${module}:${func} from this bundle's site-packages.
import os, sys
_root = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(_root, "site-packages"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
from ${module} import ${func} as _main
sys.exit(_main())
SHIM
  chmod 0755 "${ROOT}/bin/${tool}"
}

export PYTHONPATH="${SITE}"
export HF_HOME="${ROOT}/models/hf"
case "${NAME}" in
  unstructured)
    # hi_res layout detection model (unstructured-inference default), pre-fetched for the network-less sandbox.
    "${BASE_VENV}/bin/python" - <<'PY'
from unstructured_inference.models.base import get_model
get_model()
print("[bundle] fetched unstructured-inference default layout model")
PY
    ;;
esac
rm -rf "${ROOT}/models/hf/xet" "${ROOT}/models/hf/hub/.locks"

# Trim and precompile. unchecked-hash pycs stay valid after unpacking, when mtimes change.
find "${SITE}" -depth -type d \( -name tests -o -name test -o -name __pycache__ \) -prune -exec rm -rf {} +
find "${SITE}" -name '*.pyi' -delete
python3 -m compileall -q -j 0 -o 0 --invalidation-mode unchecked-hash -s "${SITE}" -p "site-packages" "${SITE}" >/dev/null || true

# Smoke test with only the bundle + base venv, like the worker runs it. The parser
# sandbox has no network and mounts the venv and bundle read-only: a dead proxy
# blocks downloads here, and the test fails if anything was written into the base
# venv or the bundle at runtime. HOME is a throwaway dir, as in the sandbox.
unset PYTHONPATH HF_HOME
SMOKE="$(mktemp -d)"
SMOKE_HOME="$(mktemp -d)"
touch "${SMOKE}/.before"
export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 NO_PROXY= no_proxy=
# A one-page text PDF written by hand (no PDF library in the base venv).
"${BASE_VENV}/bin/python" - "${SMOKE}/smoke.pdf" <<'PY'
import sys
lines = [(18, 72, 720, "Vendor bundle smoke test"), (11, 72, 682, "Quarter  Revenue"), (11, 72, 668, "Q1  10"), (11, 72, 654, "Q2  12")]
content = "".join(f"BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm ({text}) Tj ET\n" for size, x, y, text in lines).encode("latin-1")
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
]
out, offsets = bytearray(b"%PDF-1.4\n"), []
for number, body in enumerate(objects, 1):
    offsets.append(len(out))
    out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
xref = len(out)
out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
open(sys.argv[1], "wb").write(out)
PY
case "${NAME}" in
  unstructured)
    HOME="${SMOKE_HOME}" PYTHONPATH="${SITE}" HF_HUB_OFFLINE=1 HF_HOME="${ROOT}/models/hf" timeout 600 "${BASE_VENV}/bin/python" - "${SMOKE}/smoke.pdf" <<'PY'
import sys
from unstructured.partition.pdf import partition_pdf
from unstructured_inference.models.base import get_model
get_model()
elements = partition_pdf(filename=sys.argv[1], strategy="fast")
assert any("smoke test" in str(element) for element in elements), elements
import pypandoc
assert pypandoc.get_pandoc_path(), "pandoc not found for unstructured's Office/EPUB partitioners"
print("[bundle] unstructured offline partition + layout model load ok")
PY
    ;;
esac
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
# numba's JIT cache (*.nbi/*.nbc) falls back to a user cache dir when the package
# dir is read-only, so it is not an offline failure; drop it to keep the archive
# deterministic.
find "${ROOT}" -type f \( -name '*.nbi' -o -name '*.nbc' \) -delete
fetched="$(find "${BASE_VENV}" "${ROOT}" -newer "${SMOKE}/.before" -type f ! -name '*.pyc' 2>/dev/null | head -20)"
if [[ -n "${fetched}" ]]; then
  echo "[bundle] ${NAME} wrote into the read-only venv/bundle at runtime (fails in the sandbox):" >&2
  echo "${fetched}" >&2
  exit 1
fi
rm -rf "${SMOKE}" "${SMOKE_HOME}"

UNPACKED="$(find "${ROOT}" -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')"
ARCHIVE="${OUT}/${NAME}-${PLATFORM}.tar.zst"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --hard-dereference \
    --format=pax --pax-option=delete=atime,delete=ctime \
    -C "${ROOT}" -cf - . | zstd -q -19 -T0 -o "${ARCHIVE}"
SHA="$(sha256sum "${ARCHIVE}" | cut -d' ' -f1)"
SIZE="$(stat -c %s "${ARCHIVE}")"
cat > "${OUT}/${NAME}-${PLATFORM}.json" <<JSON
{"bundle":"${NAME}","platform":"${PLATFORM}","sha256":"${SHA}","size":${SIZE},"unpackedSize":${UNPACKED},"file":"$(basename "${ARCHIVE}")"}
JSON
echo "[bundle] ${NAME} ${PLATFORM}: archive $((SIZE / 1048576)) MiB, unpacked $((UNPACKED / 1048576)) MiB, sha256 ${SHA}"
echo "[bundle] largest top-level entries (MiB):"
du -sm "${SITE}"/* "${ROOT}/models"/* 2>/dev/null | sort -rn | head -25
