# Dedicated CPU document VM image — local preparation, 2026-10-27

This image packages the actual WebP program and layout guest from campaign `03aa2c4` (including `cfd32f3`). **Containers validate packaging only; no production VM, isolation proof, registry publication, deployment or paid resource was used.** The campaign remains subject to council review and human merge approval.

## Reproduce

From the OSS repository, with Docker, Buildx, Python 3 and a configured `uv` executable:

```sh
export TMPDIR=/home/dan/tmp/agents TMP=/home/dan/tmp/agents TEMP=/home/dan/tmp/agents
bash scripts/document-vm/build.sh "$PWD/.cache/document-vm-image/new-build"
```

`UV=/absolute/path/to/uv` selects an installed binary if its shell shim is unconfigured. The output directory must be new. Exporter and guest Python dependencies are exact/hash-locked separately. The guest base is digest-pinned Python 3.12 slim, Linux amd64. Debian's public apt repository supplies WebP; exact installed system versions are recorded in the manifest/SBOM. Apt dependencies are **recorded, not snapshot-locked**; a future rebuild may change system-package layers. Source and graph identities are checked against `scripts/document-vm/source-lock.json`. Runtime assets never enter Git; only evidence and manifests do.

The script fetches official public weights at immutable revision, exports with `scripts/layout-eval/export_pp_small.py`, prepares a minimal context, installs guest wheels offline with `--require-hashes`, seals identities in the final installed environment, validates the actual programs and exports an OCI archive with BuildKit provenance and SPDX SBOM. It deletes its own task scratch on exit. Local Docker image/build cache is retained for review. No host `.env`, credential directory, customer file, benchmark input or model-provider API is used.

## Exact identities and local deliverable

- Source: [PaddlePaddle/PP-DocLayout-S at the pinned HF commit](https://huggingface.co/PaddlePaddle/PP-DocLayout-S/tree/8ac289e66575bb9bba6e15c53719d8b15cc9b3b2). Its pinned README declares Apache-2.0.
- Revision: `8ac289e66575bb9bba6e15c53719d8b15cc9b3b2`.
- Graph SHA-256: `33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8`.
- Complete asset-bundle SHA-256: `ccfa68bc3ae28999c172ed232b036dfc283801225c97949bf1f30186ea929e9d`.
- Final-image inference profile SHA-256: `402045d01939270ce7a497120f2c569d8bc42764d567b0b66ff311e66e485182`.
- **OCI image manifest digest:** `sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`. This is the image identity for future registry use, not the Docker config/image ID or archive hash. A future publisher must preserve/verify the manifest bytes.
- Archive: `/home/dan/.t3/worktrees/docslurp-app/t3-3b555ca8/core/.cache/document-vm-image/final-03aa2c4/document-vm.oci.tar`.
- Archive SHA-256: `46733e0df89522d13a14a295e9cd0749b1f692c0240a1e3d6cccd3169599b842`; 353,474,048 bytes (337.10 MiB).
- Final local image: 350,868,988 bytes (334.61 MiB), measured by Docker image inspect. This value is Docker's reported image size, not a separately measured unpacked rootfs.
- Scripted build scratch at completion: 1,085,119,299 bytes (1.01 GiB), recorded before cleanup. Development scratch was an additional approximately 1.15 GB. Peak total host disk and shared Docker cache growth were not instrumented; these figures are observed footprints, not a peak claim. The initial 5–10 GiB transient / <2 GiB image estimate was conservative.

The archive is durable locally under ignored `.cache`, not committed to Git. `oci-record.json` records checked blob identities, image/config digests and attestation layers. `oci-index.json`, `provenance.json`, `sbom.json.gz`, `export-provenance.json`, `manifest.json`, and `local-image-inspect.json` retain the evidence. The manifest hashes all eight asset files, including official source files, normalized export provenance and Apache license text. Full machine-specific export command/timing remains in external export provenance; canonical in-image provenance omits time and normalizes paths so identical exports have a stable bundle identity.

Pillow 12.3.0, NumPy 2.5.4, ONNX Runtime 1.31.0 and OpenCV headless distribution 5.0.0.93 are installed. OpenCV reports imported module version 5.0.0. The profile includes all four imported versions, verified bundle, CPU provider and settings. Final arguments explicitly select `pp-small-onnx`, CPU, fp32 graph, two threads, threshold 0.3 and no visual classifier. There is no implicit Heron selection or model download. Repeated pinned exports produced the same graph digest.

## Validation

`validation.json` records the exact container prefix, program hash, exit status, timing and stream sizes. The harness extracts **the actual `IMAGE_PROGRAM` string** from `document-vm.ts`; layout executes the actual packaged `vm_entry.py` with the mandatory identities. Each case uses network none, two CPUs, 1 GiB RAM/no swap, read-only root, writable `/job`, unprivileged UID, dropped capabilities and no-new-privileges. Cgroup reads confirm `cpu.max=200000 100000`, `memory.max=1073741824`, `memory.swap.max=0`, `pids.max=128`.

Successful checks: PNG → lossless WebP → PNG with exact decoded pixel equality, real-weight CPU layout with correct source hash and bundle/profile identity, explicit resource settings, and local cancellation/removal. Negative cases cover wrong model/device/revision/model ID, syntactically valid wrong bundle/profile hashes, missing identity fields, a tampered ONNX asset, malformed bytes, over-limit dimensions, animation, >25 MiB layout input, denied outbound network and denied rootfs write. This guest image has no tenant/auth interface or credentials; tenant and key boundary tests remain with the host executor. Local Docker cancellation is **not** Modal control-plane cancellation evidence.

Synthetic input and actual model output are retained as `synthetic.png`, `layout.json`, and `synthetic-layout-overlay.png`. Four predicted regions include overlapping table/figure boxes; this is a packaging smoke, not an accuracy claim. Final inference initially measured approximately 1.13 s including local Docker startup; fresh timings are in `validation.json`. ORT emitted approximately 5.3 KiB of unused-initializer warnings, below the executor's 16 KiB stream cap; those warnings are preserved, not hidden. Eight Python VM/bundle/version contract tests passed (`python-contract-tests.log`). Shell syntax, Python compilation and `git diff --check` passed. Full pnpm suites/typecheck were not run: this isolated checkout has no installed Node dependencies, and the implementation changes only Python/build tooling; campaign TypeScript checks are owned by the VM-fix agent.

Operator configuration after external approval (shown here only; not applied):

```dotenv
PAGE_ROUTER_LAYOUT=off
PAGE_ROUTER_LAYOUT_ENDPOINT=modal-vm://layout
PAGE_ROUTER_LAYOUT_DEVICE=cpu
PAGE_ROUTER_LAYOUT_MODEL_ID=PaddlePaddle/PP-DocLayout-S
PAGE_ROUTER_LAYOUT_REVISION=8ac289e66575bb9bba6e15c53719d8b15cc9b3b2
PAGE_ROUTER_LAYOUT_ARTIFACT_SHA256=ccfa68bc3ae28999c172ed232b036dfc283801225c97949bf1f30186ea929e9d
PAGE_ROUTER_LAYOUT_PROFILE_SHA256=402045d01939270ce7a497120f2c569d8bc42764d567b0b66ff311e66e485182
# DOCSLURP_DOCUMENT_VM_IMAGE must use the future verified registry repository and recorded manifest digest.
# Enable shadow mode only after an authorized actual-VM smoke and deployment decision.
```

The host mapping explicitly maps this model ID to `pp-small-onnx`; the guest manifest also selects that adapter. Do not set Heron pins for this image.

## Licensing and provenance

Source weights/config/README and generated graph are Apache-2.0 under the upstream model declaration. Full Apache license text is in the asset bundle with SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`. `source-lock.json` and export provenance preserve each original source hash and exporter hash/tool versions. Runtime distribution licenses remain in their installed `.dist-info` directories, Debian notices remain under `/usr/share/doc`, and SPDX inventories the image packages and detected licenses. This is evidence for review, not a substitute for release legal/source-obligation review of bundled third-party system libraries. DocSlurp runtime inherits the worker package license. No benchmark assets are included.

## Forecast only: one bounded CPU VM smoke

Official [Modal pricing](https://modal.com/pricing), checked 2026-10-27, lists **Sandbox non-preemptible** CPU $0.00003942 per physical core-second and memory $0.00000667 per GiB-second (3× standard rates). At 2 cores + 1 GiB, the allocation is $0.00008551/s = $0.307836/hour. One 30–60 s attempt is $0.002565–$0.005131 compute; the 60 s ceiling is about $0.00898 with a 1.75× regional factor. Treat actual availability/quota, chosen region, image import/startup billing, VM-runtime applicability and provider billing minimums as unverified until an authorized preflight. No credits are assumed.

A suggested future reserve is **$0.05 for one attempt, no automatic retry**, with a provider-enforced 60 s lifetime plus bounded cleanup. This is a forecast, not authorization. Unchanged allocation exposure: +1 hour $0.307836; +5 hours $1.53918; 24 hours $7.388064, before regional multipliers. No persistent volume is planned. Public dependency downloads incurred no API/model/cloud compute charge; registry storage/import and transfer charges remain unverified. Listed egress is $0.04/GiB before included allowance: 10 MiB output would be approximately $0.000391. Uploading/publishing the image is a separate unauthorized action.

## Pending external actions

1. Council/provenance/license review and human owner merge approval for this supporting PR and the campaign.
2. Separately authorize registry publication, choose a destination, verify pushed manifest digest and signatures/attestations; no registry URI is fabricated here.
3. Separately authorize and run one bounded real `runtime:"vm"` smoke, including startup, observed memory, network policy, host transfer, failure/cancel/termination and billing receipts. Containers do not establish this boundary.
4. After publication/approval, configure `DOCSLURP_DOCUMENT_VM_IMAGE=<approved-repository>@sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21` plus explicit CPU model/revision/bundle/profile pins from `manifest.json`. Keep routing off until then; no deployment/environment was changed.

The first exploratory export emitted an optimizer missing-dependency warning and attempted an implicit pip installation that failed because pip was absent (`initial-export-warning.txt`). The final exporter explicitly disables optional optimization/automatic opset changes, uses the complete hash lock, and makes no such implicit installation. Both exports produced the same graph hash; the final scripted run and checked eight-file bundle reproduced successfully.
