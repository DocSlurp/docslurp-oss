-- Managed models (server/src/services/managed-models.ts). Callers choose DocSlurp categories (chat tiers, quality,
-- profiles), never a backend model or provider. The model behind each category is a managed setting that only
-- platform admins set, per project, in projects.managed_models ({ "chat": { "<tier>": "<model id>" } }).
--
-- Customer-chosen backend text models in stored project pipelines are cleared, so those projects use the managed
-- defaults; the public API no longer accepts them. Run snapshots (project_runs.pipeline) are history and stay.
-- Explicit embedding and vision model URIs are left in place: they are managed now (changing an embedding model
-- invalidates the project's index), and customers can neither set nor read them.
--
-- ADD COLUMN with a constant default does not rewrite the table. The updates touch only rows that carry a model.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "managed_models" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = jsonb_set(jsonb_set("pipeline", '{textGeneration,model}', 'null'::jsonb), '{textGeneration,models}', '{}'::jsonb)
WHERE jsonb_typeof("pipeline" -> 'textGeneration') = 'object'
  AND (("pipeline" #> '{textGeneration,model}') IS DISTINCT FROM 'null'::jsonb AND ("pipeline" #> '{textGeneration,model}') IS NOT NULL
    OR ("pipeline" #> '{textGeneration,models}') NOT IN ('{}'::jsonb));
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = jsonb_set("pipeline", '{structuredExtraction,model}', 'null'::jsonb)
WHERE jsonb_typeof("pipeline" -> 'structuredExtraction') = 'object'
  AND ("pipeline" #> '{structuredExtraction,model}') IS NOT NULL
  AND ("pipeline" #> '{structuredExtraction,model}') <> 'null'::jsonb;
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = jsonb_set("pipeline", '{visualPages,route}', '"auto"'::jsonb)
WHERE jsonb_typeof("pipeline" -> 'visualPages') = 'object'
  AND ("pipeline" #>> '{visualPages,route}') IS NOT NULL
  AND ("pipeline" #>> '{visualPages,route}') <> 'auto';
