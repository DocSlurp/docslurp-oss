#!/usr/bin/env bash
# Public downloads and local Docker only. Never pushes or starts a cloud job.
set -euo pipefail
export TMPDIR="${TMPDIR:-/home/dan/tmp/agents}" TMP="${TMP:-/home/dan/tmp/agents}" TEMP="${TEMP:-/home/dan/tmp/agents}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
output="${1:?Usage: build.sh ABSOLUTE_DURABLE_OUTPUT_DIRECTORY}"
[[ "$output" = /* && ! -e "$output" ]] || { echo 'Output must be a new absolute directory' >&2; exit 1; }
: "${UV:=uv}"
base='python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1'
revision='8ac289e66575bb9bba6e15c53719d8b15cc9b3b2'
scratch="$(mktemp -d "$TMPDIR/document-vm-build.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$output"
"$UV" venv --python 3.12 "$scratch/export-env"
"$UV" pip install --python "$scratch/export-env/bin/python" --require-hashes -r "$repo/scripts/document-vm/export-requirements.lock"
"$scratch/export-env/bin/python" "$repo/scripts/layout-eval/export_pp_small.py" --revision "$revision" \
  --download --model-dir "$scratch/source" --output "$scratch/model.onnx" > "$output/export.log" 2>&1
# HF README at the pinned source declares Apache-2.0. Retain the full license text.
"$scratch/export-env/bin/python" -c 'import urllib.request,sys; open(sys.argv[1],"wb").write(urllib.request.urlopen("https://www.apache.org/licenses/LICENSE-2.0.txt",timeout=30).read())' "$scratch/LICENSE.Apache-2.0"
"$scratch/export-env/bin/python" "$repo/scripts/document-vm/prepare.py" --graph "$scratch/model.onnx" \
  --source "$scratch/source" --license "$scratch/LICENSE.Apache-2.0" --context "$scratch/context"
cp "$repo/scripts/document-vm/requirements.lock" "$scratch/context/requirements.lock"
mkdir "$scratch/context/wheels"
docker run --rm -e TMPDIR=/job -v "$scratch/context:/job" "$base" python3 -m pip download \
  --only-binary=:all: --require-hashes -r /job/requirements.lock -d /job/wheels
docker build --tag docslurp-document-vm:local "$scratch/context" > "$output/build.log" 2>&1
"$scratch/export-env/bin/python" "$repo/scripts/document-vm/validate.py" --image docslurp-document-vm:local \
  --job "$scratch/job" --evidence "$output"
docker buildx build --provenance=mode=max --sbom=true --output "type=oci,dest=$output/document-vm.oci.tar" \
  --metadata-file "$output/build-metadata.json" "$scratch/context" > "$output/oci-build.log" 2>&1
cp "$scratch/model.provenance.json" "$output/export-provenance.json"
du -sb "$scratch" > "$output/transient-disk.txt"
docker image inspect docslurp-document-vm:local > "$output/local-image-inspect.json"
python3 "$repo/scripts/document-vm/inspect_oci.py" "$output/document-vm.oci.tar" "$output"
