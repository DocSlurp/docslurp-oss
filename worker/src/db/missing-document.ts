/** The document row is gone (DELETE /v1/documents/:id hard-deletes it while runs may still hold it in memory). */
export class DocumentNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`document not found: ${documentId}`);
    this.name = "DocumentNotFoundError";
  }
}

/**
 * The document exists but not in the scope the caller asked for (another organization or run, or no organization). Never a
 * deletion: a caller that treats a missing document as deleted must fail loudly instead, as nothing it may read was found.
 */
export class DocumentOutOfScopeError extends Error {
  /** `mismatch`: the scope predicate the row failed (its organization, its run, or both). */
  constructor(readonly documentId: string, readonly mismatch: "org" | "run" | "org and run") {
    super(`document ${documentId} is outside the caller's scope (${mismatch} mismatch)`);
    this.name = "DocumentOutOfScopeError";
  }
}

/** Foreign-key violation on a document reference: the document row was deleted after the worker loaded it. */
export function isMissingDocumentError(error: unknown): boolean {
  if (error instanceof DocumentNotFoundError) return true;
  const pg = error as { code?: string; constraint_name?: string } | null;
  return pg?.code === "23503" && /_document_id_fkey$/.test(pg.constraint_name ?? "");
}
