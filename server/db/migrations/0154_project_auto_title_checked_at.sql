-- The automatic-title sweep (server/src/services/project-naming.ts) took the newest 200 projects whose corpus changed
-- in the last 15 minutes. Projects with nothing to rename kept the first page, older ones aged out of the window
-- for good, and an outage longer than the window left its uploads with filename titles (reads no longer rename).
-- The sweep now records, per project, the project_corpus_stats.updated_at it last examined: a project is pending
-- while that differs from updated_at, however long ago the corpus changed, and the sweep takes the oldest first.
-- Storing the examined updated_at, rather than the time of the check, cannot miss a document that commits after
-- the check with an earlier transaction timestamp. Null for every existing project: each is examined once.
ALTER TABLE project_corpus_stats ADD COLUMN IF NOT EXISTS auto_title_checked_at timestamptz;
--> statement-breakpoint
-- The sweep's queue: projects whose corpus changed since they were last examined, oldest first. Partial, so a
-- drained queue is an empty index scan instead of a scan and sort of every stats row on each tick.
CREATE INDEX IF NOT EXISTS project_corpus_stats_auto_title_pending_idx
  ON project_corpus_stats (updated_at, project_id)
  WHERE auto_title_checked_at IS DISTINCT FROM updated_at;
--> statement-breakpoint
-- Title evidence can arrive after the corpus stops changing: with indexing before enrichment a document completes
-- (moving updated_at, so the sweep examines and marks the project) and its summary is written afterwards. A written
-- summary re-queues its project. It always row-locks the project's stats row, the row the sweep claims with
-- FOR UPDATE SKIP LOCKED for its whole examine-rename-checkpoint transaction, so a summary and a sweep serialize
-- and no interleaving loses the summary; it writes only when the project was already examined.
CREATE OR REPLACE FUNCTION project_auto_title_evidence_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stats_project_id text;
BEGIN
  SELECT cs.project_id INTO stats_project_id
  FROM project_corpus_stats cs JOIN documents d ON d.project_id = cs.project_id
  WHERE d.id = NEW.document_id
  FOR NO KEY UPDATE OF cs;
  IF stats_project_id IS NOT NULL THEN
    UPDATE project_corpus_stats SET auto_title_checked_at = NULL
    WHERE project_id = stats_project_id AND auto_title_checked_at IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_auto_title_evidence_changed ON document_summaries;
--> statement-breakpoint
CREATE TRIGGER project_auto_title_evidence_changed AFTER INSERT OR UPDATE OF summary ON document_summaries
  FOR EACH ROW EXECUTE FUNCTION project_auto_title_evidence_changed();
