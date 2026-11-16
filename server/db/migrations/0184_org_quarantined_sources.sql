-- Organization isolation: the source quarantine is per organization. A row
-- lists one content hash for one organization, with its own expiry and counts:
-- a hash listed after organization A's parser teardown failure refuses only A's
-- documents, and organization B's identical upload is parsed in its own VM. One
-- organization's teardown never lists, extends or revives another's refusal, so
-- none can observe another's uploads through it. Supersedes migration 0101's
-- "deliberately global" table: one hostile file may now cost one worker per
-- uploading organization, bounded per organization by org_teardown_failures.
-- Expand step: a new table, so release N-1 keeps using quarantined_sources
-- (0101) until it is gone; a later release drops that table (contract).
-- Listings do not carry over: they expire within 7 days and the per-org
-- breaker bounds re-listing.
CREATE TABLE IF NOT EXISTS org_quarantined_sources (
  source_sha256 text NOT NULL,
  org_id text NOT NULL,
  -- First attribution within the organization.
  project_id text,
  run_id text,
  document_id text,
  stage text,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_document_id text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  teardown_count integer NOT NULL DEFAULT 1,
  refused_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (source_sha256, org_id)
);
--> statement-breakpoint
REVOKE ALL ON public.org_quarantined_sources FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON public.org_quarantined_sources TO docslurp_worker;
  END IF;
END $$;
