-- Operator-owned limits and durable content-free reservations. Uncertain launches never expire into free capacity.
CREATE TABLE IF NOT EXISTS public.compute_fleets (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200 AND id ~ '^[A-Za-z0-9_.:-]+$'),
  max_active integer NOT NULL CHECK (max_active BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_compute_fleet_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Compute fleet identity is immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER guard_compute_fleet_identity BEFORE UPDATE ON public.compute_fleets
FOR EACH ROW EXECUTE FUNCTION public.guard_compute_fleet_identity();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.compute_allocation_reservations (
  id uuid PRIMARY KEY,
  fleet_id text NOT NULL REFERENCES public.compute_fleets(id),
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 200),
  provider_id text CHECK (length(provider_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text CHECK (release_reason IN ('not-created', 'provider-deleted')),
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CHECK (release_reason IS DISTINCT FROM 'not-created' OR provider_id IS NULL),
  CHECK (release_reason IS DISTINCT FROM 'provider-deleted' OR provider_id IS NOT NULL),
  UNIQUE (fleet_id, provider_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS compute_allocation_active_idx ON public.compute_allocation_reservations(fleet_id) WHERE released_at IS NULL;
--> statement-breakpoint
-- The unique occupied slot also prevents oversubscription under stale REPEATABLE READ snapshots.
CREATE UNIQUE INDEX IF NOT EXISTS compute_allocation_occupied_slot ON public.compute_allocation_reservations(fleet_id,slot) WHERE released_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_compute_allocation_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE cap integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.slot IS NOT NULL OR NEW.provider_id IS NOT NULL OR NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Compute reservation must begin unallocated';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('compute-fleet:' || NEW.fleet_id, 0));
    SELECT max_active INTO cap FROM public.compute_fleets WHERE id = NEW.fleet_id AND enabled FOR SHARE;
    IF cap IS NULL THEN RAISE EXCEPTION 'Compute fleet unavailable'; END IF;
    -- Let an identical retry reach ON CONFLICT without consuming a second slot. The caller checks its fleet and state.
    SELECT slot INTO NEW.slot FROM public.compute_allocation_reservations WHERE id = NEW.id;
    IF FOUND THEN RETURN NEW; END IF;
    IF (SELECT count(*) FROM public.compute_allocation_reservations WHERE fleet_id = NEW.fleet_id AND released_at IS NULL) >= cap THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'compute_fleet_capacity';
    END IF;
    SELECT n INTO NEW.slot FROM pg_catalog.generate_series(1, cap) n WHERE NOT EXISTS (
      SELECT 1 FROM public.compute_allocation_reservations r WHERE r.fleet_id = NEW.fleet_id AND r.slot = n AND r.released_at IS NULL
    ) ORDER BY n LIMIT 1;
    IF NEW.slot IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'compute_fleet_capacity'; END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.slot IS DISTINCT FROM OLD.slot OR NEW.id IS DISTINCT FROM OLD.id OR NEW.fleet_id IS DISTINCT FROM OLD.fleet_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
    OR (OLD.released_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Compute reservation identity and history are immutable';
  END IF;
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN NEW.released_at := clock_timestamp(); END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER guard_compute_allocation_reservation BEFORE INSERT OR UPDATE ON public.compute_allocation_reservations
FOR EACH ROW EXECUTE FUNCTION public.guard_compute_allocation_reservation();
--> statement-breakpoint
REVOKE ALL ON public.compute_fleets, public.compute_allocation_reservations FROM PUBLIC;
--> statement-breakpoint
-- CREATE TABLE may inherit grants to custom runtime role names. Close those grants inside this migration,
-- before any separate role reconciliation or crash can expose the operator cap and ledger.
DO $$
DECLARE recipient record; columns text;
BEGIN
  FOR recipient IN
    SELECT DISTINCT c.relname,r.rolname FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL (
      SELECT a.grantee FROM pg_catalog.aclexplode(c.relacl) a
      UNION SELECT a.grantee FROM pg_catalog.pg_attribute att CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a WHERE att.attrelid=c.oid
    ) grants JOIN pg_catalog.pg_roles r ON r.oid=grants.grantee
    WHERE c.oid IN ('public.compute_fleets'::regclass,'public.compute_allocation_reservations'::regclass) AND grants.grantee<>c.relowner
  LOOP
    SELECT string_agg(quote_ident(attname),',') INTO columns FROM pg_catalog.pg_attribute
      WHERE attrelid=('public.' || recipient.relname)::regclass AND attnum>0 AND NOT attisdropped;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',recipient.relname,recipient.rolname);
    EXECUTE format('REVOKE ALL (%s) ON TABLE public.%I FROM %I',columns,recipient.relname,recipient.rolname);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_app') THEN
    REVOKE ALL ON public.compute_fleets, public.compute_allocation_reservations FROM docslurp_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.compute_fleets, public.compute_allocation_reservations FROM docslurp_worker;
    GRANT SELECT, UPDATE(id) ON public.compute_fleets TO docslurp_worker;
    GRANT SELECT, INSERT, UPDATE ON public.compute_allocation_reservations TO docslurp_worker;
  END IF;
END $$;
