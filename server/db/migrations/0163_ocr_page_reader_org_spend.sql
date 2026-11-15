-- Page reader spend per organization per UTC day (worker/src/ocr/page-reader-budget.ts, DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS).
-- Reader usage bills 0 credits, so the run cost cap does not bound its provider cost; this ledger does, fleet-wide.
--
-- Each reader job admits a ticket before it is sent: under the organization's advisory lock, the day's settled cost plus the
-- reservations of unsettled tickets plus this job's reservation must stay within the cap, or the job is not sent. The job
-- settles its ticket with the provider cost it recorded. A ticket a crashed worker never settled keeps its reservation for
-- the rest of the day (fail closed). Rows older than two days are deleted by later admissions.
CREATE TABLE IF NOT EXISTS ocr_page_reader_org_spend (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  day date NOT NULL,
  reserved_cents numeric(14, 4) NOT NULL CHECK (reserved_cents >= 0),
  cost_cents numeric(14, 4) NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ocr_page_reader_org_spend_org_day_idx ON ocr_page_reader_org_spend (org_id, day);
--> statement-breakpoint
-- The worker admits, settles and purges tickets; server/db/roles.mjs reconciles the same grants after every migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.ocr_page_reader_org_spend FROM docslurp_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.ocr_page_reader_org_spend TO docslurp_worker;
  END IF;
END $$;
