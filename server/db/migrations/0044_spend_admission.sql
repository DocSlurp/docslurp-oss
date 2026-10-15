-- Spend admission for every model-calling path (security gap G-08) and the
-- mid-run balance check (operator gap OP-09).
--
-- org_spend_status() is the one rule the API (assertCanSpend in
-- server/src/services/billing/spend-guard.ts) and the worker (mid-run
-- checks in worker/src/pipeline/spend-guard.ts) read:
--   available   included + prepaid - pending debits (org_available_credits)
--   reserved    with p_run_reserve > 0: the unspent part of a small per-run
--               reservation held by every in-flight run of the org, so
--               concurrent run admissions cannot all pass on one positive
--               balance. Callers that admit runs take
--               pg_advisory_xact_lock(spend_admission_lock_key(org)) and
--               insert the run in the same transaction.
--   *_budget_paused  the monthly budget caps (maintained by admission and
--               the worker budget-alert sweep)
--   workspace_in_org whether p_workspace_id belongs to the org (entitlement)
-- p_org_id may be NULL: the workspace's org is used.
CREATE OR REPLACE FUNCTION spend_admission_lock_key(p_org_id text)
RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('docslurp:spend-admission:' || p_org_id, 0)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION org_spend_status(
  p_org_id text,
  p_workspace_id text DEFAULT NULL,
  p_run_reserve numeric DEFAULT 0
)
RETURNS TABLE (
  org_id text,
  plan_id text,
  available numeric,
  reserved numeric,
  workspace_budget_paused boolean,
  org_budget_paused boolean,
  workspace_in_org boolean
)
LANGUAGE sql STABLE AS $$
  SELECT
    o.id,
    o.plan_id,
    a.available,
    CASE WHEN p_run_reserve > 0 THEN coalesce((
      SELECT sum(greatest(0, p_run_reserve - (r.input_cost_cents + r.output_cost_cents)))
      FROM workspace_runs r
      WHERE r.org_id = o.id
        AND r.status IN ('queued', 'processing')
        AND coalesce(r.control_state, '') NOT IN ('paused', 'cancelled', 'cancel_requested', 'dead-letter')
    ), 0) ELSE 0 END,
    coalesce(w.budget_paused, false),
    o.budget_paused,
    p_workspace_id IS NULL OR w.id IS NOT NULL
  FROM organizations o
  CROSS JOIN LATERAL org_available_credits(o.id) a
  LEFT JOIN workspaces w ON w.id = p_workspace_id AND w.org_id = o.id
  WHERE o.id = coalesce(p_org_id, (SELECT ws.org_id FROM workspaces ws WHERE ws.id = p_workspace_id))
$$;
--> statement-breakpoint
-- Mid-run spend check cadence (OP-09): usage written since the run's last
-- balance check. Checkpoints add to these; when either crosses its threshold
-- (WORKER_SPEND_CHECK_PAGES / WORKER_SPEND_CHECK_CREDITS) the same UPDATE
-- resets both and the worker checks the org balance.
-- pause_reason is set when the worker pauses a run because the org may no
-- longer spend (credit_exhausted, workspace_budget_paused, org_budget_paused,
-- plan_not_entitled); control_state is 'paused' and the run resumes on its
-- own once the org may spend again (app maintenance sweep). NULL for runs
-- paused by an operator, which only an operator resumes.
ALTER TABLE workspace_runs
  ADD COLUMN IF NOT EXISTS spend_unchecked_pages integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS spend_unchecked_credits numeric(24,12) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS pause_reason text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_runs_spend_paused_idx
  ON workspace_runs (org_id)
  WHERE pause_reason IS NOT NULL;
