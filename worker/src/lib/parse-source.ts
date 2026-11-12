/*
 * Scan what we parse (PR #339, council round 6, R6-H1).
 *
 * Readers resolve an encrypted PDF's objects in different places: poppler starts at the section after a linearization
 * dictionary, qpdf, pdf.js and MuPDF at `startxref`, so one file can show poppler a page that the scan of qpdf's decrypted
 * copy never saw. Modelling every such divergence is a losing game. Instead, quarantine stores the qpdf-decrypted,
 * normalized copy it scanned (made in the parser VM: one cross-reference table, no object streams, every generalized
 * filter decoded) and every parser reads that copy. The original stays only for "download original" and exports.
 *
 * The copy is recorded on the document row (`documents.parse_source_key` / `parse_source_sha256`, migration 0134), and the
 * worker's document loader (db/store.ts mapDocument) resolves it here: `Document.sourceKey` and `Document.sourceSha256`
 * are the bytes for parsing, `originalSourceKey` / `originalSourceSha256` the upload. Every staged read is hash-checked
 * against `sourceSha256` (sandbox/source-integrity.ts), so a reader that fetched the original of a document with a scanned
 * copy is refused (`ParseSourceError`), never parsed. Only the quarantine stage reads the original
 * (`originalSourceForQuarantine`); parse-source.test.ts fails when any other worker module names it.
 */

/** The row fields the resolver reads (documents.source_key, source_sha256, parse_source_key, parse_source_sha256). */
export interface ParseSourceRow {
  source_key: string;
  source_sha256?: string | null;
  parse_source_key?: string | null;
  parse_source_sha256?: string | null;
}

/** The scanned copy quarantine recorded for a document: what every parser reads instead of the upload. */
export interface ScannedParseSource {
  key: string;
  sha256: string;
}

export interface ResolvedDocumentSource {
  /** The bytes for parsing: the scanned copy when there is one, else the upload. */
  sourceKey: string;
  sourceSha256: string | null;
  /** The upload as received; set (and different from `sourceKey`) only when a scanned copy replaces it for parsing. */
  originalSourceKey?: string;
  originalSourceSha256?: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The document's sources, from its row. A half-recorded copy (a key without a sha256 or the reverse, or a hash that is not
 * one) fails loudly: falling back to the original would hand parsers bytes nobody scanned as they will read them.
 */
export function resolveDocumentSource(row: ParseSourceRow): ResolvedDocumentSource {
  const key = row.parse_source_key ?? null;
  const sha = row.parse_source_sha256?.trim().toLowerCase() || null;
  if (key === null && sha === null) return { sourceKey: row.source_key, sourceSha256: row.source_sha256 ?? null };
  if (!key || !sha || !SHA256_HEX.test(sha)) throw new Error(`document source ${JSON.stringify(row.source_key)} has an incomplete scanned parse copy record`);
  return { sourceKey: key, sourceSha256: sha, originalSourceKey: row.source_key, originalSourceSha256: row.source_sha256 ?? null };
}

/** A document as the loaders build it (models.ts Document): the resolved fields only. */
export interface SourcedDocument {
  id: string;
  sourceKey: string;
  sourceSha256?: string | null;
  originalSourceKey?: string;
  originalSourceSha256?: string | null;
}

/**
 * The bytes a parser reads for a document (the scanned copy of an encrypted PDF, else the upload). Every parser already
 * reads `document.sourceKey`, which the loader resolved; this names the invariant for new code.
 */
export function pdfBytesForParsing(document: SourcedDocument): { key: string; sha256: string | null } {
  return { key: document.sourceKey, sha256: document.sourceSha256 ?? null };
}

/** Whether a scanned copy replaces this document's upload for parsing. */
export function hasScannedParseCopy(document: SourcedDocument): boolean {
  return document.originalSourceKey !== undefined && document.originalSourceKey !== document.sourceKey;
}

/**
 * The upload itself, for the quarantine stage only: it scans the original (and makes the copy). Any other caller is a
 * parser reading bytes nobody scanned as it reads them; parse-source.test.ts enforces the single caller.
 */
export function originalSourceForQuarantine(document: SourcedDocument): { id: string; sourceKey: string; sourceSha256: string | null } {
  return hasScannedParseCopy(document)
    ? { id: document.id, sourceKey: document.originalSourceKey!, sourceSha256: document.originalSourceSha256 ?? null }
    : { id: document.id, sourceKey: document.sourceKey, sourceSha256: document.sourceSha256 ?? null };
}

/** Point an in-memory document at its scanned copy (`copy`) or back at its upload (null), as quarantine recorded it. */
export function applyParseSource(document: SourcedDocument, copy: ScannedParseSource | null): void {
  const original = originalSourceForQuarantine(document);
  if (copy) {
    document.originalSourceKey = original.sourceKey;
    document.originalSourceSha256 = original.sourceSha256;
    document.sourceKey = copy.key;
    document.sourceSha256 = copy.sha256;
  } else {
    document.sourceKey = original.sourceKey;
    document.sourceSha256 = original.sourceSha256;
    delete document.originalSourceKey;
    delete document.originalSourceSha256;
  }
}
