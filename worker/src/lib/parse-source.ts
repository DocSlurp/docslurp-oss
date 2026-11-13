/*
 * Scan what we parse (PR #339, council rounds 6 and 7).
 *
 * Readers resolve an encrypted PDF's objects in different places: poppler starts at the section after a linearization
 * dictionary, qpdf, pdf.js and MuPDF at `startxref`, so one file can show poppler a page that the scan of qpdf's decrypted
 * copy never saw. Modelling every such divergence is a losing game. Instead, quarantine stores the qpdf-decrypted,
 * normalized copy it scanned (made in the parser VM: one cross-reference table, no object streams, every generalized
 * filter decoded) and every parser reads that copy. The original stays only for "download original" and exports.
 *
 * Fail closed (council round 7, R7-H1): no document is parsed without a parse decision that this build's quarantine
 * recorded on the document's own row (migrations 0134-0135):
 *
 * - `parse_source_scan_version` = PARSE_SOURCE_SCAN_VERSION and `parse_source_key` set: parse the scanned copy, whose
 *   sha256 is `parse_source_sha256`;
 * - `parse_source_scan_version` = PARSE_SOURCE_SCAN_VERSION, no key and `parse_source_sha256` set: the upload is what the
 *   scan read; parse it, hash-bound to the bytes the scan read (council R8-L1: never to `source_sha256`, which legacy rows
 *   lack, so a swap of the object after the scan is refused either way);
 * - anything else (a document quarantined by an earlier build, or never, or a decision without a hash): **unscanned**. The loader hands parsers an
 *   unreadable key (`unscannedParseSourceKey`), every stage but quarantine refuses the document, storage refuses the key,
 *   and staged reads refuse it. Quarantine re-runs for such a document and records a decision.
 *
 * Quarantine re-runs in every partial plan (stageDataFlow.quarantine.alwaysRerun), so a reprocessed document always has its
 * own decision and its own copy under its own run: never another run's checkpoint or copy, which that run's retention purges.
 *
 * The loader (db/store.ts mapDocument) never puts the upload's key on a document whose decision is not "original": it
 * keeps it in a module-private WeakMap that only `originalSourceForQuarantine` reads. A parser cannot reach the upload by
 * building a property name at runtime (council R7-L2); staged reads are hash-bound besides (sandbox/source-integrity.ts).
 * With quarantine disabled by configuration (`quarantineRequired()` false: never in production) there is no scan and every
 * document parses its upload ("unscanned-allowed"), exactly as before.
 */

import { hasCurrentParseDecision, PARSE_SOURCE_SCAN_VERSION, quarantineRequired } from "@docslurp/shared";

import { claimQuarantineUploadIssuer, type QuarantineUpload, UnscannedParseSourceError } from "../sandbox/source-integrity.js";

/** The scan version and the shared decision predicate live in @docslurp/shared (the API reports rescans with them). */
export { PARSE_SOURCE_SCAN_VERSION, quarantineRequired };

/** Where a document's parse bytes come from. */
export type ParseSourceDecision =
  /** This build's quarantine scanned a decrypted copy; parsers read it. */
  | "scanned-copy"
  /** This build's quarantine scanned the upload as parsers read it. */
  | "original"
  /** No decision from this build: refused everywhere but quarantine. */
  | "unscanned"
  /** Quarantine is disabled by configuration (never in production): the upload, as before. */
  | "unscanned-allowed";

/** The row fields the resolver reads (documents.*, migrations 0134-0135). */
export interface ParseSourceRow {
  id: string;
  source_key: string;
  source_sha256?: string | null;
  parse_source_key?: string | null;
  parse_source_sha256?: string | null;
  parse_source_scan_version?: number | null;
}

/** The scanned copy quarantine recorded for a document: what every parser reads instead of the upload. */
export interface ScannedParseSource {
  key: string;
  sha256: string;
}

/** What quarantine records for an accepted document (Store.setDocumentParseSource). */
export interface ParseSourceDecisionRecord {
  /** The scanned copy parsers read instead of the upload (an encrypted PDF's), or null: they read the upload. */
  copy: ScannedParseSource | null;
  /** sha256 of the exact upload bytes the scan read: what parsers of the upload are bound to (council R8-L1). */
  scannedSha256: string;
}

/** The hash a decision binds parsers to (the copy's, or the scanned upload's); throws on anything that is not a sha256. */
export function assertParseSourceRecord(record: ParseSourceDecisionRecord): string {
  const sha = (record.copy ? record.copy.sha256 : record.scannedSha256)?.trim().toLowerCase() ?? "";
  if (!SHA256_HEX.test(sha) || !SHA256_HEX.test(record.scannedSha256?.trim().toLowerCase() ?? "")) {
    throw new Error("a parse decision needs the sha256 of the bytes it scanned");
  }
  return sha;
}

export interface ResolvedDocumentSource {
  /** The bytes for parsing (the scanned copy, the scanned upload), or an unreadable key for an unscanned document. */
  sourceKey: string;
  sourceSha256: string | null;
  /** The upload's server hash when a copy replaces it: staged reads refuse bytes that hash to it. Never its key. */
  originalSourceSha256?: string | null;
  parseSourceDecision: ParseSourceDecision;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A NUL byte: no object store, filesystem or URL accepts it, and storage.ts refuses the prefix by name first. */
const UNSCANNED_KEY_PREFIX = "\u0000unscanned-parse-source/";

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

export { UnscannedParseSourceError };

export function unscannedParseSourceKey(documentId: string): string {
  return `${UNSCANNED_KEY_PREFIX}${documentId}`;
}

export function isUnscannedParseSourceKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(UNSCANNED_KEY_PREFIX);
}

/** Thrown by storage for the unreadable key: the reader is refused whatever path it took. */
export function assertReadableSourceKey(key: string): void {
  if (isUnscannedParseSourceKey(key)) throw new UnscannedParseSourceError(key.slice(UNSCANNED_KEY_PREFIX.length) || "unknown", "a reader asked storage for its unscanned source");
}

/**
 * The document's parse source, from its row. A half-recorded copy (a key without a sha256, a hash that is not one, a copy
 * with no scan version) fails loudly: falling back to the original would hand parsers bytes nobody scanned. A current
 * decision without a hash, or whose hash is not the upload's server hash, is unscanned (council R8-L1).
 */
export function resolveDocumentSource(row: ParseSourceRow, env: NodeJS.ProcessEnv = process.env): ResolvedDocumentSource {
  const key = row.parse_source_key ?? null;
  const sha = row.parse_source_sha256?.trim().toLowerCase() || null;
  const version = row.parse_source_scan_version ?? null;
  if ((key !== null && sha === null) || (sha !== null && !SHA256_HEX.test(sha)) || (key !== null && version === null)) {
    throw new Error(`document ${row.id} has an incomplete scanned parse copy record`);
  }
  if (hasCurrentParseDecision(row)) {
    return key
      ? { sourceKey: key, sourceSha256: sha, originalSourceSha256: row.source_sha256 ?? null, parseSourceDecision: "scanned-copy" }
      : { sourceKey: row.source_key, sourceSha256: sha, parseSourceDecision: "original" };
  }
  if (version === PARSE_SOURCE_SCAN_VERSION) {
    console.error(`[worker-source] status=parse-source-unbound metric=parse_source_unbound document=${row.id} has_hash=${sha !== null}`);
  }
  if (!quarantineRequired(env)) return { sourceKey: row.source_key, sourceSha256: row.source_sha256 ?? null, parseSourceDecision: "unscanned-allowed" };
  return { sourceKey: unscannedParseSourceKey(row.id), sourceSha256: null, parseSourceDecision: "unscanned" };
}

/** A document as the loaders build it (models.ts Document): the resolved fields only. */
export interface SourcedDocument {
  id: string;
  sourceKey: string;
  sourceSha256?: string | null;
  originalSourceSha256?: string | null;
  /** Required on loader documents (models.ts Document). Absent at runtime (a hand-built object): unscanned in production. */
  parseSourceDecision?: ParseSourceDecision;
}

/**
 * The document's decision as the gates read it (informational I-1 tripwire): an object with no decision field was not
 * built by the loader, which always sets one, so in production it is unscanned, never "its own upload".
 */
export function effectiveParseSourceDecision(document: Pick<SourcedDocument, "parseSourceDecision">, env: NodeJS.ProcessEnv = process.env): ParseSourceDecision | undefined {
  if (document.parseSourceDecision === undefined && isProduction(env)) return "unscanned";
  return document.parseSourceDecision;
}

interface UploadSource { key: string; sha256: string | null }
/** The only issuer of uploads the quarantine stage may verify without a decision (sandbox/source-integrity.ts; claimed once, here). */
const issueQuarantineUpload = claimQuarantineUploadIssuer();
/** Loader document -> its upload. Module-private: the only reader is originalSourceForQuarantine. */
const uploads = new WeakMap<object, UploadSource>();

/** The loader's half of resolution: remember the upload for quarantine without putting its key on the document. */
export function bindDocumentUpload(document: SourcedDocument, row: Pick<ParseSourceRow, "source_key" | "source_sha256">): void {
  uploads.set(document, { key: row.source_key, sha256: row.source_sha256 ?? null });
}

/**
 * Throw unless the document may be parsed: refused when it has no decision from this build's quarantine. Every stage but
 * quarantine, the deferred page renderer and materialization call it before reading a byte.
 */
export function assertParseSourceDecided(document: Pick<SourcedDocument, "id" | "parseSourceDecision" | "sourceKey">): void {
  if (effectiveParseSourceDecision(document) === "unscanned" || isUnscannedParseSourceKey(document.sourceKey)) {
    console.error(`[worker-source] status=parse-source-unscanned metric=parse_source_unscanned document=${document.id}`);
    throw new UnscannedParseSourceError(document.id);
  }
}

/** The bytes a parser reads for a document. Refuses an unscanned document. */
export function pdfBytesForParsing(document: SourcedDocument): { key: string; sha256: string | null } {
  assertParseSourceDecided(document);
  return { key: document.sourceKey, sha256: document.sourceSha256 ?? null };
}

/** Whether a scanned copy replaces this document's upload for parsing. */
export function hasScannedParseCopy(document: Pick<SourcedDocument, "parseSourceDecision">): boolean {
  return document.parseSourceDecision === "scanned-copy";
}

/**
 * The upload itself, for the quarantine stage only: it scans the original (and makes the copy). A loader document whose
 * binding is missing (copied or serialized after loading) fails: its key is not the upload's. A document built in memory
 * (no decision field outside production, or "unscanned-allowed": tests) is its own upload.
 */
export function originalSourceForQuarantine(document: SourcedDocument): QuarantineUpload {
  const upload = uploads.get(document);
  if (upload) return issueQuarantineUpload({ id: document.id, sourceKey: upload.key, sourceSha256: upload.sha256 });
  const decision = effectiveParseSourceDecision(document);
  if (decision !== undefined && decision !== "unscanned-allowed") throw new Error(`document ${document.id}: quarantine has no upload binding for a loaded document`);
  return issueQuarantineUpload({ id: document.id, sourceKey: document.sourceKey, sourceSha256: document.sourceSha256 ?? null });
}

/** Point an in-memory document at what quarantine decided: its scanned copy, or the upload bytes it scanned. */
export function applyParseSource(document: SourcedDocument, record: ParseSourceDecisionRecord): void {
  assertParseSourceRecord(record);
  const copy = record.copy;
  const original = originalSourceForQuarantine(document);
  uploads.set(document, { key: original.sourceKey, sha256: original.sourceSha256 });
  if (copy) {
    document.sourceKey = copy.key;
    document.sourceSha256 = copy.sha256;
    document.originalSourceSha256 = original.sourceSha256;
    document.parseSourceDecision = "scanned-copy";
  } else {
    document.sourceKey = original.sourceKey;
    document.sourceSha256 = record.scannedSha256.trim().toLowerCase();
    delete document.originalSourceSha256;
    document.parseSourceDecision = "original";
  }
}

/** Quarantine refused the document: no decision, nothing parses it (its other stages are skipped as failed besides). */
export function clearParseSource(document: SourcedDocument): void {
  const original = originalSourceForQuarantine(document);
  uploads.set(document, { key: original.sourceKey, sha256: original.sourceSha256 });
  document.sourceKey = unscannedParseSourceKey(document.id);
  document.sourceSha256 = null;
  delete document.originalSourceSha256;
  document.parseSourceDecision = "unscanned";
}
