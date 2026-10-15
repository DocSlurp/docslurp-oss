ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "system_prompt" text;

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "budget_paused" boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workspaces_system_prompt_length_check'
  ) THEN
    ALTER TABLE "workspaces"
      ADD CONSTRAINT "workspaces_system_prompt_length_check"
      CHECK (("system_prompt" IS NULL) OR (char_length("system_prompt") <= 2000));
  END IF;
END
$$;
