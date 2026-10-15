-- Content-addressed embedding reuse (worker/src/embeddings/embedding-reuse.ts).
--
-- embed_key is sha256(embedding parameters + exact provider input text), or
-- "ctx:" + a hash of a document's title/text/model for the LLM document
-- context that prefixes chunk preambles. Rows point at the embedding artifact
-- that holds the vector (chunk_index; -1 for document context), so no vector
-- is stored twice. A pointer to a purged artifact simply misses and is
-- overwritten by the next embed of the same input.
--
-- Scoped per organization: vectors are never reused across tenants.
CREATE TABLE IF NOT EXISTS "embedding_reuse_refs" (
  "org_id" text NOT NULL,
  "embed_key" text NOT NULL,
  "artifact_uri" text NOT NULL,
  "chunk_index" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "embedding_reuse_refs_pkey" PRIMARY KEY ("org_id", "embed_key"),
  CONSTRAINT "embedding_reuse_refs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);
