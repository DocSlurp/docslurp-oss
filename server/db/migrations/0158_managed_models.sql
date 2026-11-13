-- Managed models (packages/shared/src/managed-pipeline-models.ts, server/src/services/managed-models.ts).
--
-- Callers choose DocSlurp categories (chat tiers, quality, profiles), never a backend model or provider. The model behind
-- a category is a managed setting: projects.managed_models holds the only explicit choices, written by the platform-admin
-- route as { "chat": { "<tier>": "<model id>" }, "pipeline": { <explicit pipeline model overrides> } }. Every other stored
-- model value is legacy or a former default, so it is removed and the current profile and deployment defaults apply
-- (former defaults such as the DeepSeek V4.1 Flash vision route stop being pinned per project).
--
-- 1. Kept as explicit overrides: operator private routes (llm://private/...) in text generation, structured extraction
--    and vision, and an embedding model URI that is private or differs from its profile's default (embedding is bound to
--    the project's vector index; dropping it would mismatch the index until a re-index).
-- 2. Every managed path in projects.pipeline is rewritten to the override, or removed. Run snapshots (project_runs.pipeline)
--    and version snapshots (audit_log) stay as history: reprocess and rollback drop their model values in code.
--
-- Idempotent: each UPDATE only touches rows whose value still differs, and the first only rows with something to move.
-- Dry run (read-only counts for operators) is in the PR description.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "managed_models" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "projects" p
SET "managed_models" = jsonb_set(p."managed_models", '{pipeline}', coalesce(p."managed_models" -> 'pipeline', '{}'::jsonb) || moved.overrides, true)
FROM (
  SELECT id, jsonb_strip_nulls(jsonb_build_object(
    'textGeneration', nullif(jsonb_strip_nulls(jsonb_build_object(
      'model', CASE WHEN pipeline #>> '{textGeneration,model}' LIKE 'llm://private/%' THEN pipeline #> '{textGeneration,model}' END,
      'models', (
        SELECT nullif(coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb), '{}'::jsonb)
        FROM jsonb_each(CASE WHEN jsonb_typeof(pipeline #> '{textGeneration,models}') = 'object' THEN pipeline #> '{textGeneration,models}' ELSE '{}'::jsonb END) AS entry
        WHERE entry.value #>> '{}' LIKE 'llm://private/%'
      )
    )), '{}'::jsonb),
    'structuredExtraction', nullif(jsonb_strip_nulls(jsonb_build_object(
      'model', CASE WHEN pipeline #>> '{structuredExtraction,model}' LIKE 'llm://private/%' THEN pipeline #> '{structuredExtraction,model}' END
    )), '{}'::jsonb),
    'vision', nullif(jsonb_strip_nulls(jsonb_build_object(
      'modelUri', CASE WHEN pipeline #>> '{vision,modelUri}' LIKE 'llm://private/%' THEN pipeline #> '{vision,modelUri}' END,
      'remoteFallbackModelUri', CASE WHEN pipeline #>> '{vision,remoteFallbackModelUri}' LIKE 'llm://private/%' THEN pipeline #> '{vision,remoteFallbackModelUri}' END
    )), '{}'::jsonb),
    'embedding', nullif(jsonb_strip_nulls(jsonb_build_object(
      'modelUri', CASE WHEN jsonb_typeof(pipeline #> '{embedding,modelUri}') = 'string'
        AND (pipeline #>> '{embedding,modelUri}' LIKE 'llm://private/%'
          OR pipeline #>> '{embedding,modelUri}' IS DISTINCT FROM CASE coalesce(pipeline #>> '{embedding,profile}', 'cheapest-hosted')
            WHEN 'cheapest-local' THEN 'llm://transformers.js/Xenova/all-MiniLM-L6-v2'
            WHEN 'fastest-local' THEN 'llm://transformers.js/Xenova/gte-small'
            WHEN 'good-fast-local' THEN 'llm://transformers.js/Xenova/bge-m3'
            WHEN 'multilingual-local' THEN 'llm://transformers.js/Xenova/paraphrase-multilingual-MiniLM-L12-v2'
            WHEN 'code-local' THEN 'llm://huggingface/jinaai/jina-embeddings-v2-base-code'
            WHEN 'cheapest-hosted' THEN 'llm://openrouter/perplexity/pplx-embed-v1-0.6b'
          END)
        THEN pipeline #> '{embedding,modelUri}' END
    )), '{}'::jsonb)
  )) AS overrides
  FROM "projects"
  WHERE jsonb_typeof(pipeline) = 'object'
) moved
WHERE moved.id = p.id AND moved.overrides <> '{}'::jsonb
  AND NOT (coalesce(p."managed_models" -> 'pipeline', '{}'::jsonb) @> moved.overrides);
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,textGeneration,model}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'textGeneration') = 'object'
  THEN jsonb_set("pipeline", '{textGeneration,model}', "managed_models" #> '{pipeline,textGeneration,model}', true) ELSE "pipeline" #- '{textGeneration,model}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{textGeneration,model}') IS DISTINCT FROM ("managed_models" #> '{pipeline,textGeneration,model}')
  AND NOT ("pipeline" #> '{textGeneration,model}' IS NULL AND jsonb_typeof("pipeline" -> 'textGeneration') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,textGeneration,models}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'textGeneration') = 'object'
  THEN jsonb_set("pipeline", '{textGeneration,models}', "managed_models" #> '{pipeline,textGeneration,models}', true) ELSE "pipeline" #- '{textGeneration,models}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{textGeneration,models}') IS DISTINCT FROM ("managed_models" #> '{pipeline,textGeneration,models}')
  AND NOT ("pipeline" #> '{textGeneration,models}' IS NULL AND jsonb_typeof("pipeline" -> 'textGeneration') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,structuredExtraction,model}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'structuredExtraction') = 'object'
  THEN jsonb_set("pipeline", '{structuredExtraction,model}', "managed_models" #> '{pipeline,structuredExtraction,model}', true) ELSE "pipeline" #- '{structuredExtraction,model}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{structuredExtraction,model}') IS DISTINCT FROM ("managed_models" #> '{pipeline,structuredExtraction,model}')
  AND NOT ("pipeline" #> '{structuredExtraction,model}' IS NULL AND jsonb_typeof("pipeline" -> 'structuredExtraction') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,embedding,modelUri}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'embedding') = 'object'
  THEN jsonb_set("pipeline", '{embedding,modelUri}', "managed_models" #> '{pipeline,embedding,modelUri}', true) ELSE "pipeline" #- '{embedding,modelUri}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{embedding,modelUri}') IS DISTINCT FROM ("managed_models" #> '{pipeline,embedding,modelUri}')
  AND NOT ("pipeline" #> '{embedding,modelUri}' IS NULL AND jsonb_typeof("pipeline" -> 'embedding') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,embedding,target}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'embedding') = 'object'
  THEN jsonb_set("pipeline", '{embedding,target}', "managed_models" #> '{pipeline,embedding,target}', true) ELSE "pipeline" #- '{embedding,target}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{embedding,target}') IS DISTINCT FROM ("managed_models" #> '{pipeline,embedding,target}')
  AND NOT ("pipeline" #> '{embedding,target}' IS NULL AND jsonb_typeof("pipeline" -> 'embedding') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,vision,modelUri}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'vision') = 'object'
  THEN jsonb_set("pipeline", '{vision,modelUri}', "managed_models" #> '{pipeline,vision,modelUri}', true) ELSE "pipeline" #- '{vision,modelUri}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{vision,modelUri}') IS DISTINCT FROM ("managed_models" #> '{pipeline,vision,modelUri}')
  AND NOT ("pipeline" #> '{vision,modelUri}' IS NULL AND jsonb_typeof("pipeline" -> 'vision') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,vision,target}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'vision') = 'object'
  THEN jsonb_set("pipeline", '{vision,target}', "managed_models" #> '{pipeline,vision,target}', true) ELSE "pipeline" #- '{vision,target}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{vision,target}') IS DISTINCT FROM ("managed_models" #> '{pipeline,vision,target}')
  AND NOT ("pipeline" #> '{vision,target}' IS NULL AND jsonb_typeof("pipeline" -> 'vision') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,vision,remoteFallbackModelUri}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'vision') = 'object'
  THEN jsonb_set("pipeline", '{vision,remoteFallbackModelUri}', "managed_models" #> '{pipeline,vision,remoteFallbackModelUri}', true) ELSE "pipeline" #- '{vision,remoteFallbackModelUri}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{vision,remoteFallbackModelUri}') IS DISTINCT FROM ("managed_models" #> '{pipeline,vision,remoteFallbackModelUri}')
  AND NOT ("pipeline" #> '{vision,remoteFallbackModelUri}' IS NULL AND jsonb_typeof("pipeline" -> 'vision') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,visualPages,route}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'visualPages') = 'object'
  THEN jsonb_set("pipeline", '{visualPages,route}', "managed_models" #> '{pipeline,visualPages,route}', true) ELSE "pipeline" #- '{visualPages,route}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{visualPages,route}') IS DISTINCT FROM ("managed_models" #> '{pipeline,visualPages,route}')
  AND NOT ("pipeline" #> '{visualPages,route}' IS NULL AND jsonb_typeof("pipeline" -> 'visualPages') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,pageRouter,decisionModel}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'pageRouter') = 'object'
  THEN jsonb_set("pipeline", '{pageRouter,decisionModel}', "managed_models" #> '{pipeline,pageRouter,decisionModel}', true) ELSE "pipeline" #- '{pageRouter,decisionModel}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{pageRouter,decisionModel}') IS DISTINCT FROM ("managed_models" #> '{pipeline,pageRouter,decisionModel}')
  AND NOT ("pipeline" #> '{pageRouter,decisionModel}' IS NULL AND jsonb_typeof("pipeline" -> 'pageRouter') IS DISTINCT FROM 'object');
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = CASE WHEN "managed_models" #> '{pipeline,chartExport,generatorModel}' IS NOT NULL AND jsonb_typeof("pipeline" -> 'chartExport') = 'object'
  THEN jsonb_set("pipeline", '{chartExport,generatorModel}', "managed_models" #> '{pipeline,chartExport,generatorModel}', true) ELSE "pipeline" #- '{chartExport,generatorModel}' END
WHERE jsonb_typeof("pipeline") = 'object'
  AND ("pipeline" #> '{chartExport,generatorModel}') IS DISTINCT FROM ("managed_models" #> '{pipeline,chartExport,generatorModel}')
  AND NOT ("pipeline" #> '{chartExport,generatorModel}' IS NULL AND jsonb_typeof("pipeline" -> 'chartExport') IS DISTINCT FROM 'object');
