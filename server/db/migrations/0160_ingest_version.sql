-- Ingest version tagging (packages/shared/src/ingest-version.ts, docs/ingest-version.md). Each document and run records
-- the ingest version of the pipeline that produced it and a short list of capability flags, so clients can offer a
-- reprocess to documents produced by an older pipeline.
--
-- * ingest_version: a monotonic integer the pipeline bumps when extraction output or required metadata changes. Existing
--   rows backfill to 0 ("unknown"): they were produced before tagging, and nothing about them is inferred.
-- * ingest_capabilities: on documents, what the run measurably stored (parseSourceDecision, pageFacts, figureLedger); on
--   runs, what the completing build supports. Empty for version 0 rows: capabilities are never faked.
--
-- The worker stamps both when a run completes (worker/src/db/ingest-version.ts). ADD COLUMN with a constant default is a
-- catalog-only change, so the backfill rewrites no rows.
--
-- Locking: every statement waits at most 5 s for its lock (lock_timeout, transaction-local) and fails the release instead
-- of queueing behind a long query and blocking documents/project_runs traffic. The CHECKs are added NOT VALID, so adding
-- them scans no rows under ACCESS EXCLUSIVE; they hold for every new and updated row. They are not validated here: drizzle
-- applies pending migrations in one transaction, so a VALIDATE would scan under the lock ADD COLUMN already holds and
-- save nothing. Existing rows all hold 0 and '{}' (the defaults), which satisfy them. Each step checks the catalog first,
-- so a second run changes nothing.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ingest_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ingest_capabilities text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS ingest_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS ingest_capabilities text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
DO $$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'documents_ingest_version_check' AND conrelid = 'public.documents'::regclass) THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_ingest_version_check
      CHECK (ingest_version >= 0 AND cardinality(ingest_capabilities) <= 32) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'project_runs_ingest_version_check' AND conrelid = 'public.project_runs'::regclass) THEN
    ALTER TABLE public.project_runs ADD CONSTRAINT project_runs_ingest_version_check
      CHECK (ingest_version >= 0 AND cardinality(ingest_capabilities) <= 32) NOT VALID;
  END IF;
END $$;
