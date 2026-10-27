# Proposed publication and one-VM smoke — not authorized or executed

Supporting draft: https://github.com/DocSlurp/docslurp-oss/pull/202. Image implementation
commit: `543ce1a333c7828662171ae25fc060b14be29aaf`. The document-only follow-up does not
alter the image. Two independent council reviewers, including an adversarial
reviewer, and human owner approval remain required before merge.

## Publication proposal

Follow `.github/workflows/worker-images.yml`'s `ghcr.io/docslurp/worker-<profile>`
and full-commit-SHA tag convention:

`ghcr.io/docslurp/worker-document-vm:543ce1a333c7828662171ae25fc060b14be29aaf`

Publish the **existing** local OCI archive, preserving image manifests and the
provenance/SBOM attestation index; no rebuild or size increase is proposed:

`/home/dan/.t3/worktrees/docslurp-app/t3-3b555ca8/core/.cache/document-vm-image/final-03aa2c4/document-vm.oci.tar`

Verify the remote platform image manifest is exactly
`sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`,
retain the separate OCI index digest, and sign/attest it using the project's
established image supply-chain policy. Fail closed if an import tool rewrites a
manifest or drops attestations. The future runtime reference would be
`ghcr.io/docslurp/worker-document-vm@sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`.
No package visibility change is implicit in this proposal; verify approved
visibility and reader access before import into Modal.

Canonical bundle: `ccfa68bc3ae28999c172ed232b036dfc283801225c97949bf1f30186ea929e9d`.
Final profile: `402045d01939270ce7a497120f2c569d8bc42764d567b0b66ff311e66e485182`.
The source revision, graph/source/license hashes, Apache-2.0 text, full export
tool provenance and image package-license inventory are in `manifest.json`,
`export-provenance.json`, `provenance.json`, `sbom.json.gz` and `source-lock.json`.

Read-only credential inspection, 2026-10-27: GitHub identity API succeeds; the
active token reports neither `write:packages` nor `read:packages`. Docker has no
GHCR auth, helper or global credential store configured. **Publication capability
is unverified**; read-only checks cannot prove write access. Modal token pairs are
present in the canonical app `.env` and `.env.production`, absent in this process
environment. `credential-readonly-check.json` records an official CLI read-only
authentication check; VM creation permissions/quota are not tested. No values,
raw env contents or credential-bearing API output are retained.

## One bounded CPU VM smoke proposal

After separate explicit approval for publication and smoke, use exactly one
dedicated `runtime:"vm"` sandbox for one synthetic layout request: CPU 2 hard cap,
memory 1024 MiB hard cap, no GPU, provider-enforced `timeoutMs:60000`, blocked
network, empty secrets/env/volumes/bucket mounts, no OIDC identity. Use only
`synthetic.png`, the pinned image and the exact identities above. Keep controller
credentials on the host. Do not configure production or enable the observer.

Observe lookup/import/startup, execute the actual guest entrypoint, transfer one
bounded JSON output, verify dimensions/source hash/model/revision/bundle/profile,
and terminate on success or failure. No automatic retry or second VM is allowed.
Capture provider IDs, timestamps, actual memory/runtime and billed usage. This
first smoke does not claim to cover every live cancellation/failure scenario.

**Independent cleanup:** the provider-enforced 60-second guest expiry must be
confirmed before admission and remains active if the controller disappears or
creation response is lost. Host cleanup uses the bounded five-second termination
path in the campaign executor. Record confirmed termination/expiry using a
separate read-only reconciliation after the deadline; a missing controller is
not a cleanup receipt. No scheduler, warm replica, persistent volume, reusable
VM, service deployment or recreate-capable application is part of this smoke.
If provider expiry cannot be verified, do not create the VM.

## Forecast and cap

Official [Modal Sandbox pricing](https://modal.com/pricing), checked 2026-10-27:
CPU $0.00003942/core-second + memory $0.00000667/GiB-second. At 2 cores + 1 GiB,
burn is $0.00008551/second or **$0.307836/hour**. A 30–60 second attempt is
**$0.002565–$0.005131 compute**, up to $0.00898 at a 1.75× regional factor.
Proposed future aggregate cap: **$0.05, one VM, no retries**, contingent on
preflight verifying image-import/startup charges fit that cap. This is a proposal,
not spending authorization. If unverified import charges cannot be bounded, stop
before creation and return the concrete unknown.

Unchanged allocation exposure, before regional factors: extra 1 hour $0.307836;
extra 5 hours $1.53918; 24 hours $7.388064. These are overrun scenarios, not a plan
to keep a VM alive; the enforced deadline must prevent them.

- **Registry storage/import:** archive 353,474,048 bytes; no rebuild proposed.
  [GitHub's current policy](https://docs.github.com/en/billing/concepts/product-billing/github-packages)
  says GHCR container storage and bandwidth are free. Modal image import,
  retained-image storage, runtime-VM availability, workspace/region/quota and
  startup billing remain unverified; do not assume free. No Actions job is
  requested, so no new Actions compute is included.
- **VM storage:** no persistent volume; local OCI is retained on this existing
  machine. Any provider image-cache storage must be checked separately.
- **Egress:** Modal lists $0.04/GiB before included allowance; at the 10 MiB layout
  output cap that is approximately $0.000391. No free credit or included quota is
  assumed. No customer data or model-provider API call is involved.
- **Incurred:** no paid VM/model/cloud compute was started by this task. Public
  local dependencies/weights were fetched; local host electricity and storage
  costs are not metered here. Account-wide charges were not queried or attributed
  to this task.

Do not push an image or create the smoke VM until explicit approval arrives.
