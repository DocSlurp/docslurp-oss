-- Web tools are on for every workspace, recorded explicitly in its pipeline so
-- the opt-in is visible in workspace settings and can be turned off per workspace.
UPDATE workspaces
SET pipeline = pipeline || '{"webTools": true}'::jsonb
WHERE NOT (pipeline ? 'webTools');
