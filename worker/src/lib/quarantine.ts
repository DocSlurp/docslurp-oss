import path from "node:path";
import { describeArchiveIssue, inspectQuarantineBytes, type QuarantineInspection } from "./quarantine-bytes.js";
export { sniffMimeType, inspectArchive, type QuarantineInspection } from "./quarantine-bytes.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveScriptsDir } from "../tools/scripts-dir.js";

import { fileFactsFromSniff, type FileFacts } from "@docslurp/shared";

import type { Config } from "../config.js";
import { DocumentStageError } from "../pipeline/checkpoints.js";
import type { MalwareScanResult } from "../tools/runner.js";
import type { CommandRunner } from "../tools/runner.js";
import { vmOnlyParsing } from "./vm-only-parsing.js";

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
  decision: "accepted" | "quarantined";
  reasons: QuarantineReason[];
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

  const archive = inspected.archive;
  if (archive) {
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
  if (malwareScan.status === "infected") {
    reasons.push({
      code: "malware-detected",
      severity: "error",
      message: `malware signature ${malwareScan.signature ?? "unknown"} detected`,
      details: {
        engine: malwareScan.engine,
        signature: malwareScan.signature
      }
    });
  } else if (malwareScan.status === "skipped-unavailable" || malwareScan.status === "error") {
    const failClosed = !args.policy.quarantineFailOpenOnToolMissing;
    reasons.push({
      code: malwareScan.status === "error" ? "malware-scan-error" : "malware-scan-unavailable",
      severity: failClosed ? "error" : "warning",
      message:
        malwareScan.status === "error"
          ? `malware scan failed${malwareScan.stderr ? `: ${malwareScan.stderr.trim()}` : ""}`
          : "malware scanner unavailable",
      details: {
        engine: malwareScan.engine,
        stderr: malwareScan.stderr || null,
        exitCode: malwareScan.exitCode
      }
    });
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
    decision: reasons.some((reason) => reason.severity === "error") ? "quarantined" : "accepted",
    reasons
  };
}

export function assertAcceptedQuarantine(artifact: QuarantineArtifact, artifactUri?: string): void {
  if (artifact.decision === "accepted") {
    return;
  }

  const summary = artifact.reasons
    .filter((reason) => reason.severity === "error")
    .map((reason) => reason.message)
    .join("; ");
  throw new DocumentStageError(`quarantined: ${summary}`, {
    artifactUri,
    stats: buildQuarantineStats(artifact)
  });
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
    malwareStatus: artifact.malwareScan.status,
    malwareEngine: artifact.malwareScan.engine,
    malwareSignature: artifact.malwareScan.signature,
    malwareDatabaseStatus: artifact.malwareScan.databaseStatus,
    malwareDatabaseUpdatedAt: artifact.malwareScan.databaseUpdatedAt,
    malwareDatabaseAgeHours: artifact.malwareScan.databaseAgeHours
  };
}

/**
 * The bytes' inspection (sniff and ZIP checks): in the parser VM in production, in-process elsewhere. One inspection serves
 * the intake verification and the scan.
 */
export async function inspectQuarantine(args: { bytes: Buffer; filename: string; tempFile: string; runner: CommandRunner; policy: QuarantinePolicy; signal?: AbortSignal }): Promise<QuarantineInspection> {
  return vmOnlyParsing() ? await inspectInVm(args) : inspectQuarantineBytes(args.bytes, args.filename, args.policy);
}

const SNIFF_CONTAINERS = new Set(["zip", "ole"]);
const SNIFF_ENCODINGS = new Set(["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "8-bit"]);

/** MIME and ZIP inspection also consume hostile bytes and belong inside the VM. */
async function inspectInVm(args: { bytes: Buffer; filename: string; tempFile: string; runner: CommandRunner; policy: QuarantinePolicy; signal?: AbortSignal }): Promise<QuarantineInspection> {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-quarantine-"));
  try {
    const options = path.join(dir, "options.json");
    const output = path.join(dir, "inspection.json");
    await writeFile(options, JSON.stringify({ filename: args.filename, policy: {
      quarantineFailOpenOnToolMissing: args.policy.quarantineFailOpenOnToolMissing,
      quarantineMaxArchiveEntries: args.policy.quarantineMaxArchiveEntries,
      quarantineMaxArchiveDepth: args.policy.quarantineMaxArchiveDepth,
      quarantineMaxTotalUncompressedBytes: args.policy.quarantineMaxTotalUncompressedBytes,
      quarantineMaxSingleEntryBytes: args.policy.quarantineMaxSingleEntryBytes,
      quarantineMaxExpansionRatio: args.policy.quarantineMaxExpansionRatio,
    } }), { mode: 0o600 });
    await args.runner.run({ binary: "node", args: [path.join(resolveScriptsDir(), "quarantine-inspect.mjs"), args.tempFile, options, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, args.signal);
    if ((await stat(output)).size > 2 * 1024 * 1024) throw new Error("quarantine inspection result exceeds limit");
    const result = JSON.parse(await readFile(output, "utf8")) as QuarantineInspection;
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
    }
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
