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
