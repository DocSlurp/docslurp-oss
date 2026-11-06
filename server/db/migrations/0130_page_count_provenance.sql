-- Page-count provenance for billing.
--
-- 1. documents.page_count_source defaults to `assumed`: a page count is `counted` only on evidence (a count taken from the
--    bytes at intake, or the worker's own measurement), so an insert that omits the provenance must not claim one.
-- 2. documents.intake_page_count: the page count admission priced, captured at insert and immutable afterwards. The
--    worker authorizes every measured page above it against the balance on every attempt (a retry included), so
--    authorization never depends on page_count or page_count_source, which the measurement itself rewrites. Rows written
--    before this migration keep NULL (read as page_count: their counts were priced as they stand).
--
-- 3. documents.billing_pages may be 0: an Office, slide, sheet or EPUB file whose extractor read no text measured 0 pages, and
--    bills neither a page fee nor a feature (never intake's assumed page). The CHECK is re-added NOT VALID (no scan); every
--    existing row satisfies it by construction (the old CHECK required >= 1).
--
-- 4. document_page_facts.text_equivalents / area_equivalents: what one page costs to process, measured by the worker from
--    the text it extracted (the text rule) and the area it rendered (capped per page); written only for pages above 1. The
--    worker raises documents.billing_pages to page_count plus every page's extra equivalents, so a page stuffed with text
--    (tiny, invisible or off-page text, a giant page) bills the pages it holds. Nullable columns, no default: no rewrite.
--
-- Catalog-only changes (no rewrite, no scan; a nullable column with no default), under ACCESS EXCLUSIVE on documents,
-- which the release's lock prelude already holds in its order (see 0122). The trigger's function touches only NEW/OLD.
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
LOCK TABLE document_page_facts IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE documents ALTER COLUMN page_count_source SET DEFAULT 'assumed';
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS intake_page_count integer CHECK (intake_page_count IS NULL OR intake_page_count >= 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION documents_intake_page_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.intake_page_count := COALESCE(NEW.intake_page_count, NEW.page_count);
  ELSIF OLD.intake_page_count IS NOT NULL THEN
    -- Immutable once set: what admission priced cannot be rewritten by a later measurement or any other writer.
    NEW.intake_page_count := OLD.intake_page_count;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_intake_page_count ON documents;
--> statement-breakpoint
CREATE TRIGGER documents_intake_page_count BEFORE INSERT OR UPDATE OF intake_page_count ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_intake_page_count();
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_billing_pages_check;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_billing_pages_check CHECK (billing_pages IS NULL OR billing_pages >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE document_page_facts ADD COLUMN IF NOT EXISTS text_equivalents integer CHECK (text_equivalents IS NULL OR text_equivalents >= 1);
--> statement-breakpoint
ALTER TABLE document_page_facts ADD COLUMN IF NOT EXISTS area_equivalents integer CHECK (area_equivalents IS NULL OR area_equivalents >= 1);
