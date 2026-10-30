-- Quality fast keeps pages without a text layer as rendered page images, up to
-- a per-run cap (WORKER_FAST_PAGE_IMAGE_MAX_PER_RUN). The cap is shared by every
-- worker that renders for the run, so its count lives here: a reservation locks
-- the run's budget row, and each document's grant is recorded once so page-range
-- shards, retries and a restarted worker reuse it instead of spending again.
CREATE TABLE IF NOT EXISTS "run_fast_page_image_budgets" (
	"run_id" text PRIMARY KEY NOT NULL REFERENCES "workspace_runs"("id") ON DELETE CASCADE,
	"used" integer DEFAULT 0 NOT NULL CHECK ("used" >= 0),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_fast_page_image_grants" (
	"run_id" text NOT NULL REFERENCES "workspace_runs"("id") ON DELETE CASCADE,
	"document_id" text NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
	"granted" integer NOT NULL CHECK ("granted" >= 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("run_id", "document_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_fast_page_image_grants_document_idx" ON "run_fast_page_image_grants" ("document_id");
--> statement-breakpoint
-- A grant may only name one of the run's own documents (same run, workspace and
-- organization), so one tenant's run can never spend or read a budget for
-- another tenant's document. The worker checks the same rule before reserving.
CREATE OR REPLACE FUNCTION "run_fast_page_image_grant_owned"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "documents" d JOIN "workspace_runs" r ON r."id" = d."run_id"
		WHERE d."id" = NEW."document_id" AND r."id" = NEW."run_id"
			AND d."workspace_id" IS NOT DISTINCT FROM r."workspace_id"
			AND d."org_id" IS NOT DISTINCT FROM r."org_id"
	) THEN
		RAISE EXCEPTION 'run_fast_page_image_grants: document % does not belong to run %', NEW."document_id", NEW."run_id"
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "run_fast_page_image_grants_owned" ON "run_fast_page_image_grants";
--> statement-breakpoint
CREATE TRIGGER "run_fast_page_image_grants_owned"
	BEFORE INSERT OR UPDATE OF "run_id", "document_id" ON "run_fast_page_image_grants"
	FOR EACH ROW EXECUTE FUNCTION "run_fast_page_image_grant_owned"();
--> statement-breakpoint
-- A materialization run that read a page with a model records it here, under the
-- page row lock, even when it lost its claim and published nothing. The page's
-- single customer charge is Rich when such a read exists for this document
-- version (worker/src/db/page-base-fee.ts), so a genuine read is never billed as
-- Fast and never billed twice.
ALTER TABLE "document_page_states" ADD COLUMN IF NOT EXISTS "model_read_run" text;
--> statement-breakpoint
ALTER TABLE "document_page_states" ADD COLUMN IF NOT EXISTS "model_read_pages" integer CHECK ("model_read_pages" IS NULL OR "model_read_pages" >= 1);
--> statement-breakpoint
-- A page this run owned, read with a model (one Rich charge, committed with this
-- stamp) and then failed after the read (embedding, vector write, PII). The page's
-- one customer charge for this document version is made: a later run that indexes
-- it stamps it with no new charge. `read_text` keeps the read (only when the PII
-- scan found nothing, so a retry re-reads under the policy then in force) so a
-- retry indexes it without calling the model again. It is page content: cleared
-- when the page turns indexed or PII-blocked, by artifact retention and by a
-- human-correction reindex (`read_billed_run` stays).
ALTER TABLE "document_page_states" ADD COLUMN IF NOT EXISTS "read_billed_run" text;
--> statement-breakpoint
ALTER TABLE "document_page_states" ADD COLUMN IF NOT EXISTS "read_text" text;
--> statement-breakpoint
-- storage_cleanup_queue kind 'vector_rows': deferred-materialization vector ids
-- whose delete failed, or whose publication's COMMIT outcome was unknown. The
-- worker sweep deletes only the ids no document_chunks row names.
ALTER TABLE storage_cleanup_queue DROP CONSTRAINT IF EXISTS storage_cleanup_queue_kind_check;
--> statement-breakpoint
ALTER TABLE storage_cleanup_queue ADD CONSTRAINT storage_cleanup_queue_kind_check
  CHECK (kind IN ('storage_prefix', 'vector_table', 'vector_prefix', 'vector_rows', 'upload_original'));
