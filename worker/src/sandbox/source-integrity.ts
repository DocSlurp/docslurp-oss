import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { ArtifactStore, StorageReadOptions } from "../tools/storage.js";

/**
 * Source integrity: the bytes a worker stages for a document are the bytes the server hashed.
 *
 * The server hashes a source once (`documents.source_sha256`) and the worker downloads it later by
 * key. Anything that changes the object in between (a still-valid presigned PUT, a storage bug, an
 * operator) would otherwise let a worker parse bytes nobody hashed, and let the source quarantine
 * (source-quarantine.ts) list or admit the wrong bytes: list a popular file's hash for a hostile
 * one, or hide listed hostile bytes behind a fresh hash. So every staged source is hashed as staged
 * and compared with `documents.source_sha256`. A mismatch refuses the document loudly
 * (`[worker-source] status=source-hash-mismatch`) with a SourceIntegrityError: final, never retried,
 * no parser runs on it. The staged hash is also what the quarantine records and checks.
 *
 * A document without a server hash (`source_sha256` null) is staged as is; its staged hash still
 * keys the quarantine for it.
 */

/** A document the worker refuses for its source: never retried, never another strategy. */
export class SourceRefusalError extends Error {
  constructor(message: string, readonly documentId: string) {
    super(message);
    this.name = "SourceRefusalError";
  }
}

/** The staged bytes are not the bytes the server hashed. */
export class SourceIntegrityError extends SourceRefusalError {
  constructor(documentId: string, readonly expectedSha256: string, readonly stagedSha256: string) {
    super(`document ${documentId} refused: its source changed after upload`, documentId);
    this.name = "SourceIntegrityError";
  }
}

/**
 * A parser staged the original upload of a document whose quarantine replaced it with a scanned copy (lib/parse-source.ts):
 * those bytes were never scanned as a parser reads them. Final, like any source refusal.
 */
export class ParseSourceError extends SourceRefusalError {
  constructor(documentId: string) {
    super(`document ${documentId} refused: a parser read its original instead of the scanned copy`, documentId);
    this.name = "ParseSourceError";
  }
}

/**
 * A document with no parse decision from this build's quarantine (lib/parse-source.ts): refused before any parser reads a
 * byte. The text leads with a quarantine reason code, which public-errors.ts maps to reviewed copy.
 */
export class UnscannedParseSourceError extends SourceRefusalError {
  static readonly CODE = "parse-source-unscanned";
  constructor(documentId: string, detail = "it has no parse decision from this build's quarantine") {
    super(`quarantined [${UnscannedParseSourceError.CODE}]: document ${documentId} refused: ${detail}`, documentId);
    this.name = "UnscannedParseSourceError";
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const STAGED_LIMIT = 4096;
/** documentId -> sha256 of the bytes this process staged for it (bounded, oldest first out). */
const staged = new Map<string, string>();

/** The hash of the bytes this worker staged for the document, if it staged them. */
export function stagedSourceSha256(documentId: string): string | null {
  return staged.get(documentId) ?? null;
}

interface HashedDocument {
  id: string;
  sourceKey: string;
  sourceSha256?: string | null;
  /** Set when quarantine's scanned copy replaces the upload for parsing (lib/parse-source.ts): the upload's hash. */
  originalSourceSha256?: string | null;
  /** lib/parse-source.ts: "unscanned" (no decision from this build's quarantine) is refused before any byte is read. */
  parseSourceDecision?: string;
}

/**
 * lib/parse-source.ts assertParseSourceDecided (which imports this module): an unscanned document, or its unreadable key
 * (lib/parse-source.ts unscannedParseSourceKey starts with a NUL byte), is refused before any byte is read.
 */
function assertDecided(document: HashedDocument): void {
  // A document with no decision field was not built by the loader (which always sets one): unscanned in production (I-1).
  const missing = document.parseSourceDecision === undefined && (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  if (missing || document.parseSourceDecision === "unscanned" || (typeof document.sourceKey === "string" && document.sourceKey.startsWith("\u0000"))) {
    console.error(`[worker-source] status=parse-source-unscanned metric=parse_source_unscanned document=${document.id}`);
    throw new UnscannedParseSourceError(document.id);
  }
}

/**
 * Compare the staged bytes' hash with the document's server hash; remember it for the quarantine.
 * Throws SourceIntegrityError (logged) when they differ. Refuses a document with no parse decision first: this is every
 * parser's check. The quarantine stage verifies the upload it is about to decide with verifyQuarantineUpload instead.
 */
export function verifyStagedSource(document: HashedDocument, stagedSha256: string): void {
  assertDecided(document);
  verifyHash(document, stagedSha256);
}

/** The upload as the quarantine stage stages it (lib/parse-source.ts originalSourceForQuarantine): no decision yet. */
export interface QuarantineUpload {
  readonly id: string;
  readonly sourceKey: string;
  readonly sourceSha256: string | null;
}

/** Uploads issued by the one holder of the issuer (lib/parse-source.ts originalSourceForQuarantine). Module-private. */
const issuedUploads = new WeakSet<object>();
let issuerClaimed = false;

/**
 * The capability to issue uploads that verifyQuarantineUpload accepts. It is claimed once: lib/parse-source.ts claims it
 * when it loads, beside the module-private upload bindings only quarantine reads. Any other claim throws, and if another
 * module claimed it first, parse-source's own claim throws at load, so the worker cannot start (fail closed).
 */
export function claimQuarantineUploadIssuer(): (upload: QuarantineUpload) => QuarantineUpload {
  if (issuerClaimed) throw new Error("the quarantine upload issuer is already claimed");
  issuerClaimed = true;
  return (upload) => {
    const issued = Object.freeze({ id: upload.id, sourceKey: upload.sourceKey, sourceSha256: upload.sourceSha256 });
    issuedUploads.add(issued);
    return issued;
  };
}

/**
 * The quarantine stage's check of the upload it scans: the scanned bytes must be the bytes the server hashed. No parse
 * decision is required, because quarantine is what records one: a fresh upload is "unscanned" until it finishes, and in
 * production (I-1) an object without a decision field is unscanned too, so verifyStagedSource refuses every upload here.
 * Everything else still holds: the unreadable key is refused, and a hash mismatch is a final SourceIntegrityError.
 *
 * Only an upload issued by originalSourceForQuarantine (frozen, from the loader's binding) is accepted; anything else,
 * including a copy of an issued one, is refused before any check. Parsers use verifyStagedSource.
 */
export function verifyQuarantineUpload(upload: QuarantineUpload, stagedSha256: string): void {
  if (!issuedUploads.has(upload)) {
    console.error(`[worker-source] status=quarantine-upload-unissued metric=quarantine_upload_unissued document=${String((upload as { id?: unknown })?.id)}`);
    throw new Error("quarantine upload verification refused: the upload was not issued by originalSourceForQuarantine");
  }
  if (typeof upload.sourceKey !== "string" || upload.sourceKey.startsWith("\u0000")) {
    console.error(`[worker-source] status=parse-source-unscanned metric=parse_source_unscanned document=${upload.id}`);
    throw new UnscannedParseSourceError(upload.id, "quarantine was handed an unreadable key instead of the upload");
  }
  verifyHash({ id: upload.id, sourceKey: upload.sourceKey, sourceSha256: upload.sourceSha256 }, stagedSha256);
}

function verifyHash(document: HashedDocument, stagedSha256: string): void {
  const actual = stagedSha256.toLowerCase();
  const expected = document.sourceSha256?.trim().toLowerCase() || null;
  // Scan what we parse: the original of a document with a scanned copy is never parsed, whatever key it was fetched by.
  const original = document.originalSourceSha256?.trim().toLowerCase() || null;
  if (original && original !== expected && original === actual) {
    console.error(`[worker-source] status=parse-source-original metric=parse_source_original document=${document.id} source_key=${JSON.stringify(document.sourceKey)}`);
    throw new ParseSourceError(document.id);
  }
  if (expected && expected !== actual) {
    console.error(
      `[worker-source] status=source-hash-mismatch metric=source_hash_mismatch document=${document.id} ` +
        `source_key=${JSON.stringify(document.sourceKey)} expected_sha256=${expected} staged_sha256=${actual}`,
    );
    throw new SourceIntegrityError(document.id, expected, actual);
  }
  if (!SHA256_HEX.test(actual)) throw new Error(`staged source hash is not a sha256: ${actual.slice(0, 80)}`);
  staged.delete(document.id);
  // The source quarantine (source-quarantine.ts) lists and checks uploads: a scanned copy (lib/parse-source.ts) is keyed by
  // the upload it was made from, whose server hash is stable, never by the copy's own (qpdf's copies differ run to run).
  staged.set(document.id, original && SHA256_HEX.test(original) ? original : actual);
  while (staged.size > STAGED_LIMIT) staged.delete(staged.keys().next().value!);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Download a document's source to a temp file and verify it (the file is removed on refusal). */
export async function stageSourceFile(
  storage: Pick<ArtifactStore, "downloadToTempFile">,
  document: HashedDocument,
  pattern: string,
  options?: StorageReadOptions,
): Promise<string> {
  assertDecided(document);
  const filePath = await storage.downloadToTempFile(document.sourceKey, pattern, options);
  try {
    verifyStagedSource(document, await sha256File(filePath));
    return filePath;
  } catch (error) {
    // downloadToTempFile makes a private docslurp-* directory per download; remove only that.
    const directory = path.dirname(filePath);
    await rm(path.basename(directory).startsWith("docslurp-") ? directory : filePath, { recursive: true, force: true });
    throw error;
  }
}

/** Read a document's source bytes and verify them. */
export async function readSourceBytes(storage: Pick<ArtifactStore, "getBytes">, document: HashedDocument, options?: StorageReadOptions): Promise<Buffer> {
  assertDecided(document);
  const bytes = await storage.getBytes(document.sourceKey, options);
  verifyStagedSource(document, sha256Bytes(bytes));
  return bytes;
}

/** Tests only. */
export function resetStagedSourcesForTests(): void {
  staged.clear();
}
