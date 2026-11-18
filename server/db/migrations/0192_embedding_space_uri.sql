-- Which embedding space a vector row belongs to, exactly. The bare `embedding_model` / `model` id these tables keep
-- does not say which provider served it, nor the dimensions or pooling the vectors were made with, so two models
-- that share a bare id are indistinguishable. The space is recorded as one llm:// URI
-- (`llm://<provider>/<model>?dimensions=<n>[&pooling=cls]`, packages/shared `embeddingSpaceUri`), and for a
-- document's index also the level that selected the model (the embedding profile).
--
-- Readers match a row when the bare id matches and, if both the row and the query know a URI, the URIs are equal.
-- Rows written before these columns existed (null) keep matching the model they were built with, and also any other
-- space that shares their bare id and dimension: only rows written from this migration on are told apart.
--
-- Every column is nullable with no default, so adding it rewrites and scans nothing. The vector_indexes checks are
-- added NOT VALID in a catalog-guarded block (enforced on new writes, existing rows are not scanned); the page tables
-- get none (the writer bounds the value to 400 characters). lock_timeout fails the deploy instead of queueing readers
-- behind the brief ACCESS EXCLUSIVE lock each ALTER takes. Operator-facing only: no customer API response selects them.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE vector_indexes
  ADD COLUMN IF NOT EXISTS embedding_model_uri text,
  ADD COLUMN IF NOT EXISTS embedding_model_class text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.vector_indexes'::regclass AND conname = 'vector_indexes_embedding_model_uri_check') THEN
    ALTER TABLE vector_indexes ADD CONSTRAINT vector_indexes_embedding_model_uri_check
      CHECK (embedding_model_uri IS NULL OR (embedding_model_uri ~ '^llm://[a-z0-9][a-z0-9.-]*/' AND length(embedding_model_uri) <= 400)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.vector_indexes'::regclass AND conname = 'vector_indexes_embedding_model_class_check') THEN
    ALTER TABLE vector_indexes ADD CONSTRAINT vector_indexes_embedding_model_class_check
      CHECK (embedding_model_class IS NULL OR length(embedding_model_class) <= 200) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE document_page_states ADD COLUMN IF NOT EXISTS embedding_model_uri text;
--> statement-breakpoint
ALTER TABLE document_page_vectors ADD COLUMN IF NOT EXISTS model_uri text;
--> statement-breakpoint
-- Which models served a run, per service, as the worker resolved them when it first picked the run up: the project
-- names levels and the deployment's environment maps them to models, so the run snapshot (`pipeline`) does not say.
-- `{ "<service>": { "uri": "llm://…", "class": "name=value;…" } }`, set once; every model call still records its
-- own model on its usage row. Operator-facing only: no customer run response selects it.
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS resolved_models jsonb;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
