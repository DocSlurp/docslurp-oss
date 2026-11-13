-- Figure resume budgets (packages/shared/src/figure-resume-limits.ts; docs/extraction/doppler-figures.md, "Caps"). The
-- lifetime launch cap now scales with the document's pages, and two more stops join it:
--
-- * resume_vm_ms: measured resume VM time of the document's current run, charged against its page-scaled VM budget.
-- * resume_stalls: resumes in a row that added no file and closed no work; at the limit the document is blocked
--   `no-progress`. Any progress resets it.
-- * resume_grants: extensions a single-document request granted past a budget block (bounded per run).
-- * resume_blocked_at: when the current block was set (visible with its reason).
-- * resume_unit_stalls: the same no-progress count per resume unit.
--
-- All five start clean when the level moves to a new run (a fresh, customer-paid pass), like the 0159 counters.
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_vm_ms bigint NOT NULL DEFAULT 0 CHECK (resume_vm_ms >= 0);
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_stalls integer NOT NULL DEFAULT 0 CHECK (resume_stalls BETWEEN 0 AND 1000);
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_grants integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- At most FIGURE_RESUME_HARD.grants (10, DOCSLURP_FIGURE_RESUME_MAX_GRANTS's bound), by name, so a database that applied an
-- earlier version of this migration (CHECK at 100) converges.
DO $$
BEGIN
  ALTER TABLE document_extraction_levels DROP CONSTRAINT IF EXISTS document_extraction_levels_resume_grants_check;
  ALTER TABLE document_extraction_levels ADD CONSTRAINT document_extraction_levels_resume_grants_check CHECK (resume_grants BETWEEN 0 AND 10);
END $$;
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_blocked_at timestamptz;
--> statement-breakpoint
-- No-progress resumes per resume unit (`{"<first>-<last>" | "doc": n}`), beside 0159's resume_unit_failures: a unit at
-- its limit is closed and the others keep resuming (one poisoned shard never blocks the document).
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_unit_stalls jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
-- The block reasons, with the two new budget stops (`vm-budget`, `no-progress`), dropped and re-added by name so the
-- statement converges on every database.
DO $$
BEGIN
  ALTER TABLE document_extraction_levels DROP CONSTRAINT IF EXISTS document_extraction_levels_resume_blocked_check;
  ALTER TABLE document_extraction_levels ADD CONSTRAINT document_extraction_levels_resume_blocked_check
    CHECK (resume_blocked IN ('attempts', 'vm-budget', 'no-progress', 'figures-off', 'resume-off', 'stale', 'refused', 'unscanned'));
END $$;
