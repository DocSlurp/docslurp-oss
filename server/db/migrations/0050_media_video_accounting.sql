ALTER TABLE remote_media_jobs ADD COLUMN accounting jsonb;
--> statement-breakpoint
ALTER TABLE remote_media_jobs ADD COLUMN cost_state text NOT NULL DEFAULT 'unknown' CHECK (cost_state IN ('unknown','estimated','disputed','reconciled'));
--> statement-breakpoint
CREATE TABLE media_video_admissions (
  document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id),
  run_id text NOT NULL REFERENCES workspace_runs(id),
  duration_seconds double precision NOT NULL CHECK(duration_seconds > 0 AND duration_seconds <= 7200),
  reserved_frames integer NOT NULL CHECK(reserved_frames >= 0 AND reserved_frames <= 1200),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX media_video_admissions_org_day ON media_video_admissions(org_id, created_at);
--> statement-breakpoint
ALTER TABLE remote_media_jobs ADD COLUMN exposure_released boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE media_reconciliation_actions (
  receipt_id text PRIMARY KEY REFERENCES remote_media_jobs(id),
  evidence_sha256 text NOT NULL,
  evidence_reference text NOT NULL,
  actor text NOT NULL,
  verified_cost_nano_usd bigint NOT NULL CHECK(verified_cost_nano_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
ALTER TABLE remote_capacity_leases ADD COLUMN fixed_reserve_usd numeric(24,12) NOT NULL DEFAULT 0 CHECK(fixed_reserve_usd >= 0);

--> statement-breakpoint
ALTER TABLE remote_media_jobs ADD COLUMN charged_cost_cents numeric(24,12) CHECK(charged_cost_cents >= 0);
