-- Pages a document bills, separate from `page_count`.
--
-- `page_count` is the page basis: the pages the extracted text can be split into (form-feed pages for a PDF), which citations,
-- page rows and the page index use. Word, slide, sheet and EPUB files have no form feeds, so the worker's measured count of
-- what the file really holds (LibreOffice pages, slides, text pages) cannot be the page basis. It is recorded here instead and
-- billing (completion page fee, optional features) reads it. Null: the document bills `page_count`.
--
-- No table scan under the ACCESS EXCLUSIVE lock: every statement below is a catalog change only.
--   * A nullable column without a default is metadata only.
--   * `page_count_source text NOT NULL DEFAULT 'counted'` is metadata only too: a constant default is stored once in the
--     catalog (pg_attribute.attmissingval) and read for every existing row, so there is no rewrite, and NOT NULL needs no
--     check because every existing row reads the non-null default.
--   * A CHECK written inline in ADD COLUMN is validated by scanning the whole table (two scans for the two checks, ~1 s per
--     2M rows measured on Postgres 17, all of it with documents unreadable). The checks are added NOT VALID instead: they
--     bind every insert and update from now on, and existing rows satisfy them by construction (billing_pages is null and
--     page_count_source is the default on every one of them). `ALTER TABLE documents VALIDATE CONSTRAINT ...` can mark
--     them validated later, outside a deploy; it takes only SHARE UPDATE EXCLUSIVE.
--
-- The lock prelude is the same in every lock-taking migration of this release (0122, 0123, 0125, 0126, 0127; see 0122).
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE documents IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE upload_session_files IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE organizations, org_memberships IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
LOCK TABLE api_keys IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS billing_pages integer;
--> statement-breakpoint
-- How `billing_pages` was found (pdf-conversion, slides, sheet-rows, text-pages, text-rule, size-estimate).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS billing_pages_method text;
--> statement-breakpoint
-- Where intake's `page_count` came from: `counted` (a PDF's own count, the text rule over a text file, an image's one page) or
-- `assumed` (one page for a format only the worker can count). Forecasts price an assumed count from the file's size.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS page_count_source text NOT NULL DEFAULT 'counted';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_billing_pages_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_billing_pages_check CHECK (billing_pages IS NULL OR billing_pages >= 1) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_page_count_source_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_page_count_source_check CHECK (page_count_source IN ('counted', 'assumed')) NOT VALID;
  END IF;
END $$;
