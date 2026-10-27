import { z } from "zod";

import { BILLABLE_UNIT_METRICS, PRICE_CARD } from "./billing.js";
import { documentExportContentSchema } from "./document-export.js";

/**
 * Extract mode: an upload whose source files and stored artifacts (page
 * images, Markdown, stage outputs, exports) live under their own storage
 * prefix, and are deleted with their Postgres rows (chunks, pages) and
 * LanceDB vector rows (in the workspace's tables, compacted out at deletion)
 * when the retention window ends. The first EXTRACT_FREE_RETENTION_HOURS are
 * free; a longer window is charged as storage for the whole window at
 * EXTRACT_RETENTION_STORAGE_MULTIPLIER times the storage price.
 * See docs/extract.md.
 */

/** Default free retention window. Deployments override it with DOCSLURP_EXTRACT_FREE_RETENTION_HOURS. */
export const EXTRACT_FREE_RETENTION_HOURS = 48;
/** Default longest retention a request may ask for. Deployments override it with DOCSLURP_EXTRACT_MAX_RETENTION_DAYS. */
export const EXTRACT_MAX_RETENTION_DAYS = 30;
/**
 * Extended retention is charged as storage at this multiple of the storage
 * price (PRICE_CARD.storageGbMonth), prorated over the window. The one knob for
 * the extended-retention margin.
 */
export const EXTRACT_RETENTION_STORAGE_MULTIPLIER = 2;
/** Storage months are 30 days for retention pricing. */
export const EXTRACT_RETENTION_DAYS_PER_MONTH = 30;
/** Billable unit metric of the extended-retention charge (one event per extract). */
export const EXTRACT_RETENTION_METRIC = BILLABLE_UNIT_METRICS.extractRetention;
/** Run kind marker kept on usage metadata and run stats so extract spend can be reported on its own. */
export const EXTRACT_PRODUCT = "extract";

const BYTES_PER_GB = 1024 ** 3;

/** Request options extract adds to the upload inputs. */
export const extractOptionsSchema = z.object({
  /**
   * Days to keep the files and outputs. Omit for the free window. A window
   * longer than the free one is charged as storage; at most the deployment's cap.
   */
  retentionDays: z.number().int().min(1).max(3650).optional(),
  /** Email the requester a download link when the extract finishes (default true). */
  notifyEmail: z.boolean().optional(),
  /** What the download holds: Markdown only (default) or everything, originals and page images included. */
  download: documentExportContentSchema.optional(),
});
export type ExtractOptions = z.infer<typeof extractOptionsSchema>;

export const extractStatusSchema = z.enum(["pending", "processing", "completed", "failed", "expired"]);
export type ExtractStatus = z.infer<typeof extractStatusSchema>;

export const extractRecordSchema = z.object({
  id: z.string(),
  status: extractStatusSchema,
  workspaceId: z.string(),
  runId: z.string().nullable(),
  /** Hours the files and outputs are kept, counted from createdAt. */
  retentionHours: z.number().int(),
  /** True when the window is longer than the free one and is charged as storage. */
  paidRetention: z.boolean(),
  /** Everything is deleted at this time. */
  expiresAt: z.string(),
  /** Credits charged for extended retention once the stored size was known; null while pending or free. */
  retentionCredits: z.number().nullable(),
  notifyEmail: z.boolean(),
  download: z.object({
    content: documentExportContentSchema,
    status: z.enum(["pending", "preparing", "ready", "failed", "expired"]),
    /** Authenticated link that redirects to a short-lived signed URL for the zip. */
    url: z.string().nullable(),
  }),
  pages: z.number().int().nullable(),
  storedBytes: z.number().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type ExtractRecord = z.infer<typeof extractRecordSchema>;

/**
 * extracts/<org>/<extract>: the one storage prefix every object of an extract
 * lives under (sources, stage artifacts, page images, exports), so the sweeper
 * deletes one prefix and a bucket lifecycle rule can target `extracts/`.
 */
export function extractStoragePrefix(args: { orgId: string; extractId: string }): string {
  for (const [name, value] of Object.entries(args)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`unsafe extract ${name}`);
  }
  return `extracts/${args.orgId}/${args.extractId}`;
}

/** True for a key or prefix inside the extract storage area. */
export function isExtractStorageKey(key: string): boolean {
  return key.startsWith("extracts/");
}

/** Whether a retention of `retentionHours` is past the free window and so charged. */
export function isPaidExtractRetention(retentionHours: number, freeHours: number = EXTRACT_FREE_RETENTION_HOURS): boolean {
  return retentionHours > freeHours;
}

/**
 * Credits for keeping `bytes` (objects + indexes) for `retentionHours`:
 * prorated storage at EXTRACT_RETENTION_STORAGE_MULTIPLIER x the storage
 * price. Zero inside the free window.
 */
export function extractRetentionCredits(args: { bytes: number; retentionHours: number; freeHours?: number }): number {
  const bytes = Number.isFinite(args.bytes) && args.bytes > 0 ? args.bytes : 0;
  const hours = Number.isFinite(args.retentionHours) && args.retentionHours > 0 ? args.retentionHours : 0;
  if (!isPaidExtractRetention(hours, args.freeHours)) return 0;
  const months = hours / 24 / EXTRACT_RETENTION_DAYS_PER_MONTH;
  return (bytes / BYTES_PER_GB) * PRICE_CARD.storageGbMonth * EXTRACT_RETENTION_STORAGE_MULTIPLIER * months;
}
