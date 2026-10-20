/** The document row is gone (DELETE /v1/documents/:id hard-deletes it while runs may still hold it in memory). */
export class DocumentNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`document not found: ${documentId}`);
    this.name = "DocumentNotFoundError";
  }
}

/** Foreign-key violation on a document reference: the document row was deleted after the worker loaded it. */
export function isMissingDocumentError(error: unknown): boolean {
  if (error instanceof DocumentNotFoundError) return true;
  const pg = error as { code?: string; constraint_name?: string } | null;
  return pg?.code === "23503" && /_document_id_fkey$/.test(pg.constraint_name ?? "");
}
