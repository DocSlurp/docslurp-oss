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
