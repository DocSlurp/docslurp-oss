-- Fleet-wide job admission with per-organization fairness. Operator-owned caps; content-free, expiring tickets.
-- A ticket is one job's claim on a shared compute fleet (slots on warm hosts, jobs on reader VMs). Unlike provider
-- reservations (0181), a ticket holds no provider resource: a worker that dies stops renewing it and it expires.
CREATE TABLE IF NOT EXISTS public.compute_job_fleets (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200 AND id ~ '^[A-Za-z0-9_.:-]+$'),
  max_jobs integer NOT NULL CHECK (max_jobs BETWEEN 1 AND 10000),
  max_jobs_per_org integer NOT NULL CHECK (max_jobs_per_org >= 1),
  enabled boolean NOT NULL DEFAULT false,
  CHECK (max_jobs_per_org <= max_jobs)
);
--> statement-breakpoint
CREATE OR REPLACE TRIGGER guard_compute_job_fleet_identity BEFORE UPDATE ON public.compute_job_fleets
FOR EACH ROW EXECUTE FUNCTION public.guard_compute_fleet_identity();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.compute_job_tickets (
  id uuid PRIMARY KEY,
  fleet_id text NOT NULL REFERENCES public.compute_job_fleets(id),
  -- A keyed hash of the organization, never its id: the table is fairness bookkeeping, not tenant data.
  org_key text NOT NULL CHECK (org_key ~ '^[a-f0-9]{64}$'),
  -- Measured pages of the job (structural counts the worker established), for demand; never document metadata.
  pages integer NOT NULL CHECK (pages BETWEEN 1 AND 100000),
  -- routing: a job deciding its host (demand only, never admitted); waiting: in the fair queue; admitted: holds a job slot.
  state text NOT NULL CHECK (state IN ('routing', 'waiting', 'admitted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  queued_at timestamptz,
  admitted_at timestamptz,
  expires_at timestamptz NOT NULL,
  CHECK ((state = 'routing') = (queued_at IS NULL)),
  CHECK ((state = 'admitted') = (admitted_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS compute_job_tickets_fleet_state_idx ON public.compute_job_tickets(fleet_id, state, queued_at);
--> statement-breakpoint
-- Join the fleet's fair queue (routing -> waiting), drop expired tickets, then admit waiting tickets while the fleet has
-- room: each free slot goes to the waiting ticket whose organization holds the fewest admitted jobs (under its cap),
-- oldest first. One organization's burst therefore never starves another's single job. Serialized per fleet.
CREATE OR REPLACE FUNCTION public.compute_job_admit(p_fleet text, p_ticket uuid, p_lease_seconds integer) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE cap integer; org_cap integer; total integer; pick uuid; result text;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'Invalid compute job lease'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('compute-job-fleet:' || p_fleet, 0));
  SELECT max_jobs, max_jobs_per_org INTO cap, org_cap FROM public.compute_job_fleets WHERE id = p_fleet AND enabled FOR SHARE;
  IF cap IS NULL THEN RETURN 'unavailable'; END IF;
  DELETE FROM public.compute_job_tickets WHERE fleet_id = p_fleet AND expires_at < clock_timestamp();
  UPDATE public.compute_job_tickets
    SET expires_at = clock_timestamp() + p_lease_seconds * interval '1 second',
        state = CASE WHEN state = 'routing' THEN 'waiting' ELSE state END,
        queued_at = coalesce(queued_at, clock_timestamp())
    WHERE id = p_ticket AND fleet_id = p_fleet;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  LOOP
    SELECT count(*) INTO total FROM public.compute_job_tickets WHERE fleet_id = p_fleet AND state = 'admitted';
    EXIT WHEN total >= cap;
    pick := NULL;
    SELECT t.id INTO pick FROM public.compute_job_tickets t
      LEFT JOIN (SELECT org_key, count(*) AS n FROM public.compute_job_tickets
                 WHERE fleet_id = p_fleet AND state = 'admitted' GROUP BY org_key) held ON held.org_key = t.org_key
      WHERE t.fleet_id = p_fleet AND t.state = 'waiting' AND coalesce(held.n, 0) < org_cap
      ORDER BY coalesce(held.n, 0), t.queued_at, t.id LIMIT 1;
    EXIT WHEN pick IS NULL;
    UPDATE public.compute_job_tickets SET state = 'admitted', admitted_at = clock_timestamp() WHERE id = pick;
  END LOOP;
  SELECT state INTO result FROM public.compute_job_tickets WHERE id = p_ticket;
  RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON public.compute_job_fleets, public.compute_job_tickets FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.compute_job_admit(text, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
-- As 0181: close grants a custom role inherited from owner default privileges before reconciliation can run.
DO $$
DECLARE recipient record; columns text;
BEGIN
  FOR recipient IN
    SELECT DISTINCT c.relname,r.rolname FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL (
      SELECT a.grantee FROM pg_catalog.aclexplode(c.relacl) a
      UNION SELECT a.grantee FROM pg_catalog.pg_attribute att CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a WHERE att.attrelid=c.oid
    ) grants JOIN pg_catalog.pg_roles r ON r.oid=grants.grantee
    WHERE c.oid IN ('public.compute_job_fleets'::regclass,'public.compute_job_tickets'::regclass) AND grants.grantee<>c.relowner
  LOOP
    SELECT string_agg(quote_ident(attname),',') INTO columns FROM pg_catalog.pg_attribute
      WHERE attrelid=('public.' || recipient.relname)::regclass AND attnum>0 AND NOT attisdropped;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',recipient.relname,recipient.rolname);
    EXECUTE format('REVOKE ALL (%s) ON TABLE public.%I FROM %I',columns,recipient.relname,recipient.rolname);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_app') THEN
    REVOKE ALL ON public.compute_job_fleets, public.compute_job_tickets FROM docslurp_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.compute_job_fleets, public.compute_job_tickets FROM docslurp_worker;
    GRANT SELECT, UPDATE(id) ON public.compute_job_fleets TO docslurp_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.compute_job_tickets TO docslurp_worker;
    GRANT EXECUTE ON FUNCTION public.compute_job_admit(text, uuid, integer) TO docslurp_worker;
  END IF;
END $$;
