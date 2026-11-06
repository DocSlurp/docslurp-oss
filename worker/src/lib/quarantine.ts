import path from "node:path";
import { sniffMimeType, inspectArchive, describeArchiveIssue, isUnsafeMimeMismatch } from "./quarantine-bytes.js";
export { sniffMimeType, inspectArchive } from "./quarantine-bytes.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveScriptsDir } from "../tools/scripts-dir.js";

import type { Config } from "../config.js";
import { DocumentStageError } from "../pipeline/checkpoints.js";
import type { MalwareScanResult } from "../tools/runner.js";
import type { CommandRunner } from "../tools/runner.js";

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
  mimeMismatch: boolean;
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

export async function scanDocumentForQuarantine(args: {
  documentId: string;
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
  tempFile: string;
  runner: CommandRunner;
  policy: QuarantinePolicy;
  signal?: AbortSignal;
}): Promise<QuarantineArtifact> {
  const reasons: QuarantineReason[] = [];
  const inspected = process.env.NODE_ENV === "production" ? await inspectInVm(args) : null;
  const sniffedMimeType = inspected ? inspected.sniffedMimeType : sniffMimeType(args.bytes, args.filename);
  const mimeMismatch = isUnsafeMimeMismatch(args.declaredMimeType, sniffedMimeType);
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
  }

  const archive = inspected ? inspected.archive : inspectArchive(args.bytes, args.filename, args.policy);
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

/** MIME and ZIP inspection also consume hostile bytes and belong inside the VM. */
async function inspectInVm(args: { bytes: Buffer; filename: string; tempFile: string; runner: CommandRunner; policy: QuarantinePolicy; signal?: AbortSignal }): Promise<{ sniffedMimeType: string | null; archive: ArchiveInspection | null }> {
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
    const result = JSON.parse(await readFile(output, "utf8")) as { sniffedMimeType: string | null; archive: ArchiveInspection | null };
    if (!(result.sniffedMimeType === null || typeof result.sniffedMimeType === "string" && result.sniffedMimeType.length <= 256)) throw new Error("invalid quarantine MIME result");
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
