/**
 * Ingest version tagging and typed "unavailable" states.
 *
 * Every document and run records the ingest version of the pipeline that produced it (server/db/migrations
 * 0160_ingest_version.sql). Clients compare a document's version with the workspace's current one (GET
 * /v1/ingest-version) to offer an update, and the serving paths answer a page, figure or artifact they cannot show with
 * a typed `DataUnavailable` state instead of an error.
 *
 * Version-bump policy (docs/ingest-version.md):
 * - Bump CURRENT_INGEST_VERSION when a change alters extraction output or adds metadata that serving relies on, so a
 *   document produced before it is missing something a reprocess would add. Pure refactors, speedups and cost changes
 *   do not bump it.
 * - The version only ever increases. 0 means "unknown": rows produced before tagging (the migration's backfill).
 * - Capability names are append-only and never renamed or reused. A document's capabilities are measured from what its
 *   run actually stored; a run's are what its pipeline build supports. Neither is ever inferred for version 0 rows.
 */
import { z } from "zod";
import { parseSourceRescanRequired, type ParseSourceDecisionColumns } from "./parse-source-decision.js";

/** The ingest version this build produces. Monotonic; see the bump policy above. */
export const CURRENT_INGEST_VERSION = 1;

/** Rows produced before ingest tagging. */
export const UNKNOWN_INGEST_VERSION = 0;

/**
 * Capability flags, append-only.
 * - parseSourceDecision: the document holds a parse decision from the current quarantine scan, so its pages can be
 *   rendered and materialized on demand.
 * - pageFacts: per-page facts (text layer, images, vision status) were recorded.
 * - figureLedger: the figure ledger (extracted and not-extracted images with reasons) was recorded for this run.
 */
export const INGEST_CAPABILITIES = ["parseSourceDecision", "pageFacts", "figureLedger"] as const;
export type IngestCapability = (typeof INGEST_CAPABILITIES)[number];

/** What this build's pipeline supports: stamped on runs. */
export const CURRENT_INGEST_CAPABILITIES: readonly IngestCapability[] = INGEST_CAPABILITIES;

export const ingestCapabilitySchema = z.enum(INGEST_CAPABILITIES);

/** Stored capabilities, filtered to the known vocabulary (unknown names from a newer build are dropped, never echoed). */
export function knownIngestCapabilities(values: readonly unknown[] | null | undefined): IngestCapability[] {
  const known = new Set<string>(INGEST_CAPABILITIES);
  return [...new Set((values ?? []).filter((value): value is IngestCapability => typeof value === "string" && known.has(value)))];
}

export const ingestStatusSchema = z.object({
  /** The version that produced the document; 0 when unknown (produced before tagging). */
  version: z.number().int().nonnegative(),
  capabilities: z.array(ingestCapabilitySchema),
  /** The workspace's current version. */
  currentVersion: z.number().int().positive(),
  /** True when a reprocess would bring the document to the current version. Informational: shown in details. */
  updateAvailable: z.boolean(),
  /**
   * Capabilities a serving path needs for this document that it lacks, measured from the row (never from the version
   * alone): `parseSourceDecision` for a PDF or a deferred-indexed document without a decision from the current scan,
   * whose page images and on-demand pages are refused until a reprocess.
   */
  missingCapabilities: z.array(ingestCapabilitySchema),
  /** True when `missingCapabilities` is non-empty: the only case clients should badge "Update available". */
  updateRecommended: z.boolean(),
  /** On GET /v1/documents/:id: true only when an update is available and this caller may start the reprocess. */
  canReprocess: z.boolean().optional(),
});
export type IngestStatus = z.infer<typeof ingestStatusSchema>;

export function ingestStatus(
  row: { ingestVersion?: number | null; ingestCapabilities?: readonly unknown[] | null },
  missing: readonly IngestCapability[] = [],
): IngestStatus {
  const version = Number.isInteger(row.ingestVersion) && (row.ingestVersion as number) >= 0 ? row.ingestVersion as number : UNKNOWN_INGEST_VERSION;
  const missingCapabilities = knownIngestCapabilities(missing);
  return {
    version,
    capabilities: version === UNKNOWN_INGEST_VERSION ? [] : knownIngestCapabilities(row.ingestCapabilities),
    currentVersion: CURRENT_INGEST_VERSION,
    updateAvailable: version < CURRENT_INGEST_VERSION,
    missingCapabilities,
    updateRecommended: missingCapabilities.length > 0,
  };
}

/**
 * The capabilities serving needs that a document lacks, measured from its row. Today one: page images (PDFs) and on-demand
 * materialization (deferred indexing) refuse a document without a current parse decision (parse-source-decision.ts).
 */
export function missingServingCapabilities(
  row: ParseSourceDecisionColumns & { mime_type: string; indexing_mode?: string | null; status: string },
  env: NodeJS.ProcessEnv = process.env,
): IngestCapability[] {
  if (row.status !== "completed") return [];
  const needsDecision = row.mime_type === "application/pdf" || (row.indexing_mode != null && row.indexing_mode !== "full");
  return needsDecision && parseSourceRescanRequired(row, env) ? ["parseSourceDecision"] : [];
}

/** GET /v1/ingest-version: the workspace's current version and what it produces. */
export const workspaceIngestVersionSchema = z.object({
  ingestVersion: z.number().int().positive(),
  capabilities: z.array(ingestCapabilitySchema),
});
export type WorkspaceIngestVersion = z.infer<typeof workspaceIngestVersionSchema>;

export function workspaceIngestVersion(): WorkspaceIngestVersion {
  return { ingestVersion: CURRENT_INGEST_VERSION, capabilities: [...CURRENT_INGEST_CAPABILITIES] };
}

/**
 * Why data the caller may see is not there. A closed vocabulary: never error text.
 * - needs-reprocess: produced by an older pipeline or before the current scan; a reprocess fixes it.
 * - withheld: a policy (PII) withholds it.
 * - not-extracted: the pipeline chose not to produce it (too small, a repeat, a budget, a skipped chart).
 * - processing: it is still being produced.
 * - not-supported: this kind of data does not exist for this file type.
 * - disabled: a project setting turns the feature off.
 * - temporarily-unavailable: storage or a dependency did not answer; retrying later may help.
 */
export const DATA_UNAVAILABLE_REASONS = [
  "needs-reprocess",
  "withheld",
  "not-extracted",
  "processing",
  "not-supported",
  "disabled",
  "temporarily-unavailable",
] as const;
export type DataUnavailableReason = (typeof DATA_UNAVAILABLE_REASONS)[number];

/** Reviewed, neutral copy for each reason. */
export const DATA_UNAVAILABLE_MESSAGES: Record<DataUnavailableReason, string> = {
  "needs-reprocess": "This needs a quick reprocess to display.",
  withheld: "This is withheld by the project's privacy policy.",
  "not-extracted": "This wasn't extracted when the document was processed.",
  processing: "This is still being processed.",
  "not-supported": "This isn't available for this file type.",
  disabled: "This feature is turned off for the project.",
  "temporarily-unavailable": "This isn't available right now. Try again shortly.",
};

/** Reasons a reprocess can resolve; `canReprocess` is also gated on the caller being allowed to reprocess. */
const REPROCESSABLE: ReadonlySet<DataUnavailableReason> = new Set(["needs-reprocess", "not-extracted"]);

export const dataUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.enum(DATA_UNAVAILABLE_REASONS),
  message: z.string(),
  /** True only when a reprocess resolves the reason and the caller may start one. */
  canReprocess: z.boolean(),
  /** The document's ingest version (0 = unknown), or null when the state is not about one document. */
  ingestVersion: z.number().int().nonnegative().nullable(),
  currentIngestVersion: z.number().int().positive(),
});
export type DataUnavailable = z.infer<typeof dataUnavailableSchema>;

export function dataUnavailable(reason: DataUnavailableReason, options: { canEdit?: boolean; ingestVersion?: number | null } = {}): DataUnavailable {
  return {
    status: "unavailable",
    reason,
    message: DATA_UNAVAILABLE_MESSAGES[reason],
    canReprocess: options.canEdit === true && REPROCESSABLE.has(reason),
    ingestVersion: options.ingestVersion ?? null,
    currentIngestVersion: CURRENT_INGEST_VERSION,
  };
}

export function isDataUnavailable(value: unknown): value is DataUnavailable {
  return dataUnavailableSchema.safeParse(value).success;
}

/**
 * The figure runner's `resume_blocked` reasons (migration 0159) as a public state. `stale` (the document moved to another
 * run) and `refused` keep their detail in telemetry.
 */
export function figureResumeUnavailableReason(blocked: string | null | undefined): DataUnavailableReason | null {
  switch (blocked) {
    case null: case undefined: case "": return null;
    case "unscanned": return "needs-reprocess";
    case "figures-off": case "resume-off": return "disabled";
    case "attempts": case "refused": return "not-extracted";
    case "stale": return "processing";
    default: return "not-extracted";
  }
}

/** The public ingest fields of a documents or project_runs row; omitted when the query did not select the columns. */
export function ingestRecordFields(row: { ingest_version?: number | null; ingest_capabilities?: readonly unknown[] | null }): { ingestVersion?: number; ingestCapabilities?: IngestCapability[] } {
  if (row.ingest_version === undefined || row.ingest_version === null) return {};
  const status = ingestStatus({ ingestVersion: row.ingest_version, ingestCapabilities: row.ingest_capabilities });
  return { ingestVersion: status.version, ingestCapabilities: status.capabilities };
}
