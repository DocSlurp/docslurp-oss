-- A LanceDB delete only hides rows: their bytes stay in the table's older versions, and in the
-- fragment a later compaction replaces, until a maintenance pass prunes history after the
-- version-retention window. Maintenance was due only after new writes, so a table nobody wrote
-- to again kept deleted documents' text indefinitely.
--
-- history_prune_due_at: when set, the maintenance sweep runs one pass at that time whatever the
-- write counters say. Deletes set it to now() + retention; the pass clears it, or re-arms it once
-- when it compacted (the fragment it replaced needs one more pass after retention).
ALTER TABLE vector_index_tables ADD COLUMN IF NOT EXISTS history_prune_due_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vector_index_tables_history_prune_due_idx
  ON vector_index_tables (history_prune_due_at) WHERE history_prune_due_at IS NOT NULL;
