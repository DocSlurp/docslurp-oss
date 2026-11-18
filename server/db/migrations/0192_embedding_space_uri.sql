-- Which embedding space a vector row belongs to, exactly. The bare `embedding_model` / `model` id these tables keep
-- does not say which provider served it, nor the dimensions or pooling the vectors were made with, so two models
-- that share a bare id are indistinguishable. The space is recorded as one llm:// URI
-- (`llm://<provider>/<model>?dimensions=<n>[&pooling=cls]`, packages/shared `embeddingSpaceUri`), and for a
-- document's index also the level that selected the model (the embedding profile).
--
-- Readers match a row when the bare id matches and, if both the row and the query know a URI, the URIs are equal.
-- Rows written before these columns existed (null) keep matching the model they were built with.
--
-- Nullable, no default and no constraint on the page tables, so adding them rewrites and scans nothing; the writer
-- bounds the value (400 characters). Operator-facing only: no customer API response selects them.
ALTER TABLE vector_indexes
  ADD COLUMN IF NOT EXISTS embedding_model_uri text CHECK (embedding_model_uri IS NULL OR (embedding_model_uri ~ '^llm://[a-z0-9][a-z0-9.-]*/' AND length(embedding_model_uri) <= 400)),
  ADD COLUMN IF NOT EXISTS embedding_model_class text CHECK (embedding_model_class IS NULL OR length(embedding_model_class) <= 200);

ALTER TABLE document_page_states ADD COLUMN IF NOT EXISTS embedding_model_uri text;

ALTER TABLE document_page_vectors ADD COLUMN IF NOT EXISTS model_uri text;
