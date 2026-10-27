# One live synthetic VM smoke — passed and terminated

Run `069eb2de141c445794b754546e2c079e`, sandbox
`sb-01M5Z704F61QSGXCNTNWZHBJDW`. The coordinator executed one authorized attempt
with runner exit 0. This evidence collector made no provider calls, accessed no
credential source and performed no additional attempt, deployment or signing.

The exact runner fingerprint is
`81bc95247725bf547c67bb2060bc9ace01d499de622d06d2245594cd57e09ff4`.
The preserved approval record identifies `/root/security` (adversarial) and
`/root/detective`, both approved for that fingerprint and fixed image.

## Result and visual evidence

**36 check steps matched expectations: 18 successful operations, 18 intentional
negative refusals, zero unexpected failures.** Negative exit codes are expected
test outcomes, not processing failures. `receipt.json` classifies each refusal;
this collector also checked the retained stderr for its precise expected reason.

Actual PP-DocLayout-S ONNX inference returned the expected 800×1000 source hash,
model/revision, canonical bundle and inference profile. WebP encode/decode
preserved exact RGB pixels, hash
`5142d0c68cc6d9e168fc9c9dc4ecef5c886cd64ce4ff76db4b57ec396b333b4b`.
Missing/wrong identities, wrong model/device, malformed/over-edge/animated/large
inputs and a tampered `/job` graph copy were refused. The executed runner checked
the canonical bundle before and after; canonical assets were not modified.

[Actual live overlay](live-layout-overlay.svg) and [self-contained report](report.html)
embed the retained synthetic raster and annotate this VM's `layout.json`; no new
inference or image-generation call was used. The close-up preserves the model's
overlapping figure/table predictions. Four detected regions on this one synthetic
page establish operation, not a benchmark accuracy score.

## Timing and cleanup

All timestamps are coordinator/runner observations in UTC, not independently
measured provider creation timestamps:

| Event | UTC |
| --- | --- |
| Create requested | 2026-10-27 17:36:54.939860 |
| Create returned | 2026-10-27 17:37:16.307395 |
| Work completed | 2026-10-27 17:37:22.149019 |
| Termination requested | 2026-10-27 17:37:22.209982 |
| Termination verified | 2026-10-27 17:37:22.514815 |

Create request to return was **21.367535 s**, including lazy import/provisioning;
the individual contribution of each is not separately measured. Check sequence
wall time was **4.886557 s**; total host elapsed time **28.038187 s**. Layout
command time was **0.968970 s**; model inference diagnostic **17.035804 ms**.
WebP encode/decode commands were **0.138789 / 0.133272 s**, including remote
command/control overhead. This is one observation, not a throughput distribution.

The runner terminated and polled the VM to provider exit **137**. The parent then
independently reattached read-only using installed Modal 1.6.2 and
`Sandbox.from_id(existing_id).poll()`, which also returned **137**. That was
reconciliation of the same VM, not creation of a new one. No retry occurred.
The 1,800-second expiry was a backstop; this VM was terminated early.

## Resources, network and credential scope

The preserved request specifies `runtime:"vm"`, CPU request/hard limit 2, memory
request/hard limit 1,024 MiB, 1,800-second expiry, blocked network, no GPU, no OIDC
identity token and no sandbox/exec secrets or mounts. The parent reports using
the PAT only for `Image.from_registry` import authentication; it was not forwarded
to guest env or filesystem. `registryAuthMode` is the fixed safe description of
the ephemeral image-pull secret; no credential values are in this evidence.

Guest CPU affinity was **2**. Cgroup `cpu.max`, `memory.max`, swap and PID files
were not visible and are retained as null; the run does not independently measure
guest memory enforcement or peak RSS. A single connection to `1.1.1.1:443` failed
with **ENETUNREACH (errno 101)**. This supports that probe's refusal, not exhaustive
egress/escape/isolation proof. This one QA run does not close unrelated production
parser or tenant boundaries.

`secret-scan.json` records the 42 supplied run/review files scanned before copying:
known credential patterns and nonempty sensitive JSON values were checked, without
reading actual credentials for comparison. No matches were found. Pattern-based
scanning cannot prove absence of every opaque/encoded secret. Expected negative
tracebacks and 5,275 bytes of ORT unused-initializer warnings are preserved; the
warnings remained below the 16 KiB stream cap.

## Cost and signing remain distinct

Actual per-run billed usage is **unknown** (`providerUsage.billedUsd: null`). The
runner's **$0.0023975454** host-elapsed compute estimate is diagnostic, not an
invoice and not import/storage/network spend. The parent reports the existing
monthly account aggregate remained **$0.39871733 metered / $0 billed** before and
after; reporting lag is unknown. No account delta is attributed to this VM and
unchanged account totals do not mean this run was free. The user-authorized
aggregate cap remained $20; actual total reconciliation is pending.

The parent's PAT read-only exact-remote verifier passed. Signing Actions run
**40551595607** failed **before signing**; keyless signing remains a release gate.
No signature, production deployment or broader release clearance is claimed.

`state.json`, `layout.json`, pixel/resource/network JSON, the approval record and
capped guest stderr are copied from `.cache/document-vm-image/one-modal-smoke`
after scanning. `receipt.json` adds classifications and parent-reported independent
reconciliation. Hashes/provenance are listed in the scan and top-level evidence
index. The fixed image remains
`ghcr.io/docslurp/worker-document-vm@sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`.
