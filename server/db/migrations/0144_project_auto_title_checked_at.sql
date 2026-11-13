-- The automatic-title sweep (server/src/services/project-naming.ts) took the newest 200 projects whose corpus changed
-- in the last 15 minutes. Projects with nothing to rename kept the first page, older ones aged out of the window
-- for good, and an outage longer than the window left its uploads with filename titles (reads no longer rename).
-- The sweep now records, per project, the project_corpus_stats.updated_at it last examined: a project is pending
-- while that differs from updated_at, however long ago the corpus changed, and the sweep takes the oldest first.
-- Storing the examined updated_at, rather than the time of the check, cannot miss a document that commits after
-- the check with an earlier transaction timestamp. Null for every existing project: each is examined once.
ALTER TABLE project_corpus_stats ADD COLUMN IF NOT EXISTS auto_title_checked_at timestamptz;
