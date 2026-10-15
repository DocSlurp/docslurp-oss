-- Add document_id index on document_chunks for workspace-scoped text search.
-- The hybrid search text path now filters by workspace via a subquery on documents.workspace_id
-- rather than by user_id, making document_id the primary filter column in document_chunks.
-- Without this index, every BM25 query would need a sequential scan filtered by the GIN index.
CREATE INDEX IF NOT EXISTS "document_chunks_document_id_idx"
  ON "document_chunks" USING btree ("document_id");

-- Add workspace_id index on documents for the workspace subquery used in search.
-- This accelerates the "document_id IN (SELECT id FROM documents WHERE workspace_id = $N)" pattern.
CREATE INDEX IF NOT EXISTS "documents_workspace_id_idx"
  ON "documents" USING btree ("workspace_id");
