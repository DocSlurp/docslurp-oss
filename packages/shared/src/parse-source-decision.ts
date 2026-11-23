/**
 * Scan what we parse (PR #339): the parse decision quarantine records on a document's row (server/db/migrations 0134-0135)
 * and the predicate the worker and the API share. The worker refuses to parse a document without a current decision
 * (worker/src/lib/parse-source.ts); the API reports such a document as needing a rescan instead of queueing page work the
 * worker will refuse.
 */

/** The scan that recorded a decision. Bump it to make every earlier decision unscanned (they re-quarantine on reprocess). */
export const PARSE_SOURCE_SCAN_VERSION = 1;
/** Distinct from a malware-scanned decision, including for older readers which refuse unknown versions. */
export const PARSE_SOURCE_VALIDATION_VERSION = -1;
/** Full scan with a clean verdict under the organization policy. */
export const PARSE_SOURCE_FULL_SCAN_VERSION = 2;

/** Operator-managed roster. Missing or malformed configuration retains scanning for all uploads. */
export function requiresMalwareScan(orgId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!orgId || !uuid.test(orgId)) return true;
  const roster = env.DOCSLURP_MALWARE_SCAN_ORGS?.trim();
  if (roster === "none") return false;
  if (!roster) return true;
  const ids = roster.toLowerCase().split(",").map(id => id.trim());
  return ids.some(id => !uuid.test(id)) || ids.includes(orgId.toLowerCase());
}

/** Stable public reason and copy for a document whose pages cannot be read until it is reprocessed. */
export const PARSE_SOURCE_RESCAN_REASON = "quarantine-rescan-required" as const;
export const PARSE_SOURCE_RESCAN_MESSAGE = "This document needs to be scanned again; reprocess it to view pages";

/** The documents columns the decision lives in. */
export interface ParseSourceDecisionColumns {
  org_id?: string | null;
  source_sha256?: string | null;
  parse_source_key?: string | null;
  parse_source_sha256?: string | null;
  parse_source_scan_version?: number | null;
}

import { isDevelopmentEnvironment, normalizeEnvSetting } from "./runtime-environment.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Whether quarantine must scan every document (the worker's config.quarantineEnabled). Disabling it
 * (QUARANTINE_ENABLED=0/false/no/off) is development-only (#398): outside development and test (runtime-environment.ts:
 * NODE_ENV other than development, test or unset, or a service profile) quarantine is always required, and the worker
 * refuses to start with it disabled (worker/src/lib/unsafe-overrides.ts).
 */
export function quarantineRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isDevelopmentEnvironment(env)) return true;
  const value = normalizeEnvSetting(env.QUARANTINE_ENABLED);
  return !["0", "false", "no", "off"].includes(value);
}

/**
 * Whether the row holds a decision from the current scan, bound to the bytes parsers read: a scanned copy (key and its
 * hash), or the upload as the scan read it (its hash, which must be the upload's server hash when the row has one).
 */
export function hasCurrentParseDecision(row: ParseSourceDecisionColumns, env: NodeJS.ProcessEnv = process.env): boolean {
  const version = row.parse_source_scan_version;
  if (version === PARSE_SOURCE_VALIDATION_VERSION) {
    if (row.parse_source_key != null || requiresMalwareScan(row.org_id, env)) return false;
  } else if (version === PARSE_SOURCE_SCAN_VERSION) {
    // Historical acceptance could have used the scanner-unavailable fail-open option.
    if (env.DOCSLURP_MALWARE_SCAN_ORGS && requiresMalwareScan(row.org_id, env)) return false;
  } else if (version !== PARSE_SOURCE_FULL_SCAN_VERSION) {
    return false;
  }
  const sha = row.parse_source_sha256?.trim().toLowerCase() || null;
  if (sha === null || !SHA256_HEX.test(sha)) return false;
  if (row.parse_source_key) return true;
  const server = row.source_sha256?.trim().toLowerCase() || null;
  return server === null || server === sha;
}

/** Whether the document must be reprocessed (re-quarantined) before anything may parse it: page renders, materialization. */
export function parseSourceRescanRequired(row: ParseSourceDecisionColumns, env: NodeJS.ProcessEnv = process.env): boolean {
  return quarantineRequired(env) && !hasCurrentParseDecision(row, env);
}
