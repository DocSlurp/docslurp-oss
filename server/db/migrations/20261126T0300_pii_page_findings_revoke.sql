-- pii_page_findings is operator-only (docs/pii-page-withholding.md). Default privileges could reach the API role or
-- PUBLIC before role reconciliation runs; revoke them here, for databases that already applied the table's migration.
REVOKE ALL ON public.pii_page_findings FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_app') THEN
    REVOKE ALL ON public.pii_page_findings FROM docslurp_app;
  END IF;
END $$;
