# Quarantine latency: scanner snapshots (2026-11-11)

## Problem

Production spends 18.8–29 s in the quarantine stage on a 1-page PDF, on about 0.5 s of worker CPU. That is 55% of a 34 s upload-to-searchable time.

Under VM-only parsing, `scanForMalware` (`worker/src/tools/runner.ts`) does three slow things per document:

- It uploads the ClamAV signatures (about 113 MB) into a fresh parser VM.
- It runs `clamscan --version` there to check freshness.
- It runs `clamscan`, which loads the whole signature database again to scan one file.

The stage's sniff and ZIP inspection also runs as a VM command, on the same pooled VM. The stage's code has no quality branch, so `fast`, `auto` and `good` uploads pay the same cost.

## Change (both flags default off)

| Flag | Effect |
|---|---|
| `DOCSLURP_QUARANTINE_SCAN_SNAPSHOT=on` (Q1) | Each document's quarantine (inspection and scan) runs in its own scanner session. Its VM is restored from a Modal memory snapshot in which clamd has already loaded the signatures. Signature freshness is read on the worker from the staged daily header. |
| `DOCSLURP_MODAL_SCANNER_REGIONS` (default `us`) | The region the snapshot VMs run in. Memory snapshots of VM sandboxes need a region pin. |

### Snapshot build

A snapshot is built once per signature set (cache key: image, VM size, region, signature sha256 and version), before any job input exists:

1. Create a VM (`runtime: "vm"`, `blockNetwork`, no secrets, `experimentalEnableSnapshot`), then list its job roots.
2. Harden and lock it, exactly as a parser VM is.
3. Upload the worker's own signature files (root-owned, 0444) and the clamd config.
4. Start clamd. It loads the signatures and drops to the `clamav` user.
5. Check that the daemon reports the daily version read from the host header, and that it detects an authored EICAR file. The EICAR file is then removed.
6. List the job roots again. They must be unchanged, apart from the empty control directory.
7. Take the snapshot, then terminate the build VM.

Any failed check means no snapshot, and the scan returns an error verdict (fail closed).

### Scan path

- A VM is restored from the snapshot, then its hardening is re-applied and read back.
- `clamdscan --fdpass` runs as the parser user (uid 10001). clamd gets the file descriptor and never needs access to the job tree.
- Exit 0 means clean and exit 1 means infected. Anything else is an error, never "skipped".
- Stale, missing, malformed or future-dated signature headers block the scan before any VM command runs.

### Isolation

- **Restored VMs:** a restored VM inherits the snapshot VM's lifetime bound, counted from the restore. A live probe of a 60 s bound saw the VM gone at 61 s.
- **Network:** network stays blocked on restored VMs, measured on restore.
- **Teardown:** every restored VM is terminated when its session closes.
- **Organization and document boundary:** a scanner session refuses any command whose organization differs from its own, or that has none. It also serves one document: its first command binds it, and a command of any other document is refused (council M1).
- **Egress check:** before a restored VM runs anything, a root check confirms it cannot connect to public addresses (council L1).

## Measurements (Modal, 2 vCPU / 4 GiB, production defaults)

### Raw steps (`q1.py` in this directory, debian-slim with ClamAV 1.4.6, signatures 28180)

The driver ran in Modal `us-west`, 3 repetitions per arm.

| Step | Today (per document) | Filesystem snapshot | Memory snapshot + clamd |
|---|---|---|---|
| VM create / restore → ready | 0.52–0.68 s | 0.52–0.83 s | 0.54–0.55 s |
| Upload signatures (113 MB) | 1.4–3.7 s | 0 (baked) | 0 (in snapshot) |
| `clamscan --version` | 0.21–0.28 s | – | 0 (host header) |
| Upload file | 0.07–0.13 s | 0.07–0.13 s | 0.12–0.30 s |
| Scan one file (database load + scan) | 6.6–8.5 s | 9.0–9.3 s | 0.30–0.43 s (`clamdscan`) |
| **Total** | **8.8–13.3 s** | **9.6–10.2 s** | **1.07–1.15 s** |

- **Batch (D):** one restored VM scanned 10 files at 0.23 s each after the first (0.39 s). Ten files in one `clamdscan` call took 0.23 s.
- **Snapshot build (once per signature set):** create 0.9 s, signature upload 22.5 s (this driver), clamd load 5.6 s, snapshot 3.1 s.
- **Not worth it alone:** a filesystem snapshot removes the upload but not the database load, so it saves almost nothing.

### Real provider code (`scanner-modal.live.test.ts`)

These numbers come from the worker's own Modal provider and `CommandRunner`. They include hardening, staging, the leftover kill, the reset and session teardown. The test image was debian-slim with ClamAV.

| Arm | Per document |
|---|---|
| Before: today's per-command path, fresh activity session | 21.0, 21.9, 23.6 s |
| Q1 cold: first scan, including the snapshot build | 33.8, 34.2 s (once per signature set per worker process) |
| Q1 warm: one restored VM per document | 1.91–2.01 s |
| Q2 warm: one session, 11 files in sequence | 1.83 s for the first, then 1.01–1.29 s each |

- **Verdicts:** EICAR was `infected` (`Eicar-Test-Signature`) and the PDFs were `clean` in every arm.
- **Cross-tenant check:** a command of another organization was refused inside the Q2 session.
- **Q2 removed after council review:** the measured Q2 arm (one session for a run's whole pass) is no longer possible. A clamd that one document compromised could have answered for every later document of the run. Q1 already restores a fresh VM per document in about 1 s, so Q2 saved about 0.7–0.9 s per document.
- **Upload location:** the "before" arm uploaded the signatures from a home connection, so its signature upload is slower than production's from Fly `lax`. Production measured 18.8–29 s for the same path.

### Expected production effect (estimate, not yet measured end to end)

| Quality | Upload → searchable today | Quarantine today | With Q1 (warm) |
|---|---|---|---|
| auto, 1 page | 34.4 s (measured) | 18.8 s | about 2 s, so about 17 s faster (estimate) |
| fast, 1 page | not measured | same code path, so about 18.8 s | about 2 s (estimate) |

To measure end to end after the flags are enabled in a deployed environment, use the comparison harness. Upload the same 1-page dev PDFs at `quality=fast` and `quality=auto`, in separate projects so the bytes are not deduplicated, 3 runs per arm. Read per-stage times from the run API's stage `updated_at` values and from SigNoz `[temporal] stage=quarantine durationMs`.

Spend for this exercise: about $0.11 of Modal.

## Council review (PR #339)

Two independent reviewers: adversarial (Claude Opus 5.5) and correctness (GPT-6.1). Neither found a High.

### M2: files over 100 MB were scanned clean (existing bypass, flags off too)

libclamav's default `MaxFileSize` is 100 MB, while uploads reach 500 MiB. Over the limit, clamscan and clamd skip the file and exit 0. On hitting `MaxScanSize`, `MaxFiles`, `MaxRecursion` or `MaxScanTime`, they report the rest clean. Both scan paths now use `worker/src/tools/clam-limits.ts`: limits above the 512 MiB quarantine download cap, plus `AlertExceedsMax`. A limit that is still hit is a `Heuristics.Limits.Exceeded.*` detection, and quarantine refuses it.

Measured with ClamAV 1.4.3 from the worker image, 2 vCPU / 4 GiB, no network:

| File | Before (libclamav defaults) | After |
|---|---|---|
| Body-signature marker after 110 MB of zeros | exit 0, clean | exit 1, detected (26 s) |
| EICAR inside a 110 MB stored ZIP | exit 0, clean | exit 1, `Eicar-Test-Signature` (18 s) |
| Marker after 510 MB of zeros | (skipped) | exit 1, detected (70 s) |
| 510 MB random bytes | (skipped) | exit 0, clean (71 s, 1.07 GB peak RSS) |
| 510 MB zeros | (skipped) | 123 s of scan time (`Limits.Exceeded.MaxScanTime` at the 120 s default) |
| Synthetic 5,000-page PDF | not measured | clean (106 s) |
| Synthetic 20,000-page PDF | not measured; libclamav stops at 10,000 embedded objects and reports clean | `Limits.Exceeded.MaxScanTime`, refused |

Times include about 15 s of signature loading. Peak RSS is about 0.96 GB for the signatures and at most 110 MB more for a 510 MB scan. The scan time limit is 300 s, and the scan command's budget is that plus 90 s. Pathological files that need longer are refused as unscanned rather than passed.

## Q3: concurrent quarantine and extraction (designed, not implemented)

The smallest change that is safe under Temporal replay:

- **Recorded input:** add `quarantineConcurrent: true` to the workflow input. The server sets it when `DOCSLURP_QUARANTINE_CONCURRENT=on` and the fleet advertises a `workflow.quarantine-concurrent` capability. Histories without it replay unchanged.
- **Ordering:** with the input set, the workflow starts the quarantine activity, runs the extraction stages concurrently, and awaits quarantine before the first publishing stage (`pii-detect`, `embed`, `index`, summaries).
- **Publication:** the publishing stages already use `healthyDocuments`, so a refused document's chunks never reach an index.

Why it is not implemented here:

1. **Quarantine is a prerequisite, not only a verdict.** `verifyIntakeFileFacts` replaces the API's provisional file facts (`setDocumentFileFacts`, `document.mimeType`). `format-detect` and routing read those facts. Concurrency would first need quarantine split into an inspection step (stays first) and a scan (concurrent).
2. **Extraction already publishes servable bytes.** Extraction stores page images, figures and Markdown artifacts that server routes can serve. Gating every read path on a clean verdict, and deleting a refused document's outputs, is a wider security change than Q1/Q2.
3. **Overlap with the fast first-search plan.** That plan (Task 11/12) inserts `planFirstPass` after `format-detect` and only takes "non-failed PDFs after quarantine". Reordering quarantine would change its preconditions.
4. **Little is left to win.** With Q1 the scan is about 1–2 s and its inspection shares the VM, so Q3 would save at most about 2 s of a 34 s run.
