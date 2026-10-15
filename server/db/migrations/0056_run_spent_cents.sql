-- One per-run spend figure for the run cost cap (pipeline.maxCostCents).
--
-- workspace_runs.spent_cents is the sum of cost_cents of every usage event
-- the run's ledger recorded: AI tokens, embeddings, vision, OCR, media,
-- per-page base fees and billed worker compute. Unbilled compute estimates
-- are persisted at cost_cents = 0 (their estimate lives in
-- metadata.effectiveCostCents) and do not count toward the cap; the run cost
-- users see adds that estimate on top and flags it (usage-attribution.ts
-- summarizeRunUsageCost: costCents = billedCostCents + estimatedComputeCents).
--
-- The counter is maintained by a statement-level trigger on usage_events, so
-- every writer (worker checkpoints, page tasks, page base fees, media
-- capacity, app-side recorders) keeps it in step in the same transaction
-- that inserts the events. Writers insert with ON CONFLICT (id) DO NOTHING:
-- the NEW TABLE transition relation holds only rows actually inserted, so a
-- retried checkpoint or a duplicate event id cannot count twice. Usage events
-- are append-only; nothing updates or deletes them outside tests.
--
-- Invariant (reconciled in tests): spent_cents = sum(cost_cents) over
-- usage_attribution where run_id = workspace_runs.id.
--
-- input_cost_cents / output_cost_cents are no longer read or written by the
-- app or worker. They stay one release so workers still running the old code
-- during a deploy can finish their checkpoints; a follow-up migration drops
-- them (TODO.md).
ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS spent_cents numeric(24,12) NOT NULL DEFAULT 0;
--> statement-breakpoint
COMMENT ON COLUMN workspace_runs.spent_cents IS 'Billed run spend for the run cost cap: sum(usage_events.cost_cents) for this run, maintained by the usage_events_run_spent_cents trigger.';
--> statement-breakpoint
COMMENT ON COLUMN workspace_runs.input_cost_cents IS 'Deprecated (0056): replaced by spent_cents; dropped in a later migration.';
--> statement-breakpoint
COMMENT ON COLUMN workspace_runs.output_cost_cents IS 'Deprecated (0056): replaced by spent_cents; dropped in a later migration.';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_usage_events_to_run_spent_cents()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE workspace_runs r
  SET spent_cents = r.spent_cents + s.cost_cents
  FROM (
    SELECT run_id, sum(cost_cents) AS cost_cents
    FROM inserted_usage_events
    WHERE run_id IS NOT NULL AND cost_cents <> 0
    GROUP BY run_id
  ) s
  WHERE r.id = s.run_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- One chunk (no statement breakpoints), so it is one transaction even where
-- statements are applied one chunk at a time: the lock blocks usage_events
-- inserts from the trigger's creation through the backfill, so no event is
-- counted twice or missed. Taken after the ALTER above (workspace_runs first,
-- then usage_events: the order worker checkpoints lock them in).
LOCK TABLE usage_events IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS usage_events_run_spent_cents ON usage_events;
CREATE TRIGGER usage_events_run_spent_cents
  AFTER INSERT ON usage_events
  REFERENCING NEW TABLE AS inserted_usage_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION add_usage_events_to_run_spent_cents();
-- Backfill existing runs from the ledger.
UPDATE workspace_runs r
SET spent_cents = s.cost_cents
FROM (
  SELECT run_id, sum(cost_cents) AS cost_cents
  FROM usage_attribution
  WHERE run_id IS NOT NULL
  GROUP BY run_id
) s
WHERE r.id = s.run_id AND r.spent_cents IS DISTINCT FROM s.cost_cents;
