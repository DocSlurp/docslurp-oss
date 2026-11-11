/**
 * ClamAV scan limits, shared by the per-command `clamscan` path and the scanner VMs' clamd (providers/modal/scanner.ts).
 *
 * libclamav's defaults skip what they cannot afford and report it clean: a file over MaxFileSize (100 MB) is not scanned
 * at all, and a scan that hits MaxScanSize, MaxFiles, MaxRecursion or MaxScanTime stops and returns "clean" for the
 * rest. Uploads reach 500 MiB (MAX_UPLOAD_BYTES) and quarantine downloads up to 512 MiB, so an EICAR inside a 110 MB
 * ZIP scanned clean (council M2). Two changes close that:
 *
 * - The size limits sit above anything quarantine will download, so every accepted byte is scanned.
 * - AlertExceedsMax turns any limit that is still hit into a `Heuristics.Limits.Exceeded.<limit>` detection (exit 1),
 *   which quarantine refuses like malware (isClamLimitAlert), never a clean verdict.
 *
 * Encrypted content is the same gap: by default libclamav cannot decrypt a password-protected ZIP/RAR/7z member or a PDF
 * that needs a user password, skips it and reports the file clean (council re-check H1; an EICAR in an encrypted ZIP
 * nested in a plain ZIP scanned clean on both paths). AlertEncryptedArchive and AlertEncryptedDoc turn that into a
 * `Heuristics.Encrypted.<kind>` detection, which the runner reports as "unscannable" and quarantine refuses whatever the
 * fail-open policy says. A PDF encrypted with only an owner password (an empty user password: the common "permissions"
 * PDF) is decrypted and scanned by libclamav and stays clean (clam-limits.docker.test.ts).
 *
 * Measured with ClamAV 1.4.3 (2 vCPU, 4 GiB; performance/quarantine-latency-2026-11-11/results.md): a 510 MB file scans
 * in 56–123 s with about 1.07 GB peak RSS (the signatures are about 0.96 GB of it). Files and scan sizes past 2 GiB are
 * outside what libclamav supports, and quarantine never downloads them.
 */
export const CLAM_SCAN_LIMITS = {
  /** Largest file scanned (quarantine downloads at most 512 MiB by default). */
  maxFileSize: "1024M",
  /** Most data scanned per file, archive members and decoded streams included. */
  maxScanSize: "2000M",
  /** Most embedded objects scanned per file: a 5,000-page PDF has about 10,000 streams (the default limit). */
  maxFiles: 50_000,
  /** libclamav's default; quarantine refuses archives nested deeper than 12 (QUARANTINE_MAX_ARCHIVE_DEPTH) anyway. */
  maxRecursion: 17,
  /** Per-file scan time. A synthetic 20,000-page PDF needs longer and is refused as unscanned, not passed. */
  maxScanTimeMs: 300_000,
} as const;

/** Wall-clock budget of one scan command: the scan time limit plus the signature load (15–30 s) and margin. */
export const CLAM_SCAN_COMMAND_TIMEOUT_MS = CLAM_SCAN_LIMITS.maxScanTimeMs + 90_000;

/** Encrypted archives and documents are detections (`Heuristics.Encrypted.*`), never skipped as clean (ClamAV 1.4 names). */
export const CLAMSCAN_ENCRYPTION_ALERT_ARGS = ["--alert-encrypted-archive=yes", "--alert-encrypted-doc=yes"] as const;
export const CLAMD_ENCRYPTION_ALERT_LINES = ["AlertEncryptedArchive yes", "AlertEncryptedDoc yes"] as const;

/** clamscan arguments applying CLAM_SCAN_LIMITS, with limit hits and encrypted content reported as detections. */
export function clamscanLimitArgs(): string[] {
  return [
    `--max-filesize=${CLAM_SCAN_LIMITS.maxFileSize}`,
    `--max-scansize=${CLAM_SCAN_LIMITS.maxScanSize}`,
    `--max-files=${CLAM_SCAN_LIMITS.maxFiles}`,
    `--max-recursion=${CLAM_SCAN_LIMITS.maxRecursion}`,
    `--max-scantime=${CLAM_SCAN_LIMITS.maxScanTimeMs}`,
    "--alert-exceeds-max=yes",
    ...CLAMSCAN_ENCRYPTION_ALERT_ARGS,
  ];
}

/** clamd.conf lines applying CLAM_SCAN_LIMITS and the encryption alerts (StreamMaxLength too: an INSTREAM over it is an error, never clean). */
export function clamdLimitLines(): string[] {
  return [
    `MaxFileSize ${CLAM_SCAN_LIMITS.maxFileSize}`,
    `MaxScanSize ${CLAM_SCAN_LIMITS.maxScanSize}`,
    `StreamMaxLength ${CLAM_SCAN_LIMITS.maxFileSize}`,
    `MaxFiles ${CLAM_SCAN_LIMITS.maxFiles}`,
    `MaxRecursion ${CLAM_SCAN_LIMITS.maxRecursion}`,
    `MaxScanTime ${CLAM_SCAN_LIMITS.maxScanTimeMs}`,
    "AlertExceedsMax yes",
    ...CLAMD_ENCRYPTION_ALERT_LINES,
  ];
}

/** True for ClamAV's limit alert (`Heuristics.Limits.Exceeded.MaxFileSize` etc.): the file was not fully scanned. */
export function isClamLimitAlert(signature: string | null | undefined): boolean {
  return typeof signature === "string" && /^Heuristics\.Limits\.Exceeded(?:\.|$)/.test(signature.trim());
}

/**
 * True for ClamAV's encrypted-content alert (`Heuristics.Encrypted.Zip`, `.PDF`, `.RAR`, ...): the engine could not decrypt
 * the content, so it was not scanned. Not malware, and never clean.
 */
export function isClamEncryptedAlert(signature: string | null | undefined): boolean {
  return typeof signature === "string" && /^Heuristics\.Encrypted(?:\.|$)/.test(signature.trim());
}
