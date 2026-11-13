-- The default page-vision model moved off DeepSeek V4.1 Flash 1017 (owner decision 2026-11-13; it is never selected
-- automatically). Projects store their normalized pipeline, so every project created under the old default carries its
-- URI as if a user had chosen it. Move those rows once: the default profile to the new default (GPT-6 Luna), the
-- open-weights profile to its new model (GLM 5.3 Flash). A DeepSeek choice saved after this migration is kept (the
-- migration runs once). Runs and upload sessions keep the pipeline they were created with.
UPDATE "projects"
SET "pipeline" = jsonb_set("pipeline", '{vision,modelUri}', '"llm://openrouter/openai/gpt-6-luna"'::jsonb)
WHERE "pipeline"->'vision'->>'modelUri' = 'llm://openrouter/deepseek/deepseek-v4.1-flash-1017'
  AND coalesce("pipeline"->'vision'->>'profile', 'good-fast-hosted') = 'good-fast-hosted';
--> statement-breakpoint
UPDATE "projects"
SET "pipeline" = jsonb_set("pipeline", '{vision,modelUri}', '"llm://openrouter/z-ai/glm-5.3-flash"'::jsonb)
WHERE "pipeline"->'vision'->>'modelUri' = 'llm://openrouter/deepseek/deepseek-v4.1-flash-1017'
  AND "pipeline"->'vision'->>'profile' = 'open-weights-hosted';
