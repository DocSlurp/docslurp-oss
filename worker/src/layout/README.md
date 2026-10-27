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

The image digest pins runtime, manifest, dependencies and all assets. The manifest must cover every model asset. Do not use placeholder hashes as evidence. `pp-small-onnx` exposes graph identity directly; other adapters without an artifact hash refuse the production contract until their verified artifact identity is supplied. Model/profile mismatch is an error rather than a fallback.

Set `PAGE_ROUTER_LAYOUT=shadow`, `PAGE_ROUTER_LAYOUT_ENDPOINT=modal-vm://layout`, and the existing model/revision/artifact/profile pins to enable the advisory observer. It remains off by default. Unknown compute prices remain unknown. Cache keys include the tenant scope and configuration. Shadow artifact keys use `runArtifactRoot`, including extract retention prefixes.

Coordinates refer to stored source pixels without EXIF rotation and use normalized xyxy boxes. The VM returns dimensions and exact input SHA-256; the host validates bounds and source/model/profile identity. Coarse `figure` labels do not establish semantic photo/logo/chart distinctions. Fingerprints are geometric evidence, not semantic identity.

Before merge, obtain the required independent council reviews and human owner approval. The coordinator owns merges; deployment remains separate.
