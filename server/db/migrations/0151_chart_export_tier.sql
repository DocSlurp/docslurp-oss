-- Chart export tiers (packages/shared/src/chart-export.ts) and run origins.
--
-- 1. `pipeline.chartExport.enabled` becomes `tier`. A stored `enabled: true` becomes `tier: "models"` (those projects
--    opted into billed model reads and keep them). `enabled: false` or absent leaves `tier` unset: an unset tier means
--    "the default for the run's origin" (app uploads: free steps; API, MCP, SDK, CLI: off), so no concrete default is
--    written into stored config. `generatorModel` is removed: callers choose a tier, never a backend model.
--    Applied to projects, upload sessions (their request overrides) and runs (their snapshots).
-- 2. `origin` on upload_sessions and project_runs: `app` (first-party cookie session) or `machine` (API key, MCP or
--    CLI token, connector, internal). Set server-side from the authenticated principal; existing rows are `machine`.
--
-- Idempotent: rows are rewritten only while they still carry `enabled` or `generatorModel`; columns and constraints are
-- guarded. Numbered 0151, after 0150 on main (journal idx 144). Migration PRs that land later renumber after it and
-- raise their journal `when` above every earlier entry.

ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'machine';
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'machine';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_sessions_origin_check') THEN
    ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_origin_check CHECK (origin IN ('app', 'machine'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_runs_origin_check') THEN
    ALTER TABLE project_runs ADD CONSTRAINT project_runs_origin_check CHECK (origin IN ('app', 'machine'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION docslurp_chart_export_tier_0151(chart jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT (chart - 'enabled' - 'generatorModel')
    || CASE WHEN chart -> 'enabled' = 'true'::jsonb AND NOT chart ? 'tier' THEN '{"tier":"models"}'::jsonb ELSE '{}'::jsonb END
$fn$;

UPDATE projects
SET pipeline = jsonb_set(pipeline, '{chartExport}', docslurp_chart_export_tier_0151(pipeline -> 'chartExport'))
WHERE jsonb_typeof(pipeline -> 'chartExport') = 'object'
  AND (pipeline -> 'chartExport' ? 'enabled' OR pipeline -> 'chartExport' ? 'generatorModel');

UPDATE upload_sessions
SET pipeline = jsonb_set(pipeline, '{chartExport}', docslurp_chart_export_tier_0151(pipeline -> 'chartExport'))
WHERE jsonb_typeof(pipeline -> 'chartExport') = 'object'
  AND (pipeline -> 'chartExport' ? 'enabled' OR pipeline -> 'chartExport' ? 'generatorModel');

UPDATE project_runs
SET pipeline = jsonb_set(pipeline, '{chartExport}', docslurp_chart_export_tier_0151(pipeline -> 'chartExport'))
WHERE jsonb_typeof(pipeline -> 'chartExport') = 'object'
  AND (pipeline -> 'chartExport' ? 'enabled' OR pipeline -> 'chartExport' ? 'generatorModel');

DROP FUNCTION IF EXISTS docslurp_chart_export_tier_0151(jsonb);
--> statement-breakpoint
-- 3. Per-organization cap on free-tier chart-export parser-VM runs per hour (council M1). Each run boots an unbilled VM,
--    so an org may start at most DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR of them per clock hour, shared by
--    every worker: a reservation locks the org's hour row, and each document's grant is recorded once, so a retried
--    stage or a restarted worker gets the same answer back without spending the cap again. Same shape as 0104.
CREATE TABLE IF NOT EXISTS "chart_export_free_vm_hours" (
	"org_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"used" integer DEFAULT 0 NOT NULL CHECK ("used" >= 0),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("org_id", "hour")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chart_export_free_vm_grants" (
	"run_id" text NOT NULL REFERENCES "project_runs"("id") ON DELETE CASCADE,
	"document_id" text NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
	"org_id" text NOT NULL,
	"granted" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("run_id", "document_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chart_export_free_vm_grants_document_idx" ON "chart_export_free_vm_grants" ("document_id");
--> statement-breakpoint
-- A grant may only name one of the run's own documents in the run's organization: one tenant can never spend or read
-- another tenant's cap. The worker checks the same rule before reserving.
CREATE OR REPLACE FUNCTION "chart_export_free_vm_grant_owned"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "documents" d JOIN "project_runs" r ON r."id" = d."run_id"
		WHERE d."id" = NEW."document_id" AND r."id" = NEW."run_id"
			AND d."project_id" IS NOT DISTINCT FROM r."project_id"
			AND d."org_id" IS NOT DISTINCT FROM r."org_id"
			AND r."org_id" = NEW."org_id"
	) THEN
		RAISE EXCEPTION 'chart_export_free_vm_grants: document % does not belong to run % in org %', NEW."document_id", NEW."run_id", NEW."org_id"
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "chart_export_free_vm_grants_owned" ON "chart_export_free_vm_grants";
--> statement-breakpoint
CREATE TRIGGER "chart_export_free_vm_grants_owned"
	BEFORE INSERT OR UPDATE OF "run_id", "document_id", "org_id" ON "chart_export_free_vm_grants"
	FOR EACH ROW EXECUTE FUNCTION "chart_export_free_vm_grant_owned"();
--> statement-breakpoint
-- The worker reserves (SELECT, INSERT, UPDATE on hours; SELECT, INSERT on grants); server/db/roles.mjs reconciles the
-- same grants after every migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.chart_export_free_vm_hours FROM docslurp_worker;
    GRANT SELECT, INSERT, UPDATE ON public.chart_export_free_vm_hours TO docslurp_worker;
    REVOKE ALL ON public.chart_export_free_vm_grants FROM docslurp_worker;
    GRANT SELECT, INSERT ON public.chart_export_free_vm_grants TO docslurp_worker;
  END IF;
END $$;
