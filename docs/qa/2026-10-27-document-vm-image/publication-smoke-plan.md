# Publication and one-VM smoke — authorized, operationally blocked

Latest live result: the coordinator executed **one** authorized VM attempt, run
`069eb2de141c445794b754546e2c079e`. All **36 steps matched expectations** (18
successes, 18 intended refusals); termination returned 137 and a separate parent
read-only poll also returned 137. No retry or deployment occurred. Actual billing
is unknown; signing run 40551595607 failed before signing and remains a release
gate. See [the durable live receipt and actual output](live-modal-smoke-069eb2de/README.md).
Earlier preparation/budget snapshots below are historical. The one-shot attempt
is consumed: do not rerun it.

Current status: exact-image GHCR publication succeeded after the user completed
OAuth package-scope consent and the parent verified `write:packages`. Raw remote
image/index bytes match the reviewed local archive; the original SPDX/SLSA index
was copied unchanged. The package remains **private**, with no visibility change.
Keyless registry signing is pending. No VM was launched. The initial **$0.05
TOTAL cap** failed admission because import/provisioning/startup/cache storage
charges could not be bounded. The user has since authorized **$20 aggregate**,
replacing $0.05 while retaining one synthetic VM, 60-second expiry, no retries
and no deployment. Parent architect reassessment of a defensible bound is pending.
This evidence task received no execution authority. See [the success receipt](publication-success.md)
and [new budget authorization](budget-authorization.md); the first denied
attempt remains in [the historical operational record](operational-attempt.md).

Supporting draft: https://github.com/DocSlurp/docslurp-oss/pull/202. Image implementation
commit: `543ce1a333c7828662171ae25fc060b14be29aaf`. The document-only follow-up does not
alter the image. Two independent council reviewers, including an adversarial
reviewer, and human owner approval remain required before merge.

## Publication completed; signing pending

Follow `.github/workflows/worker-images.yml`'s `ghcr.io/docslurp/worker-<profile>`
and full-commit-SHA tag convention:

`ghcr.io/docslurp/worker-document-vm:543ce1a333c7828662171ae25fc060b14be29aaf`

The parent published the **existing** local OCI archive, preserving image
manifest bytes and the provenance/SBOM attestation index, without rebuilding:

`/home/dan/.t3/worktrees/docslurp-app/t3-3b555ca8/core/.cache/document-vm-image/final-03aa2c4/document-vm.oci.tar`

The supplied raw remote platform image manifest was verified here as exactly
`sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`,
with remote index digest `sha256:fbbdd7f307ff8ccf49c3fd74e7fc448b5c4eda8878bfb1accf0920669b39b3ee`.
Keyless signing/policy review remains pending; no completed signature is claimed.
Fail closed if an import tool rewrites a
manifest or drops attestations. The published digest reference is
`ghcr.io/docslurp/worker-document-vm@sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`.
The package is PRIVATE, per the parent read-only API check; the OSS repository is
PUBLIC. No visibility change occurred. Future Modal import must verify reader
access for that private package; do not assume anonymous access.

Canonical bundle: `ccfa68bc3ae28999c172ed232b036dfc283801225c97949bf1f30186ea929e9d`.
Final profile: `402045d01939270ce7a497120f2c569d8bc42764d567b0b66ff311e66e485182`.
The source revision, graph/source/license hashes, Apache-2.0 text, full export
tool provenance and image package-license inventory are in `manifest.json`,
`export-provenance.json`, `provenance.json`, `sbom.json.gz` and `source-lock.json`.

Historical pre-publication credential inspection, 2026-10-27: GitHub identity API succeeds; the
active token reports neither `write:packages` nor `read:packages`. Docker has no
GHCR auth, helper or global credential store configured. **Publication capability
is unverified**; read-only checks cannot prove write access. Modal token pairs are
present in the canonical app `.env` and `.env.production`, absent in this process
environment. `credential-readonly-check.json` records an official CLI read-only
authentication check; VM creation permissions/quota are not tested. No values,
raw env contents or credential-bearing API output are retained. The user later
completed OAuth scope consent, the parent verified `write:packages`, and the exact
copy succeeded; no new credential inspection was performed for this receipt.

## One bounded CPU VM smoke proposal

The authorized scope, once all admission blockers are resolved, is exactly one
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
If provider expiry cannot be verified, do not create the VM. This guest-lifetime
backstop does not prove a limit on lazy image import, provisioning/startup, image
cache retention, storage or network charges; it cannot establish the total cap.

## Forecast and cap

Official [Modal Sandbox pricing](https://modal.com/pricing), checked 2026-10-27:
CPU $0.00003942/core-second + memory $0.00000667/GiB-second. At 2 cores + 1 GiB,
burn is $0.00008551/second or **$0.307836/hour**. A 30–60 second attempt is
**$0.002565–$0.005131 compute**, up to $0.00898 at a 1.75× regional factor.
Current authorized aggregate cap: **$20 TOTAL, one VM, 60-second expiry, no
retries, no deployment**, replacing the historical $0.05 ceiling. It covers
publication/import/startup/storage/smoke and associated network costs; the parent
is reassessing a defensible bound covering all components. Compute alone at
2 CPU + 1 GiB for 60 seconds is
**$0.0051306**. The parent cost review could not bound image import, provisioning/
startup or retained-cache storage; environment budgets exclude storage/network.
That explains the historical $0.05 admission failure. The higher $20 cap does
not itself establish a revised cost bound; parent reassessment remains pending.
No VM has launched, and this documentation task has no authority to invoke
`Image.build` or sandbox `create`.

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

This documentation update performs no publication, signing or VM action. OAuth
consent and registry publication are complete; keyless signing/policy review and
the parent architect's revised aggregate cost-bound assessment remain
outstanding. Successful publication does not clear the separate VM
cost-admission blocker.

Latest coordinator smoke authorization supersedes the earlier 60-second QA plan:
**one VM up to 1,800 seconds, $20 aggregate, no retries, no deployment**. The user
accepted the account limit and waived shared-spend-limit investigation; unknown
workspace-budget enforcement is no longer a stop condition. The [prepared runner](modal-smoke-runner.md)
requires two independent reviews, uses the exact published image, and has only
been validated with local mocks. No VM has launched from this child. Production
executor limits remain unchanged.
