-- destructive-migration: drops a legacy trigger no migration ever created. Databases restored from before a40fbea3 still carry it from the removed db/init.sql. Every run insert (upload, index, reindex, materialize) already checks the live monthly caps through usage_attribution (enforceLiveBudgetCaps).
-- The trigger summed usage_events joined on run_id, so it missed search, chat,
-- deleted-run and cross-workspace spend. It re-summed a month of usage on every
-- budgeted run insert, and it raised on the reindex path's deliberate `blocked`
-- run inserts. A no-op on databases built from the migrations.
-- workspace_runs is hot: fail the release rather than queue every run query behind the drop.
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS workspace_runs_budget_guard ON workspace_runs;
DROP FUNCTION IF EXISTS enforce_workspace_run_budget();
