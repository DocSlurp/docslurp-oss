# Exact reviewed image published; VM admission still blocked

The user completed GitHub OAuth package-scope consent and the parent verified
`write:packages`. The parent's authorized ORAS copy then succeeded with exit 0:

`ghcr.io/docslurp/worker-document-vm:543ce1a333c7828662171ae25fc060b14be29aaf`

This documentation update did not access credentials, publish, rebuild, sign or
launch anything. It read only the supplied sanitized log, the two exact remote
JSON files and the retained local OCI archive. `publication-success.json` records
the parent-reported outcome and the byte checks performed here.

## Identity and preserved attestations

- Remote platform image manifest SHA-256:
  `66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`.
- Remote OCI index SHA-256:
  `fbbdd7f307ff8ccf49c3fd74e7fc448b5c4eda8878bfb1accf0920669b39b3ee`.
- Local archive SHA-256, rechecked before the parent's copy and again here:
  `46733e0df89522d13a14a295e9cd0749b1f692c0240a1e3d6cccd3169599b842`.
- Archive bytes: `353474048`; no rebuild or image change.

`remote-image-manifest.json` and `remote-index.json` preserve the raw remote bytes
without reformatting. Both independently hash to the expected digests and exactly
match their blobs in the reviewed archive. The remote index preserves the original
attestation manifest reference
`sha256:56ae2cbce81f13a687ea9eac9671c42e664c6f311caf6bf966407cedea9a4940`,
bound to the same image. The parent reports copying the original SPDX/SLSA blobs
unchanged; the sanitized ORAS log confirms those original blob digests were copied.
This update does not claim a fresh remote fetch of those individual blobs or a
completed registry signature.

The supplied success log is
`/home/dan/tmp/agents/council-image-publish.8_gz59o4/publication-retry.log`,
retained as `publication-success.txt` with its checksum. The original denied
attempt and its JSON/log remain unchanged as history. The parent reports removing
`retry-auth.json` in `finally`; this update did not inspect that credential file.

## Visibility and remaining gates

The parent read-only package API check reports **PRIVATE** visibility at
https://github.com/orgs/DocSlurp/packages/container/package/worker-document-vm.
The OSS repository is public; that does not make its GHCR package public. No
visibility change was performed. Any future Modal import must account for the
existing private-package reader access rather than assuming anonymous access.

**Keyless registry signing is not done.** The parent architect is checking the
policy and a separate VM agent is preparing a manual-signing-only supporting PR.
No signature or policy clearance is claimed here.

**No VM was launched.** The original $0.05 TOTAL admission failed because lazy
image import/provisioning/startup, retained-cache storage and network costs were
unbounded. The user subsequently authorized **$20 aggregate**, replacing $0.05;
the parent architect is reassessing a defensible upper bound. No revised admission
clearance or execution delegation to this evidence task was reported.
The known 2-CPU/1-GiB/60-second compute estimate is $0.0051306, not a total-cost
bound. Sandbox expiry and an environment budget do not close those gaps. The
parent is reassessing those costs under the new cap; no `Image.build` or sandbox
`create` probe is authorized as a workaround. See [the operational cost blocker](operational-attempt.md)
and [the updated smoke plan](publication-smoke-plan.md).

The [new budget authorization](budget-authorization.md) preserves the historical
$0.05 failure and keeps one VM, 60-second expiry, no retries and no deployment.
