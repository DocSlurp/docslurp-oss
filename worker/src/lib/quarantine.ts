import path from "node:path";
import { GUEST_NODE_FLAGS } from "../chart-export/extractors/host.js";
import { inlineChartsInProcess, validateInlineCharts, type InlineChartRequest, type StoredInlineCharts } from "../chart-export/inline.js";
import { describeArchiveIssue, inspectQuarantineBytes, pdfHasEncryptName, type QuarantineInspection } from "./quarantine-bytes.js";
export { sniffMimeType, inspectArchive, type QuarantineInspection } from "./quarantine-bytes.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveScriptsDir } from "../tools/scripts-dir.js";

import { fileFactsFromSniff, quarantineFailureText, type FileFacts } from "@docslurp/shared";

import type { Config } from "../config.js";
import { DocumentStageError } from "../pipeline/checkpoints.js";
import { CommandExitError, type MalwareScanResult } from "../tools/runner.js";
import type { CommandRunner } from "../tools/runner.js";
import { vmOnlyParsing } from "./vm-only-parsing.js";
import { isClamEncryptedAlert, isClamLimitAlert } from "../tools/clam-limits.js";

export interface QuarantineReason {
  code: string;
  severity: "error" | "warning";
  message: string;
  details?: Record<string, unknown>;
}

export interface ArchiveInspection {
  kind: "zip";
  entryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxPathDepth: number;
  compressionRatio: number | null;
  suspicious: boolean;
  inspectable: boolean;
  issues: string[];
  /**
   * Office chart parts (`word|ppt|xl/charts/chartN.xml`) by entry name: a free chart-presence signal for chart export
   * stats. Optional: guests built before it was added omit it.
   */
  chartParts?: number;
  /** `*.svg` entries by name (the inline chart signal for an EPUB); optional, older guests omit it. */
  svgParts?: number;
  /** Warning-only findings of the nested walk (`archive-nested-uninspectable`); optional, older guests omit it. */
  notices?: string[];
  /** Nested containers (ZIP, gzip, OLE2) the in-VM walk opened (archive-nesting.ts). */
  nestedContainers?: number;
  /** Deepest container reached, the top-level ZIP being 1. */
  maxNestingDepth?: number;
}

export interface QuarantineArtifact {
  documentId: string;
  filename: string;
  declaredMimeType: string;
  sniffedMimeType: string | null;
  /** True when the declared type cannot be reconciled with the bytes (an error). Same-family differences are warnings. */
  mimeMismatch: boolean;
  /** The bytes' facts as sniffed here: encoding, container and the declared-vs-sniffed verdict. */
  fileFacts: Pick<FileFacts, "sniffedMimeType" | "encoding" | "container" | "mismatch">;
  archive: ArchiveInspection | null;
  malwareScan: MalwareScanResult;
  /**
   * An encrypted PDF's in-VM decryption (CommandRunner.decryptPdfForScan) and the scan of its plaintext copy; null when
   * the file is not a PDF naming /Encrypt or its own scan was not clean.
   */
  pdfDecryption?: {
    status: "requires-password" | "decrypted" | "failed";
    ms: number;
    bytes?: number;
    encrypted?: boolean;
    malwareScan?: MalwareScanResult;
    /** The scanned copy on this host (with `scannedCopyDir`); never persisted: the stage stores the copy and drops this. */
    copyPath?: string;
    /**
     * Where the stage stored the scanned copy every parser reads instead of the original (lib/parse-source.ts), with its
     * sha256 and the time the store took.
     */
    parseSource?: { uri: string; sha256: string; storeMs: number };
  } | null;
  decision: "accepted" | "quarantined";
  reasons: QuarantineReason[];
  /**
   * Inline chart extraction (DOCSLURP_CHART_EXPORT_INLINE): the guest's validated answer for an accepted document whose
   * verified type is the kind it was asked for. Absent when not asked, refused documents, or a type change.
   */
  chartInline?: StoredInlineCharts;
}


export type QuarantinePolicy = Pick<
  Config,
  | "quarantineFailOpenOnToolMissing"
  | "quarantineMaxArchiveEntries"
  | "quarantineMaxArchiveDepth"
  | "quarantineMaxTotalUncompressedBytes"
  | "quarantineMaxSingleEntryBytes"
  | "quarantineMaxExpansionRatio"
>;

/**
 * The API only glances at an upload (magic bytes and the declared type; it never opens a container), so a document it
 * recorded with `inspection: "header"` is provisional. This is the full inspection, run on the staged bytes before any parser:
 * it opens ZIP and OLE containers, classifies text, and decides what the file is.
 *
 * `refused` means the bytes cannot be what was declared (a generic ZIP declared as a DOCX); the quarantine records that
 * as a mime-mismatch error. Otherwise `facts` replace the provisional record (persisted by the stage) and
 * `scanDeclaredMimeType` is the type the scan should treat as declared. Null when the record is not provisional.
 */
export function verifyIntakeFileFacts(
  document: { filename: string; mimeType: string; fileFacts?: FileFacts | null },
  inspection: QuarantineInspection,
): { facts: FileFacts; refused: boolean; scanDeclaredMimeType: string } | null {
  if (document.fileFacts?.inspection !== "header") return null;
  const declared = document.fileFacts.declaredMimeType ?? document.mimeType;
  const facts = fileFactsFromSniff(inspection.sniffed, { filename: document.filename, declaredMimeType: declared });
  const refused = facts.mismatch === "unresolved";
  return { facts, refused, scanDeclaredMimeType: refused ? declared : facts.mimeType };
}

export async function scanDocumentForQuarantine(args: {
  documentId: string;
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
  tempFile: string;
  runner: CommandRunner;
  policy: QuarantinePolicy;
  signal?: AbortSignal;
  /** The bytes' inspection, when the caller already took it (inspectQuarantine): the scan reads nothing again. */
  inspection?: QuarantineInspection;
  /**
   * Where the decrypted copy of an encrypted PDF is written and left (the caller owns and removes the directory): the copy
   * the scan read is the copy every parser reads (lib/parse-source.ts). Without it the copy is removed after the scan.
   */
  scannedCopyDir?: string;
}): Promise<QuarantineArtifact> {
  const reasons: QuarantineReason[] = [];
  // Production reads the bytes in the parser VM (MIME sniff, ZIP inspection); never in this process. Facts follow from the sniff.
  const inspected = args.inspection ?? await inspectQuarantine(args);
  const facts = fileFactsFromSniff(inspected.sniffed, { filename: args.filename, declaredMimeType: args.declaredMimeType });
  const sniffedMimeType = facts.sniffedMimeType;
  // Intake stores the type the bytes are, so a document that reaches the worker under another type (ingested before intake
  // sniffed, or a declaration no sniff could confirm) is refused. A declared type that differs only within one family (a CSV
  // labelled as a spreadsheet, a .docx labelled application/msword) is a warning: the bytes are what the file claims to be.
  const mimeMismatch = facts.mismatch === "corrected" || facts.mismatch === "unresolved";
  if (mimeMismatch) {
    reasons.push({
      code: "mime-mismatch",
      severity: "error",
      message: `declared ${args.declaredMimeType} but sniffed ${sniffedMimeType ?? "unknown"}`,
      details: {
        declaredMimeType: args.declaredMimeType,
        sniffedMimeType
      }
    });
  } else if (facts.mismatch === "same-family") {
    reasons.push({
      code: "mime-mismatch-same-family",
      severity: "warning",
      message: `declared ${args.declaredMimeType} but the bytes are ${sniffedMimeType ?? "unknown"}, the same kind of file`,
      details: { declaredMimeType: args.declaredMimeType, sniffedMimeType }
    });
  }

  // Council L1: the guest's verdicts are cross-checked against what this host already knows from the leading bytes (the same
  // magic numbers intake reads) and a bounded byte search, never a parse. A PDF header with no PDF result, or a ZIP header
  // with no archive result, means the guest's answer does not describe these bytes: refused.
  const hostPdf = hasLeadingBytes(args.bytes, PDF_MAGIC);
  if ((hostPdf && inspected.pdf === null) || (hasLeadingBytes(args.bytes, ZIP_LOCAL_MAGIC) && inspected.archive === null)) {
    reasons.push({
      code: "quarantine-inspection-inconsistent",
      severity: "error",
      message: "file could not be inspected safely",
      details: { hostPdfHeader: hostPdf, guestPdf: inspected.pdf !== null, guestArchive: inspected.archive !== null },
    });
  }
  // The guest's "no /Encrypt" is not taken alone: an /Encrypt name in the bytes, `#xx` escapes included (council N-L3:
  // `/En#63rypt`), sends the file to the decryption check. A bounded byte search over name tokens, never a parse.
  const encryptName = !!inspected.pdf?.encryptName || (hostPdf && (args.bytes.includes(ENCRYPT_NAME) || pdfHasEncryptName(args.bytes) === true));
  // Council N-H1: readers may disagree on this PDF's encryption (two encryption dictionaries, trailers that disagree, a
  // cross-reference chain readers must rebuild), so what the decryption copy shows is not what every reader shows.
  if (inspected.pdf?.encryptConflict) {
    reasons.push({ code: "pdf-encryption-inconsistent", severity: "error", message: "encrypted PDF has an inconsistent structure and cannot be scanned reliably; remove its encryption and upload again" });
  }

  const archive = inspected.archive;
  if (archive) {
    for (const notice of archive.notices ?? []) {
      reasons.push({ code: notice, severity: "warning", message: describeArchiveIssue(notice, archive) });
    }
    for (const issue of archive.issues) {
      reasons.push({
        code: issue,
        severity: "error",
        message: describeArchiveIssue(issue, archive),
        details: {
          entryCount: archive.entryCount,
          totalCompressedBytes: archive.totalCompressedBytes,
          totalUncompressedBytes: archive.totalUncompressedBytes,
          maxEntryUncompressedBytes: archive.maxEntryUncompressedBytes,
          maxPathDepth: archive.maxPathDepth,
          compressionRatio: archive.compressionRatio
        }
      });
    }
  }

  const malwareScan = await args.runner.scanForMalware(args.tempFile, args.signal);
  reasons.push(...malwareScanReasons(malwareScan, args.policy));

  // libclamav scans an owner-password PDF's unfiltered streams as ciphertext (clam-hostile-matrix.docker.test.ts): a PDF
  // that names /Encrypt and scanned clean is decrypted in the parser VM and the plaintext copy scanned too. Clean only if
  // both are; anything the decryption cannot settle is refused.
  let pdfDecryption: QuarantineArtifact["pdfDecryption"] = null;
  if (encryptName && malwareScan.status === "clean" && !inspected.pdf?.encryptConflict) {
    const dir = args.scannedCopyDir ?? await mkdtemp(path.join(tmpdir(), "docslurp-quarantine-pdf-"));
    try {
      const outcome = await args.runner.decryptPdfForScan(args.tempFile, dir, args.signal);
      if (outcome.status === "requires-password") {
        pdfDecryption = { status: outcome.status, ms: outcome.ms };
        reasons.push({ code: "malware-scan-encrypted-content", severity: "error", message: ENCRYPTED_CONTENT_MESSAGE, details: { engine: "qpdf", signature: null } });
      } else if (outcome.status === "failed") {
        pdfDecryption = { status: outcome.status, ms: outcome.ms };
        // The reason (qpdf's own stderr) stays in details for telemetry; the message is user-safe.
        reasons.push({ code: "malware-scan-pdf-decrypt-failed", severity: "error", message: "encrypted PDF could not be decrypted for a malware scan; remove its encryption and upload again", details: { reason: outcome.reason } });
      } else {
        const copyScan = await args.runner.scanForMalware(outcome.path, args.signal);
        pdfDecryption = { status: outcome.status, ms: outcome.ms, bytes: outcome.bytes, encrypted: outcome.encrypted, malwareScan: copyScan, ...(args.scannedCopyDir ? { copyPath: outcome.path } : {}) };
        for (const reason of malwareScanReasons(copyScan, args.policy)) {
          reason.details = { ...reason.details, scanned: "decrypted-copy" };
          if (!reasons.some((existing) => existing.code === reason.code)) reasons.push(reason);
        }
      }
    } finally {
      if (!args.scannedCopyDir) await rm(dir, { recursive: true, force: true });
    }
  }

  if (malwareScan.databaseStatus === "stale" || malwareScan.databaseStatus === "missing") {
    reasons.push({
      code: malwareScan.databaseStatus === "stale" ? "malware-definitions-stale" : "malware-definitions-missing",
      severity: malwareScan.status === "error" ? "error" : "warning",
      message:
        malwareScan.databaseStatus === "stale"
          ? `malware definitions are stale (${malwareScan.databaseAgeHours ?? "unknown"} hours old)`
          : "malware definitions are missing",
      details: {
        databaseStatus: malwareScan.databaseStatus,
        databaseUpdatedAt: malwareScan.databaseUpdatedAt,
        databaseAgeHours: malwareScan.databaseAgeHours,
        databaseSource: malwareScan.databaseSource
      }
    });
  }

  for (const warning of malwareScan.healthWarnings ?? []) {
    reasons.push({
      code: "malware-scan-health-warning",
      severity: "warning",
      message: warning,
      details: {
        engine: malwareScan.engine,
        databaseStatus: malwareScan.databaseStatus
      }
    });
  }

  return {
    documentId: args.documentId,
    filename: args.filename,
    declaredMimeType: args.declaredMimeType,
    sniffedMimeType,
    mimeMismatch,
    fileFacts: { sniffedMimeType, encoding: facts.encoding, container: facts.container, mismatch: facts.mismatch },
    archive,
    malwareScan,
    pdfDecryption,
    decision: reasons.some((reason) => reason.severity === "error") ? "quarantined" : "accepted",
    reasons
  };
}

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const ZIP_LOCAL_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ENCRYPT_NAME = Buffer.from("/Encrypt", "latin1");

function hasLeadingBytes(bytes: Buffer, magic: Buffer): boolean {
  return bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
}

const ENCRYPTED_CONTENT_MESSAGE = "file is encrypted or password-protected, so it cannot be scanned for malware; remove the password and upload again";

/** The quarantine reasons one malware scan verdict gives (none for a clean scan). */
function malwareScanReasons(malwareScan: MalwareScanResult, policy: QuarantinePolicy): QuarantineReason[] {
  const reasons: QuarantineReason[] = [];
  if (malwareScan.status === "unscannable" || (malwareScan.status === "infected" && isClamEncryptedAlert(malwareScan.signature))) {
    // AlertEncryptedArchive/AlertEncryptedDoc (clam-limits.ts): encrypted archive members or a PDF that needs a user
    // password, which the scanner cannot read. Not malware and never clean: refused whatever the fail-open policy says.
    // The message is user-safe; the engine and signature stay in details (telemetry).
    reasons.push({
      code: "malware-scan-encrypted-content",
      severity: "error",
      message: ENCRYPTED_CONTENT_MESSAGE,
      details: {
        engine: malwareScan.engine,
        signature: malwareScan.signature
      }
    });
  } else if (malwareScan.status === "infected" && isClamLimitAlert(malwareScan.signature)) {
    // AlertExceedsMax (clam-limits.ts): the scanner stopped at a size, file-count, depth or time limit, so part of this
    // file was never scanned. Refused whatever the fail-open policy says: an unscanned file is never accepted as clean.
    reasons.push({
      code: "malware-scan-limit-exceeded",
      severity: "error",
      message: "file exceeds the malware scanner's limits and was not fully scanned",
      details: {
        engine: malwareScan.engine,
        signature: malwareScan.signature
      }
    });
  } else if (malwareScan.status === "infected") {
    reasons.push({
      code: "malware-detected",
      severity: "error",
      message: "malware detected",
      details: {
        engine: malwareScan.engine,
        signature: malwareScan.signature
      }
    });
  } else if (malwareScan.status === "skipped-unavailable" || malwareScan.status === "error") {
    const failClosed = !policy.quarantineFailOpenOnToolMissing;
    reasons.push({
      code: malwareScan.status === "error" ? "malware-scan-error" : "malware-scan-unavailable",
      severity: failClosed ? "error" : "warning",
      // Fixed text: the scanner's stderr stays in details (artifact, telemetry), never in the stage error.
      message: malwareScan.status === "error" ? "malware scan failed" : "malware scanner unavailable",
      details: {
        engine: malwareScan.engine,
        stderr: malwareScan.stderr || null,
        exitCode: malwareScan.exitCode
      }
    });
  }

  return reasons;
}

export function assertAcceptedQuarantine(artifact: QuarantineArtifact, artifactUri?: string): void {
  if (artifact.decision === "accepted") {
    return;
  }

  const errors = artifact.reasons.filter((reason) => reason.severity === "error");
  // The reason codes lead the stage error so the API can map them to reviewed copy (public-errors.ts); messages are this
  // module's own fixed text, raw scanner output stays in reason details (the artifact and telemetry).
  throw new DocumentStageError(quarantineFailureText(errors.map((reason) => reason.code), errors.map((reason) => reason.message)), {
    artifactUri,
    stats: buildQuarantineStats(artifact)
  });
}

/**
 * The scan engine and signature of a refused or flagged document, for telemetry only (council N-L4): stage stats are
 * public, so these go to the worker log (SigNoz) and the artifact's reason details instead.
 */
export function quarantineTelemetryLine(artifact: QuarantineArtifact): string | null {
  const copy = artifact.pdfDecryption?.malwareScan;
  if (!artifact.malwareScan.signature && !copy?.signature && artifact.decision === "accepted") return null;
  return `[quarantine] document=${artifact.documentId} decision=${artifact.decision} reasons=${artifact.reasons.map((reason) => reason.code).join(",") || "none"} engine=${artifact.malwareScan.engine} signature=${JSON.stringify(artifact.malwareScan.signature ?? null)} copySignature=${JSON.stringify(copy?.signature ?? null)}`;
}

export function buildQuarantineStats(artifact: QuarantineArtifact): Record<string, unknown> {
  return {
    decision: artifact.decision,
    declaredMimeType: artifact.declaredMimeType,
    sniffedMimeType: artifact.sniffedMimeType,
    mimeMismatch: artifact.mimeMismatch,
    mimeVerdict: artifact.fileFacts.mismatch,
    textEncoding: artifact.fileFacts.encoding,
    reasonCodes: artifact.reasons.map((reason) => reason.code),
    archiveEntryCount: artifact.archive?.entryCount ?? null,
    archiveExpandedBytes: artifact.archive?.totalUncompressedBytes ?? null,
    archiveCompressionRatio: artifact.archive?.compressionRatio ?? null,
    // Council N-L4: no signature or engine name. Stage stats are returned by the public document API; the signature and
    // engine stay in the artifact's reason details and the quarantine log line (telemetry).
    malwareStatus: artifact.malwareScan.status,
    malwareDatabaseStatus: artifact.malwareScan.databaseStatus,
    malwareDatabaseUpdatedAt: artifact.malwareScan.databaseUpdatedAt,
    malwareDatabaseAgeHours: artifact.malwareScan.databaseAgeHours,
    pdfDecryptionStatus: artifact.pdfDecryption?.status ?? null,
    pdfDecryptionMs: artifact.pdfDecryption?.ms ?? null,
    pdfDecryptedCopyStatus: artifact.pdfDecryption?.malwareScan?.status ?? null,
    pdfParseCopy: artifact.pdfDecryption?.parseSource ? true : null,
    pdfParseCopyBytes: artifact.pdfDecryption?.parseSource ? artifact.pdfDecryption.bytes ?? null : null,
    pdfParseCopyStoreMs: artifact.pdfDecryption?.parseSource?.storeMs ?? null,
    archiveNestedContainers: artifact.archive?.nestedContainers ?? null
  };
}

/**
 * The bytes' inspection (sniff and ZIP checks): in the parser VM in production, in-process elsewhere. One inspection serves
 * the intake verification and the scan.
 */
export async function inspectQuarantine(args: InspectArgs): Promise<QuarantineInspection> {
  if (vmOnlyParsing()) return await inspectInVm(args);
  const inspection: QuarantineInspection = inspectQuarantineBytes(args.bytes, args.filename, args.policy);
  if (args.charts) {
    // Local development and tests: the same plan and extractor in process; a failure is a refusal, as in the guest.
    try { inspection.charts = inlineChartsInProcess(args.bytes, args.charts, inspection); }
    catch { inspection.charts = { status: "refused", reason: "worker-failed", ms: 0 }; }
  }
  return inspection;
}

interface InspectArgs {
  bytes: Buffer; filename: string; tempFile: string; runner: CommandRunner; policy: QuarantinePolicy; signal?: AbortSignal;
  /** Inline chart extraction in the same guest process (DOCSLURP_CHART_EXPORT_INLINE): the declared kind and options. */
  charts?: InlineChartRequest;
}

const SNIFF_CONTAINERS = new Set(["zip", "ole"]);
const SNIFF_ENCODINGS = new Set(["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "8-bit"]);

/** MIME and ZIP inspection also consume hostile bytes and belong inside the VM. */
async function inspectInVm(args: InspectArgs): Promise<QuarantineInspection> {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-quarantine-"));
  try {
    const options = path.join(dir, "options.json");
    const output = path.join(dir, "inspection.json");
    let inlineCrashed = false;
    await writeFile(options, JSON.stringify({ filename: args.filename, policy: {
      quarantineFailOpenOnToolMissing: args.policy.quarantineFailOpenOnToolMissing,
      quarantineMaxArchiveEntries: args.policy.quarantineMaxArchiveEntries,
      quarantineMaxArchiveDepth: args.policy.quarantineMaxArchiveDepth,
      quarantineMaxTotalUncompressedBytes: args.policy.quarantineMaxTotalUncompressedBytes,
      quarantineMaxSingleEntryBytes: args.policy.quarantineMaxSingleEntryBytes,
      quarantineMaxExpansionRatio: args.policy.quarantineMaxExpansionRatio,
    }, ...(args.charts ? { charts: { kind: args.charts.kind, diagrams: args.charts.diagrams } } : {}) }), { mode: 0o600 });
    // V8 refuses code generation from strings in this command and in the inline chart worker it starts (worker threads take
    // the flag from their process; it cannot be set per worker), as in every chart guest run (host.ts GUEST_NODE_FLAGS).
    try {
      await args.runner.run({ binary: "node", args: [...GUEST_NODE_FLAGS, path.join(resolveScriptsDir(), "quarantine-inspect.mjs"), args.tempFile, options, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, args.signal);
    } catch (error) {
      // The guest writes the inspection before charts run (council r3 L1). When the command exited non-zero after that,
      // with charts asked, the inspection stands and the charts are a refusal. Without charts, or with no inspection
      // written (a timeout, an abort, a failure before the write), the command failed as before.
      if (!args.charts || !(error instanceof CommandExitError) || error.exitCode === null || args.signal?.aborted || !(await stat(output).catch(() => null))) throw error;
      inlineCrashed = true;
    }
    if ((await stat(output)).size > (args.charts ? 6 : 2) * 1024 * 1024) throw new Error("quarantine inspection result exceeds limit");
    const result = JSON.parse(await readFile(output, "utf8")) as QuarantineInspection;
    // The chart answer is checked on its own and can only ever be dropped to a refusal: it never fails the inspection.
    // Asked for and missing (an image whose guest predates inline charts) stays missing: vision-extract then runs as before.
    const charts = (result as { charts?: unknown }).charts;
    delete (result as { charts?: unknown }).charts;
    // The inspection proper keeps its own 2 MiB bound; only the chart answer gets the extra allowance.
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw new Error("quarantine inspection result exceeds limit");
    if (args.charts && inlineCrashed) result.charts = { status: "refused", reason: "worker-failed", ms: 0 };
    else if (args.charts && charts !== undefined) result.charts = validateInlineCharts(charts);
    const sniffed = result?.sniffed as unknown as Record<string, unknown> | null;
    if (!sniffed || typeof sniffed !== "object" || Object.keys(sniffed).some((key) => !["mimeType", "container", "encoding"].includes(key))
      || !(sniffed.mimeType === null || typeof sniffed.mimeType === "string" && sniffed.mimeType.length <= 256 && /^[\w.+-]+\/[\w.+-]+$/.test(sniffed.mimeType))
      || !(sniffed.container === null || SNIFF_CONTAINERS.has(sniffed.container as string))
      || !(sniffed.encoding === null || SNIFF_ENCODINGS.has(sniffed.encoding as string))) throw new Error("invalid quarantine MIME result");
    const archive = result.archive;
    if (archive !== null) {
      if (!archive || archive.kind !== "zip" || typeof archive.suspicious !== "boolean" || typeof archive.inspectable !== "boolean" || !Array.isArray(archive.issues) || archive.issues.length > 100 || archive.issues.some((issue) => typeof issue !== "string" || issue.length > 256)) throw new Error("invalid quarantine archive result");
      for (const key of ["entryCount", "totalCompressedBytes", "totalUncompressedBytes", "maxEntryUncompressedBytes", "maxPathDepth"] as const) {
        if (!Number.isSafeInteger(archive[key]) || archive[key] < 0) throw new Error("invalid quarantine archive size");
      }
      if (!(archive.compressionRatio === null || Number.isFinite(archive.compressionRatio) && archive.compressionRatio >= 0)) throw new Error("invalid quarantine expansion ratio");
      if (archive.notices !== undefined && !(Array.isArray(archive.notices) && archive.notices.length <= 10 && archive.notices.every((notice) => notice === "archive-nested-uninspectable"))) throw new Error("invalid quarantine archive notices");
      if (archive.chartParts !== undefined && !(Number.isSafeInteger(archive.chartParts) && archive.chartParts >= 0 && archive.chartParts <= archive.entryCount)) throw new Error("invalid quarantine chart part count");
      if (archive.svgParts !== undefined && !(Number.isSafeInteger(archive.svgParts) && archive.svgParts >= 0 && archive.svgParts <= archive.entryCount)) throw new Error("invalid quarantine SVG part count");
      for (const key of ["nestedContainers", "maxNestingDepth"] as const) {
        if (archive[key] !== undefined && !(Number.isSafeInteger(archive[key]) && archive[key]! >= 0 && archive[key]! <= 1_000_000)) throw new Error("invalid quarantine nesting count");
      }
    }
    // parser-vm@4: an image without the PDF encryption check (no `pdf` key) is refused, never read as "not encrypted".
    const pdf = result.pdf as unknown;
    // parser-vm@4: `encryptConflict` (council N-H1) is required; an image without it is refused.
    if (pdf !== null && !(pdf && typeof pdf === "object" && Object.keys(pdf).length === 2
      && typeof (pdf as { encryptName?: unknown }).encryptName === "boolean" && typeof (pdf as { encryptConflict?: unknown }).encryptConflict === "boolean")) throw new Error("invalid quarantine PDF result");
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
