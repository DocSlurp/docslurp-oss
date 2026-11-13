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
-- guarded. NOTE: numbered 0145 (journal idx stays positional) to sit after the open PRs (#355: 0141, #357: 0142-0143, #365: 0144, #362: 0141). Whichever
-- PR lands later renumbers and raises its journal `when` above every earlier entry.

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

CREATE OR REPLACE FUNCTION docslurp_chart_export_tier_0145(chart jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT (chart - 'enabled' - 'generatorModel')
    || CASE WHEN chart -> 'enabled' = 'true'::jsonb AND NOT chart ? 'tier' THEN '{"tier":"models"}'::jsonb ELSE '{}'::jsonb END
$fn$;

UPDATE projects
SET pipeline = jsonb_set(pipeline, '{chartExport}', docslurp_chart_export_tier_0145(pipeline -> 'chartExport'))
WHERE jsonb_typeof(pipeline -> 'chartExport') = 'object'
  AND (pipeline -> 'chartExport' ? 'enabled' OR pipeline -> 'chartExport' ? 'generatorModel');

UPDATE upload_sessions
SET pipeline = jsonb_set(pipeline, '{chartExport}', docslurp_chart_export_tier_0145(pipeline -> 'chartExport'))
WHERE jsonb_typeof(pipeline -> 'chartExport') = 'object'
  AND (pipeline -> 'chartExport' ? 'enabled' OR pipeline -> 'chartExport' ? 'generatorModel');

UPDATE project_runs
SET pipeline = jsonb_set(pipeline, '{chartExport}', docslurp_chart_export_tier_0145(pipeline -> 'chartExport'))
WHERE jsonb_typeof(pipeline -> 'chartExport') = 'object'
  AND (pipeline -> 'chartExport' ? 'enabled' OR pipeline -> 'chartExport' ? 'generatorModel');

DROP FUNCTION IF EXISTS docslurp_chart_export_tier_0145(jsonb);
