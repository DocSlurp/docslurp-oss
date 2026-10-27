# Image layout VM contract

Production layout inference uses one fresh CPU VM per raster. `detectImageLayoutAtEndpoint` retains its API name but accepts only `modal-vm://layout`; the old loopback HTTP service is refused. Both transports stage opaque source bytes and require model/revision/artifact/profile identity. No host image decoder runs on these paths. CUDA, including device aliases, is explicitly unsupported because the required Modal VM runtime does not support GPU allocation.

`CommandRunner` dispatches `documentVm` plans before activity scopes, local providers, vector writers and vendor bundles. The guest gets one input file, fixed environment, no secrets, mounts, shared volumes, OIDC identity or network. Hard limits are two CPU cores, 1 GiB memory, 60 seconds lifetime, 25 MiB layout input, 4096 pixels per edge, 16 million pixels, one frame, 4096 regions, 128 polygon vertices, 10 MiB JSON output and 16 KiB per log stream. Transfer reads are incremental and bounded. VM termination runs on success, failure, timeout and cancellation. These limits can refuse large models; there is no host or GPU fallback.

Runtime sources live in `worker/src/layout/runtime` and the worker build copies them to `dist/layout/runtime`. The evaluation harness forwards to these packaged sources. Production never imports evaluation scripts or stages a host model/cache directory.

## Offline image contract and release blockers

A separately built, verified image must be configured with `DOCSLURP_DOCUMENT_VM_IMAGE=repository@sha256:<verified digest>`. No image build, publish, deploy, paid VM call or model inference was performed by this repair. A live VM smoke test and image provenance review remain required; offline contracts do not establish operational readiness.

The image must contain Python 3, Pillow with WebP support, cwebp and the approved CPU inference dependencies. Place packaged runtime files at `/opt/docslurp/layout/runtime`, model assets at `/opt/docslurp/layout/assets`, and a bounded manifest at `/opt/docslurp/layout/manifest.json` with these fields:

- `model`: `heron`, `heron-custom`, `ppv3`, `pp-small` or `pp-small-onnx`.
- `modelId`, `revision`, `artifactSha256`, `inferenceProfileSha256`: actual verified model/runtime identities matching worker configuration and runtime output.
- `files`: nonempty array, at most 128 `{path, sha256}` entries relative to `assets`; the guest verifies each hash before loading.
- `arguments`: approved `infer.py` detector arguments, including `--device cpu` and an explicit local `--model-path` or `--onnx-path` under `assets`. All models, classifiers and orientation assets must already exist. Network downloads are disabled.

The image digest pins runtime, manifest, dependencies and all assets. The manifest must cover every model asset. Do not use placeholder hashes as evidence. Every adapter uses the canonical verified complete-bundle digest for `artifactSha256`. An ONNX `graph_sha256` remains available in detector diagnostics and does not replace the bundle identity. Model/profile mismatch is an error rather than a fallback.

Set `PAGE_ROUTER_LAYOUT=shadow`, `PAGE_ROUTER_LAYOUT_ENDPOINT=modal-vm://layout`, and the existing model/revision/artifact/profile pins to enable the advisory observer. It remains off by default. Unknown compute prices remain unknown. Cache keys include the tenant scope and configuration. Shadow artifact keys use `runArtifactRoot`, including extract retention prefixes.

Coordinates refer to stored source pixels without EXIF rotation and use normalized xyxy boxes. The VM returns dimensions and exact input SHA-256; the host validates bounds and source/model/profile identity. Coarse `figure` labels do not establish semantic photo/logo/chart distinctions. Fingerprints are geometric evidence, not semantic identity.

Before merge, obtain the required independent council reviews and human owner approval. The coordinator owns merges; deployment remains separate.

## Canonical bundle and final-image profile

Use `worker/src/layout/runtime/asset_identity.py` (installed as `runtime/asset_identity.py`). `verify_asset_bundle(assets_directory, files)` verifies **exactly every regular file** under `assets`, rejects symlinks, duplicate/noncanonical paths and undeclared files, then returns the canonical digest. Paths are relative POSIX paths using ASCII letters, numbers, `.`, `_`, `-`, and `/`; hashes are lowercase SHA-256 hex. Include model weights, configs, processor/tokenizer data, orientation/classifier assets and any other asset files, including hidden metadata if retained. At most 128 files are accepted. Manifest entries contain exactly `path` and `sha256`.

The canonical bytes are `b"docslurp-layout-bundle-v1\n"` followed by UTF-8 of `json.dumps(sorted(files, key=lambda entry: entry["path"]), sort_keys=True, separators=(",", ":"))`. `artifactSha256` is the SHA-256 of those bytes, **not** the ONNX file hash. `canonical_bundle_sha256(files)` provides the same calculation without file I/O; use `verify_asset_bundle` for verified preparation.

In the **final image**, after all assets and runtime dependencies are fixed:

```python
bundle = verify_asset_bundle(root / "assets", manifest["files"])
parser = argparse.ArgumentParser()
infer.add_detector_arguments(parser)
args = parser.parse_args(manifest["arguments"])
detector = infer.create_detector(args, verified_artifact_sha256=bundle)
profile = infer.inference_profile_sha256(detector, "cpu", args.threshold)
```

Write `bundle` to `artifactSha256` and `profile` to `inferenceProfileSha256`. Bundle identity is included in detector metadata before computing the profile. Run under the same fixed offline environment, paths, CPU arguments and dependencies as `vm_entry.py`. The guest requires nonempty `modelId`, a pinned `revision`, `artifactSha256`, and `inferenceProfileSha256` on every request and compares all four to the manifest and actual output. Missing request fields never disable identity checks. Select `pp-small-onnx` explicitly in both manifest arguments and request when preparing that image; no default-Heron emulation or fallback is performed.

The host job deadline also covers app lookup and VM creation; cleanup has a separate five-second budget. Late-created VMs receive bounded best-effort termination even after the original control client closes. Provider-enforced guest lifetime remains necessary for lost creation responses.
