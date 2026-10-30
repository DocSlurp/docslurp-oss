-- Source files whose parser command was verifiably at fault for a teardown the
-- worker could not complete (CommandTeardownError attributed to the command:
-- its stdio held open after its own processes were gone). The worker that hit
-- it quarantines itself and restarts; this denylist stops the same bytes (by the
-- server-computed documents.source_sha256) from quarantining another worker. A
-- worker refuses to run any parser command for a document whose source is
-- listed and unexpired, and fails that document without retrying it.
-- Deliberately global: one hostile file must not quarantine one worker per
-- uploading organization. Failures from timing or host errors are never listed,
-- and every row expires (default 7 days, WORKER_SOURCE_QUARANTINE_TTL_HOURS) so
-- a false positive heals itself. Delete a row to admit its source sooner.
CREATE TABLE IF NOT EXISTS quarantined_sources (
  source_sha256 text PRIMARY KEY,
  -- First attribution: who uploaded the bytes that first defeated teardown.
  org_id text,
  workspace_id text,
  run_id text,
  document_id text,
  stage text,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Every organization whose document with these bytes defeated teardown or
  -- was refused, in first-seen order, plus the most recent such event.
  org_ids text[] NOT NULL DEFAULT '{}',
  last_org_id text,
  last_document_id text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  teardown_count integer NOT NULL DEFAULT 1,
  refused_count integer NOT NULL DEFAULT 0
);

-- Every unverified parser teardown, counted against the document's organization
-- (worker/src/sandbox/source-quarantine.ts). Each one quarantines a worker,
-- whether or not it was attributable to the bytes, so byte-varied files from
-- one organization could otherwise walk the fleet. Once an organization has
-- WORKER_ORG_TEARDOWN_LIMIT (default 3) rows within
-- WORKER_ORG_TEARDOWN_WINDOW_HOURS (default 24), workers refuse its parser
-- work until the window slides past them. Delete rows to lift it sooner.
CREATE TABLE IF NOT EXISTS org_teardown_failures (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL,
  document_id text,
  run_id text,
  stage text,
  attributable boolean NOT NULL DEFAULT false,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_teardown_failures_org_created_idx ON org_teardown_failures (org_id, created_at);
