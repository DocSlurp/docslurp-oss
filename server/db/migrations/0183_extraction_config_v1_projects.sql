-- Extraction config v1 (release R1): stored project pipelines move to the new shape, `quality`
-- (fastest | balanced | smart) and `visuals` (none | figures | charts | charts-ai; absent = the run origin's default) with
-- `configVersion: 1`. Design: the private app repository's docs/design/extraction-config-simplification.md (3.2, 8, 10);
-- docs/extraction/quality-and-visuals.md.
--
-- Needs release R0 deployed first: R0 reads both shapes. The mapping is the TypeScript `migrateProjectPipelineToConfigV1`
-- (packages/shared/src/extraction-config-migration.ts); server/src/__tests__/extraction-config-v1-migration.db.test.ts
-- runs both over the same fixtures. Change them together.
--
-- Never raises a project's effective quality or visuals, except the owner-approved Q1 mapping (`visionFallback: false`
-- with `auto` -> `balanced`). Counts are logged before rewriting (RAISE NOTICE); `node server/db/extraction-config-v1-report.mjs`
-- prints the same counts without changing anything (it runs this file's functions in a rolled-back transaction).
--
-- Also: resumable figure levels of projects with `figureResume: off` or `manual` are blocked (`resume-off`), so the
-- runner, which now resumes automatically within a run's visuals (Q3), never finishes partials those projects opted out
-- of (`resume-off-v1`, sticky). A new run (a fresh pass) clears it.

-- report:functions-begin
CREATE OR REPLACE FUNCTION docslurp_extraction_config_v1_upgraded(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  r jsonb := CASE WHEN jsonb_typeof(p) = 'object' THEN p ELSE '{}'::jsonb END;
  has_force boolean := jsonb_typeof(r -> 'vision') = 'object' AND (r -> 'vision') ? 'forceAllPages';
  legacy text;
  ce jsonb;
BEGIN
  -- migrateLegacyQualitySettings: parserPlaybook / vision.forceAllPages; an explicit quality key wins.
  IF r ? 'parserPlaybook' OR has_force THEN
    legacy := CASE
      WHEN jsonb_typeof(r -> 'vision') = 'object' AND (r -> 'vision' -> 'forceAllPages') = 'true'::jsonb THEN 'good'
      WHEN jsonb_typeof(r -> 'parserPlaybook') = 'string' THEN CASE WHEN r ->> 'parserPlaybook' = 'fast' THEN 'fast' ELSE 'auto' END
      ELSE NULL END;
    r := r - 'parserPlaybook';
    IF has_force THEN r := jsonb_set(r, '{vision}', (r -> 'vision') - 'forceAllPages'); END IF;
    IF NOT (r ? 'quality') AND legacy IS NOT NULL THEN r := r || jsonb_build_object('quality', legacy); END IF;
  END IF;
  -- upgradeStoredChartExport: chartExport.enabled / generatorModel; enabled with no tier key means `models`.
  ce := r -> 'chartExport';
  IF jsonb_typeof(ce) = 'object' AND (ce ? 'enabled' OR ce ? 'generatorModel') THEN
    IF (ce -> 'enabled') = 'true'::jsonb AND NOT (ce ? 'tier') THEN
      ce := (ce - 'enabled' - 'generatorModel') || '{"tier": "models"}'::jsonb;
    ELSE
      ce := ce - 'enabled' - 'generatorModel';
    END IF;
    r := jsonb_set(r, '{chartExport}', ce);
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docslurp_extraction_config_v1_vision_local(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(v) <> 'object' OR v IS NULL THEN false
    WHEN v ->> 'target' = 'hosted' AND jsonb_typeof(v -> 'target') = 'string' THEN false
    WHEN v ->> 'target' IN ('local', 'private') AND jsonb_typeof(v -> 'target') = 'string' THEN true
    ELSE jsonb_typeof(v -> 'profile') = 'string' AND right(v ->> 'profile', 6) = '-local'
  END
$$;
--> statement-breakpoint
-- The mapping table over an upgraded pipeline: {quality, visuals (null = unset), loweredQuality, loweredVisuals}.
CREATE OR REPLACE FUNCTION docslurp_extraction_config_v1_mapping(u jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  raw_quality jsonb := u -> 'quality';
  quality text;
  restricted boolean := jsonb_typeof(u -> 'privacyMode') = 'string' AND u ->> 'privacyMode' <> 'standard';
  tier text := CASE WHEN jsonb_typeof(u -> 'chartExport') = 'object' AND jsonb_typeof(u -> 'chartExport' -> 'tier') = 'string'
    AND u -> 'chartExport' ->> 'tier' IN ('off', 'free', 'models') THEN u -> 'chartExport' ->> 'tier' END;
  visuals text;
  lowered_quality boolean := false;
  lowered_visuals boolean := false;
BEGIN
  quality := CASE
    WHEN jsonb_typeof(raw_quality) = 'string' AND raw_quality #>> '{}' IN ('fastest', 'balanced', 'smart') THEN raw_quality #>> '{}'
    WHEN jsonb_typeof(raw_quality) = 'string' AND raw_quality #>> '{}' = 'fast' THEN 'fastest'
    WHEN jsonb_typeof(raw_quality) = 'string' AND raw_quality #>> '{}' = 'good' THEN 'smart'
    ELSE 'balanced' END;
  IF quality = 'smart' AND restricted AND NOT docslurp_extraction_config_v1_vision_local(u -> 'vision') THEN
    quality := 'balanced'; lowered_quality := true;
  END IF;
  visuals := CASE
    WHEN jsonb_typeof(u -> 'visuals') = 'string' AND u ->> 'visuals' IN ('none', 'figures', 'charts', 'charts-ai') THEN u ->> 'visuals'
    WHEN ((u -> 'figures') = 'false'::jsonb OR (u -> 'figures') = '"off"'::jsonb OR (jsonb_typeof(u -> 'figures') = 'object' AND (u -> 'figures' -> 'enabled') = 'false'::jsonb)) THEN 'none'
    WHEN tier = 'off' THEN 'figures'
    WHEN tier = 'free' THEN 'charts'
    WHEN tier = 'models' THEN 'charts-ai'
    ELSE NULL END;
  IF visuals = 'charts-ai' AND restricted THEN visuals := 'charts'; lowered_visuals := true; END IF;
  RETURN jsonb_build_object('quality', quality, 'visuals', visuals, 'loweredQuality', lowered_quality, 'loweredVisuals', lowered_visuals);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docslurp_extraction_config_v1_versioned(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  -- A row that names a semantics version is never rewritten (v1 done; an unknown version is left for its release).
  SELECT coalesce(jsonb_typeof(p) = 'object' AND p ? 'configVersion' AND jsonb_typeof(p -> 'configVersion') <> 'null', false)
$$;
--> statement-breakpoint
-- The new-shape pipeline (migrateProjectPipelineToConfigV1).
CREATE OR REPLACE FUNCTION docslurp_extraction_config_v1(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  u jsonb := docslurp_extraction_config_v1_upgraded(p);
  m jsonb := docslurp_extraction_config_v1_mapping(u);
  n jsonb := u - 'visionFallback' - 'figures' - 'figureResume' - 'visuals' - 'configVersion';
BEGIN
  IF docslurp_extraction_config_v1_versioned(p) THEN RETURN p; END IF;
  IF jsonb_typeof(n -> 'chartExport') = 'object' THEN n := jsonb_set(n, '{chartExport}', (n -> 'chartExport') - 'tier'); END IF;
  n := n || jsonb_build_object('quality', m -> 'quality');
  -- Fastest keeps an explicit visionFallback: false (it also gates page rasters and estimates; the read default is true).
  IF m ->> 'quality' = 'fastest' AND (u -> 'visionFallback') = 'false'::jsonb THEN n := n || '{"visionFallback": false}'::jsonb; END IF;
  IF jsonb_typeof(m -> 'visuals') = 'string' THEN n := n || jsonb_build_object('visuals', m -> 'visuals'); END IF;
  RETURN n || '{"configVersion": 1}'::jsonb;
END $$;
--> statement-breakpoint
-- What the owner reviews first (ExtractionConfigV1Flags): {q1, q3, q11, loweredQuality, loweredVisuals}.
CREATE OR REPLACE FUNCTION docslurp_extraction_config_v1_flags(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  u jsonb := docslurp_extraction_config_v1_upgraded(p);
  m jsonb := docslurp_extraction_config_v1_mapping(u);
  tier text := CASE WHEN jsonb_typeof(u -> 'chartExport') = 'object' AND jsonb_typeof(u -> 'chartExport' -> 'tier') = 'string' THEN u -> 'chartExport' ->> 'tier' END;
  -- The level the row ran before privacy lowering (unknown values read as balanced).
  legacy_level text := CASE
    WHEN jsonb_typeof(u -> 'quality') = 'string' AND u ->> 'quality' IN ('fastest', 'balanced', 'smart') THEN u ->> 'quality'
    WHEN jsonb_typeof(u -> 'quality') = 'string' AND u ->> 'quality' = 'fast' THEN 'fastest'
    WHEN jsonb_typeof(u -> 'quality') = 'string' AND u ->> 'quality' = 'good' THEN 'smart'
    ELSE 'balanced' END;
BEGIN
  IF docslurp_extraction_config_v1_versioned(p) THEN
    RETURN jsonb_build_object('q1', false, 'q3', false, 'q11', false, 'loweredQuality', false, 'loweredVisuals', false,
      'unsupportedVersion', (p -> 'configVersion') <> '1'::jsonb);
  END IF;
  RETURN jsonb_build_object(
    'q1', coalesce(legacy_level = 'balanced' AND (u -> 'visionFallback') = 'false'::jsonb, false),
    'q3', coalesce(jsonb_typeof(u -> 'figureResume') = 'string' AND u ->> 'figureResume' IN ('off', 'manual'), false),
    'q11', coalesce(((u -> 'figures') = 'false'::jsonb OR (u -> 'figures') = '"off"'::jsonb OR (jsonb_typeof(u -> 'figures') = 'object' AND (u -> 'figures' -> 'enabled') = 'false'::jsonb)) AND tier IN ('free', 'models'), false),
    'loweredQuality', m -> 'loweredQuality',
    'loweredVisuals', m -> 'loweredVisuals',
    'unsupportedVersion', false);
END $$;
-- report:functions-end
--> statement-breakpoint
DO $$
DECLARE
  total bigint; q1 bigint; q3 bigint; q11 bigint; lq bigint; lv bigint; levels bigint; unsupported bigint;
  max_q1 bigint := coalesce(nullif(current_setting('docslurp.extraction_config_v1_max_q1', true), '')::bigint, 100);
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE (f ->> 'q1')::boolean),
         count(*) FILTER (WHERE (f ->> 'q3')::boolean),
         count(*) FILTER (WHERE (f ->> 'q11')::boolean),
         count(*) FILTER (WHERE (f ->> 'loweredQuality')::boolean),
         count(*) FILTER (WHERE (f ->> 'loweredVisuals')::boolean)
    INTO total, q1, q3, q11, lq, lv
    FROM (SELECT docslurp_extraction_config_v1_flags(pipeline) AS f FROM projects
          WHERE NOT docslurp_extraction_config_v1_versioned(pipeline)) rows;
  SELECT count(*) INTO levels FROM document_extraction_levels l JOIN projects p ON p.id = l.project_id
   WHERE l.images_status = 'resumable' AND (l.resume_blocked IS NULL OR l.resume_blocked NOT IN ('attempts', 'resume-off-v1'))
     AND p.pipeline ->> 'figureResume' IN ('off', 'manual');
  SELECT count(*) INTO unsupported FROM projects
   WHERE docslurp_extraction_config_v1_versioned(pipeline) AND pipeline -> 'configVersion' <> '1'::jsonb;
  RAISE NOTICE '[extraction-config-v1] projects=% q1_vision_fallback_off_auto=% q3_figure_resume_off_manual=% q11_figures_off_with_chart_tier=% lowered_quality_privacy=% lowered_visuals_privacy=% figure_levels_to_block=% unsupported_version_left=%',
    total, q1, q3, q11, lq, lv, levels, unsupported;
  -- Q1 raises (rescue reads turn on): a large count pauses the migration until the owner confirms by raising the limit.
  IF q1 > max_q1 THEN
    RAISE EXCEPTION '[extraction-config-v1] % projects would move from auto with rescue reads off to balanced (Q1), above the confirmed limit %. Review server/db/extraction-config-v1-report.mjs and rerun with DOCSLURP_EXTRACTION_CONFIG_V1_MAX_Q1=% to confirm.', q1, max_q1, q1;
  END IF;
END $$;
--> statement-breakpoint
-- Q3: a block reason of its own, sticky (requests do not lift it; a new run, a fresh pass, does).
DO $$
BEGIN
  ALTER TABLE document_extraction_levels DROP CONSTRAINT IF EXISTS document_extraction_levels_resume_blocked_check;
  ALTER TABLE document_extraction_levels ADD CONSTRAINT document_extraction_levels_resume_blocked_check
    CHECK (resume_blocked IN ('attempts', 'vm-budget', 'no-progress', 'figures-off', 'resume-off', 'resume-off-v1', 'stale', 'refused', 'unscanned'));
END $$;
--> statement-breakpoint
-- Q3: block resumable partial figure levels of projects that opted out of automatic resume, before their opt-out key
-- goes, whatever request-clearable block they had (only the lifetime cap, `attempts`, is kept).
UPDATE document_extraction_levels l
   SET resume_blocked = 'resume-off-v1', resume_blocked_at = now(), resume_after = NULL
  FROM projects p
 WHERE p.id = l.project_id AND p.org_id = l.org_id
   AND l.images_status = 'resumable'
   AND (l.resume_blocked IS NULL OR l.resume_blocked NOT IN ('attempts', 'resume-off-v1'))
   AND p.pipeline ->> 'figureResume' IN ('off', 'manual');
--> statement-breakpoint
UPDATE projects
   SET pipeline = docslurp_extraction_config_v1(pipeline)
 WHERE pipeline IS NOT NULL
   AND NOT docslurp_extraction_config_v1_versioned(pipeline);
