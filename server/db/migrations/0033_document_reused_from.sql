-- Partial reprocess (restartFromStage / stageSubset): the new document version
-- reuses the outputs of the stages it skips from this source document. The
-- worker seeds stage states, artifacts and derived rows from it before the
-- first stage runs, and the superseded-version purge keeps the source's
-- storage artifacts while a document still reuses them.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "reused_from_document_id" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reused_from_document_id_fkey" FOREIGN KEY ("reused_from_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_reused_from_document_id_idx" ON "documents" USING btree ("reused_from_document_id") WHERE "reused_from_document_id" IS NOT NULL;
