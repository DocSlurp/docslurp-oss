-- A run's input manifest is fingerprinted when admission creates or changes it, not on every page lookup.
-- Existing histories are deliberately not backfilled: missing evidence never authorizes pooled execution.
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS compute_input_manifest_hash text
  CHECK (compute_input_manifest_hash IS NULL OR compute_input_manifest_hash ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.compute_input_manifest_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.creation_source_keys IS NOT DISTINCT FROM OLD.creation_source_keys
    AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
    AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    IF NEW.compute_input_manifest_hash IS DISTINCT FROM OLD.compute_input_manifest_hash THEN
      RAISE EXCEPTION 'Compute input manifest evidence is immutable';
    END IF;
    RETURN NEW;
  END IF;
  NEW.compute_input_manifest_hash := encode(sha256(convert_to(
    jsonb_build_array(NEW.id, NEW.org_id, NEW.project_id, NEW.user_id, NEW.creation_source_keys)::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER compute_input_manifest_guard
BEFORE INSERT OR UPDATE OF creation_source_keys, org_id, project_id, user_id, compute_input_manifest_hash ON project_runs
FOR EACH ROW EXECUTE FUNCTION public.compute_input_manifest_guard();
--> statement-breakpoint
-- The worker cannot read API-key hashes. This narrow owner-side predicate returns only an opaque, short-lived
-- execution cohort, after live project access, key scopes/revocation, document ownership and generation checks.
CREATE OR REPLACE FUNCTION public.authorize_compute_cohort(
  p_org text, p_project text, p_run text, p_document text, p_generation text
) RETURNS TABLE (cohort_id text, valid_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN r.compute_input_manifest_hash IS NOT NULL AND (r.origin = 'app' OR k.id IS NOT NULL)
    THEN encode(sha256(convert_to(jsonb_build_array(
    r.org_id, r.project_id, r.id, r.execution_generation, r.user_id, r.compute_input_manifest_hash,
    r.stats->>'apiKeyId', k.scopes, k.project_ids, k.expires_at, om.role, pm.role
  )::text, 'UTF8')), 'hex') ELSE NULL END,
    least(now() + interval '10 seconds', coalesce(k.expires_at, now() + interval '10 seconds'))
  FROM public.project_runs r
  JOIN public.documents d ON d.run_id = r.id AND d.id = p_document AND d.org_id = r.org_id AND d.project_id = r.project_id
  JOIN public.projects p ON p.id = r.project_id AND p.org_id = r.org_id
  LEFT JOIN public.api_keys k ON k.id = r.stats->>'apiKeyId'
  LEFT JOIN public.org_memberships om ON om.org_id = r.org_id AND om.user_id = r.user_id
  LEFT JOIN public.project_members pm ON pm.project_id = r.project_id AND pm.user_id = r.user_id
  WHERE r.id = p_run AND r.org_id = p_org AND r.project_id = p_project
    AND r.execution_generation IS NOT DISTINCT FROM p_generation
    AND r.status IN ('queued', 'processing')
    AND coalesce(r.control_state, '') NOT IN ('cancelled', 'cancel_requested', 'paused', 'pause_requested', 'dead-letter')
    AND d.superseded_at IS NULL AND d.status <> 'cancelled'
    AND public.docslurp_project_access(r.project_id, r.user_id)
    AND (
      (nullif(r.stats->>'apiKeyId', '') IS NULL)
      OR (k.id IS NOT NULL AND k.org_id = r.org_id AND k.user_id = r.user_id
        AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        AND k.key_type = 'server' AND 'ingest' = ANY(k.scopes)
        AND ((k.key_type = 'server' AND cardinality(k.project_ids) = 0) OR r.project_id = ANY(k.project_ids)))
    )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.authorize_compute_cohort(text,text,text,text,text) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_app') THEN
    REVOKE ALL ON FUNCTION public.authorize_compute_cohort(text,text,text,text,text) FROM docslurp_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT EXECUTE ON FUNCTION public.authorize_compute_cohort(text,text,text,text,text) TO docslurp_worker;
  END IF;
END $$;
