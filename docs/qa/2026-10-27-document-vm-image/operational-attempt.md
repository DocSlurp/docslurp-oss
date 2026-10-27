# Authorized publication attempt and blocked VM admission

Recorded 2026-10-27 from the parent's operational report and supplied sanitized
log. This update performed documentation work only: no credential access,
publication attempt, image build, VM launch or model call.

The user authorized publication of the **exact reviewed image** and one synthetic
Modal `runtime:"vm"` smoke with a 60-second expiry, no retries and a **$0.05 TOTAL
cap**. Authorization requires stopping if import, startup or storage costs cannot
be bounded. It does not authorize a speculative import or provisioning call.

## GHCR attempt

The parent attempted an ORAS copy of the unchanged, verified OCI archive to:

`ghcr.io/docslurp/worker-document-vm:543ce1a333c7828662171ae25fc060b14be29aaf`

GHCR refused it with:

```text
denied: permission_denied: The token provided does not match expected scopes.
```

No image/tag publication succeeded. The log prints an attempted config-copy line
but does not confirm an uploaded blob; no completed partial upload is claimed.
The parent reports removing the temporary auth JSON and requesting GitHub OAuth
`write:packages` device consent. No consent result or new credential inspection
is recorded in this update. Registry access remains a blocker.

The supplied log at
`/home/dan/tmp/agents/council-image-publish.8_gz59o4/publication.log` is preserved
as `publication-attempt-denied.txt`, with its checksum in `publication-attempt.json`.
No auth JSON, credential value or raw credential-bearing output was accessed or
retained here.

## Total-cost admission fails independently of registry access

The parent's cost review establishes the following distinction:

- Known compute for 2 CPU + 1 GiB × 60 seconds is **$0.0051306**, using
  [Modal's published Sandbox prices](https://modal.com/pricing).
- `fromRegistry` imports lazily during sandbox `create`. `timeoutMs` bounds the
  sandbox lifetime; it is not a proven limit on image import, provisioning or
  startup duration/billing.
- An image-cache/import/storage tariff and retention ceiling were unavailable.
  Environment budgets exclude storage and network, so they do not enforce this
  aggregate cap.

Therefore the **$0.05 total-cost ceiling is not established**. No VM was created,
and no paid VM/model spend was reported. Registry/account-wide billing was not
queried, so this record does not assert an independently reconciled account bill.
Successful OAuth consent or registry publication alone would not resolve the
separate cost blocker. Do not call `Image.build` or sandbox `create` as an import
probe or workaround. No retry was performed by this update.

The existing [publication/smoke plan](publication-smoke-plan.md) retains the
allocation forecast, cap, egress/storage distinctions and independent expiry/
cleanup requirements. Before any VM admission, the parent must establish a
bound covering all applicable import/provisioning/startup, runtime, storage and
network costs within the existing authorization, or return the unresolved limit
to the user without launching.

## Exact image remains unchanged

Archive:
`/home/dan/.t3/worktrees/docslurp-app/t3-3b555ca8/core/.cache/document-vm-image/final-03aa2c4/document-vm.oci.tar`

- Archive bytes: `353474048`.
- Archive SHA-256: `46733e0df89522d13a14a295e9cd0749b1f692c0240a1e3d6cccd3169599b842`.
- Image manifest: `sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`.
- Canonical bundle: `ccfa68bc3ae28999c172ed232b036dfc283801225c97949bf1f30186ea929e9d`.
- Inference profile: `402045d01939270ce7a497120f2c569d8bc42764d567b0b66ff311e66e485182`.

This documentation update rehashed the retained archive and confirmed the same
digest. The existing manifest, source licenses, export provenance, SPDX and
attestation bindings remain the review evidence; none were regenerated.
