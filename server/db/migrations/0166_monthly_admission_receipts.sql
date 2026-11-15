-- Pending work reserves its forecast upper bound (minimum one cent). Usage
-- replaces capacity as it arrives; terminal runs release the unused remainder.
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS monthly_reservation_cents numeric NOT NULL DEFAULT 1;

CREATE OR REPLACE VIEW pending_monthly_capacity AS
SELECT r.id AS run_id, r.org_id, r.project_id,
 greatest(0, r.monthly_reservation_cents - coalesce((
   SELECT sum(u.cost_cents) FROM usage_attribution u WHERE u.source_run_id = r.id
 ),0)) AS cents
FROM project_runs r WHERE r.status IN ('queued','processing');

CREATE OR REPLACE FUNCTION reserve_monthly_run_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_cap numeric; project_cap numeric; org_used numeric; project_used numeric; demand numeric;
BEGIN
 IF NEW.status NOT IN ('queued','processing') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('queued','processing') AND OLD.monthly_reservation_cents=NEW.monthly_reservation_cents THEN RETURN NEW; END IF;
 IF NEW.monthly_reservation_cents < 1 THEN RAISE EXCEPTION 'Invalid monthly capacity'; END IF;
 PERFORM pg_advisory_xact_lock(spend_admission_lock_key(NEW.org_id));
 SELECT monthly_budget_cents INTO org_cap FROM organizations WHERE id=NEW.org_id;
 SELECT monthly_budget_cents INTO project_cap FROM projects WHERE id=NEW.project_id AND org_id=NEW.org_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Run billing scope mismatch'; END IF;
 SELECT coalesce(sum(cost_cents),0), coalesce(sum(cost_cents) FILTER (WHERE project_id=NEW.project_id),0)
 INTO org_used, project_used FROM usage_attribution WHERE org_id=NEW.org_id AND created_at>=date_trunc('month',now());
 SELECT org_used+coalesce(sum(cents),0),project_used+coalesce(sum(cents) FILTER (WHERE project_id=NEW.project_id),0)
 INTO org_used,project_used FROM pending_monthly_capacity WHERE org_id=NEW.org_id AND run_id<>NEW.id;
 SELECT greatest(0,NEW.monthly_reservation_cents-coalesce(sum(cost_cents),0)) INTO demand
 FROM usage_attribution WHERE source_run_id=NEW.id;
 IF org_cap IS NOT NULL AND org_used+demand>org_cap THEN
   RAISE EXCEPTION 'Monthly organization capacity exhausted' USING ERRCODE='P4021';
 END IF;
 IF project_cap IS NOT NULL AND project_used+demand>project_cap THEN
   RAISE EXCEPTION 'Monthly project capacity exhausted' USING ERRCODE='P4022';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER monthly_run_capacity BEFORE INSERT OR UPDATE OF status,monthly_reservation_cents ON project_runs
 FOR EACH ROW EXECUTE FUNCTION reserve_monthly_run_capacity();

-- Unlike the response cache this identity never expires while its run exists.
CREATE TABLE IF NOT EXISTS intake_request_receipts (
 idempotency_key text NOT NULL,
 route_key text NOT NULL,
 request_hash text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 run_id text UNIQUE REFERENCES project_runs(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (idempotency_key,route_key)
);

-- Existing interrupted claims are ambiguous; only new explicit safe claims may retry.
ALTER TABLE intake_request_receipts ADD COLUMN IF NOT EXISTS external_effect_started boolean NOT NULL DEFAULT true;
