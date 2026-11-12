/**
 * Scan what we parse (PR #339): the parse decision quarantine records on a document's row (server/db/migrations 0134-0135)
 * and the predicate the worker and the API share. The worker refuses to parse a document without a current decision
 * (worker/src/lib/parse-source.ts); the API reports such a document as needing a rescan instead of queueing page work the
 * worker will refuse.
 */

/** The scan that recorded a decision. Bump it to make every earlier decision unscanned (they re-quarantine on reprocess). */
export const PARSE_SOURCE_SCAN_VERSION = 1;

/** Stable public reason and copy for a document whose pages cannot be read until it is reprocessed. */
export const PARSE_SOURCE_RESCAN_REASON = "quarantine-rescan-required" as const;
export const PARSE_SOURCE_RESCAN_MESSAGE = "This document needs to be scanned again; reprocess it to view pages";

/** The documents columns the decision lives in. */
export interface ParseSourceDecisionColumns {
  source_sha256?: string | null;
  parse_source_key?: string | null;
  parse_source_sha256?: string | null;
  parse_source_scan_version?: number | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether quarantine must scan every document (the worker's config.quarantineEnabled): always in production. */
export function quarantineRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") return true;
  const value = env.QUARANTINE_ENABLED?.trim().toLowerCase();
  return !(value && ["0", "false", "no", "off"].includes(value));
}

/**
 * Whether the row holds a decision from the current scan, bound to the bytes parsers read: a scanned copy (key and its
 * hash), or the upload as the scan read it (its hash, which must be the upload's server hash when the row has one).
 */
export function hasCurrentParseDecision(row: ParseSourceDecisionColumns): boolean {
  if (row.parse_source_scan_version !== PARSE_SOURCE_SCAN_VERSION) return false;
  const sha = row.parse_source_sha256?.trim().toLowerCase() || null;
  if (sha === null || !SHA256_HEX.test(sha)) return false;
  if (row.parse_source_key) return true;
  const server = row.source_sha256?.trim().toLowerCase() || null;
  return server === null || server === sha;
}

/** Whether the document must be reprocessed (re-quarantined) before anything may parse it: page renders, materialization. */
export function parseSourceRescanRequired(row: ParseSourceDecisionColumns, env: NodeJS.ProcessEnv = process.env): boolean {
  return quarantineRequired(env) && !hasCurrentParseDecision(row);
}
