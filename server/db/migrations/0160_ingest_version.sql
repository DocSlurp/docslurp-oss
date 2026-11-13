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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_ingest_version_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_ingest_version_check
      CHECK (ingest_version >= 0 AND cardinality(ingest_capabilities) <= 32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_runs_ingest_version_check') THEN
    ALTER TABLE project_runs ADD CONSTRAINT project_runs_ingest_version_check
      CHECK (ingest_version >= 0 AND cardinality(ingest_capabilities) <= 32);
  END IF;
END $$;
