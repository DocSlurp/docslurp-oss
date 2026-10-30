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
}

/**
 * Compare the staged bytes' hash with the document's server hash; remember it for the quarantine.
 * Throws SourceIntegrityError (logged) when they differ.
 */
export function verifyStagedSource(document: HashedDocument, stagedSha256: string): void {
  const actual = stagedSha256.toLowerCase();
  const expected = document.sourceSha256?.trim().toLowerCase() || null;
  if (expected && expected !== actual) {
    console.error(
      `[worker-source] status=source-hash-mismatch metric=source_hash_mismatch document=${document.id} ` +
        `source_key=${JSON.stringify(document.sourceKey)} expected_sha256=${expected} staged_sha256=${actual}`,
    );
    throw new SourceIntegrityError(document.id, expected, actual);
  }
  if (!SHA256_HEX.test(actual)) throw new Error(`staged source hash is not a sha256: ${actual.slice(0, 80)}`);
  staged.delete(document.id);
  staged.set(document.id, actual);
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
export async function readSourceBytes(storage: Pick<ArtifactStore, "getBytes">, document: HashedDocument): Promise<Buffer> {
  const bytes = await storage.getBytes(document.sourceKey);
  verifyStagedSource(document, sha256Bytes(bytes));
  return bytes;
}

/** Tests only. */
export function resetStagedSourcesForTests(): void {
  staged.clear();
}
