-- The figure resume runner (docs/extraction/doppler-figures.md, "Resuming partial figures"). One lease per document on
-- its extraction level, no queue table: a document can only be queued once. Attempts are #355's host-side resume
-- counters (document_extraction_levels.resumes, document_extraction_shards.resumes, at most 3).
--
-- * resume_after: when the runner may claim the document; set in the same transaction that commits a resumable level
--   (the project's `figureResume` is `auto`), by a backstop sweep, or by an on-demand request; null when not queued.
-- * resume_lease_until / resume_lease_owner: a claimed document (for update skip locked, at most one per organization);
--   an expired lease is claimable again.
-- * resume_blocked: why the runner stopped (attempts spent, figures or resume off for the project, the document moved to
--   another run); a request or a fresh pass clears it.
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_after timestamptz;
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_lease_until timestamptz;
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_lease_owner text CHECK (char_length(resume_lease_owner) <= 128);
--> statement-breakpoint
-- Failed resume attempts (a VM or provider failure writes nothing, so #355's `resumes` counter does not move): blocked at 3.
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_failures integer NOT NULL DEFAULT 0 CHECK (resume_failures BETWEEN 0 AND 1000);
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_blocked text
  CHECK (resume_blocked IN ('attempts', 'figures-off', 'resume-off', 'stale', 'refused'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_extraction_levels_resume_queue_idx
  ON document_extraction_levels (resume_after, org_id) WHERE resume_after IS NOT NULL AND resume_blocked IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_extraction_levels_resume_lease_idx
  ON document_extraction_levels (org_id) WHERE resume_lease_until IS NOT NULL;
--> statement-breakpoint
-- Resume VM launches over the document's lifetime (H4): counted as each VM starts, never reset by a request, reset only
-- when the level moves to a new run (a fresh, customer-paid pass). Blocked `attempts` past FIGURE_RESUME_LIMITS.maxVmLaunches.
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS resume_vm_launches integer NOT NULL DEFAULT 0 CHECK (resume_vm_launches BETWEEN 0 AND 1000);
--> statement-breakpoint
-- The audit's cursor (oldest audited first, never a full-table random scan).
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS audited_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_extraction_levels_audit_idx
  ON document_extraction_levels (audited_at NULLS FIRST, document_id) WHERE asset_bytes > 0 OR assets_pending > 0 OR NOT assets_current;
--> statement-breakpoint
-- Resume VM time per organization per UTC day (H4): checked at claim against FIGURE_RESUME_LIMITS.orgDailyVmMinutes.
CREATE TABLE IF NOT EXISTS figure_resume_org_days (
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  launches integer NOT NULL DEFAULT 0 CHECK (launches >= 0),
  vm_ms bigint NOT NULL DEFAULT 0 CHECK (vm_ms >= 0),
  PRIMARY KEY (org_id, day)
);
--> statement-breakpoint
-- Applied chat proposals (single use): a token's id is recorded on Apply; a replay is refused.
CREATE TABLE IF NOT EXISTS figure_resume_proposal_uses (
  jti text PRIMARY KEY CHECK (char_length(jti) BETWEEN 16 AND 64),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS figure_resume_proposal_uses_used_idx ON figure_resume_proposal_uses (used_at);
