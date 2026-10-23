-- Historical versions must not remain in the ingest queue after their Run ends.
-- Keep history and artifacts; retire only already-superseded pending rows with
-- terminal parent Runs. Active, paused and cancelling Runs are not repaired.
UPDATE documents d
SET status = 'cancelled', lexical_searchable_at = NULL, updated_at = now()
FROM workspace_runs r
WHERE r.id = d.run_id
  AND r.status IN ('failed', 'completed')
  AND d.superseded_at IS NOT NULL
  AND d.status IN ('queued', 'processing');
