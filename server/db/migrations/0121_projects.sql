-- Breaking terminology cutover. Stop old producers and drain jobs first.
-- Preserve tenant IDs, allowlists, storage keys and historical migrations.
-- Catalog operations are restricted to application-owned public objects.
DO $preflight$
DECLARE r record; conflict boolean;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('usage_events','metadata'),('search_sessions','metadata'),('webhook_outbox','payload'),('storage_cleanup_queue','payload')) AS fields(table_name,column_name) LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I ? ''workspaceId'' AND %I ? ''projectId'' AND %I->''workspaceId'' IS DISTINCT FROM %I->''projectId'')',r.table_name,r.column_name,r.column_name,r.column_name,r.column_name) INTO conflict;
    IF conflict THEN RAISE EXCEPTION 'conflicting project selectors in %.%',r.table_name,r.column_name; END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I ? ''workspaceIds'' AND %I ? ''projectIds'' AND %I->''workspaceIds'' IS DISTINCT FROM %I->''projectIds'')',r.table_name,r.column_name,r.column_name,r.column_name,r.column_name) INTO conflict;
    IF conflict THEN RAISE EXCEPTION 'conflicting project selector arrays in %.%',r.table_name,r.column_name; END IF;
  END LOOP;
END $preflight$;
--> statement-breakpoint
DO $migration$
DECLARE r record; definition text; body text; argument text;
BEGIN
  -- Rename relations before their columns; PostgreSQL maintains FK/view OIDs.
  FOR r IN SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') AND c.relname LIKE '%workspace%'
  LOOP
    EXECUTE format('ALTER %s public.%I RENAME TO %I',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      r.relname,replace(r.relname,'workspace','project'));
  END LOOP;
  FOR r IN SELECT c.relname,c.relkind,a.attname FROM pg_attribute a
    JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped AND a.attname LIKE '%workspace%'
  LOOP
    EXECUTE format('ALTER %s public.%I RENAME COLUMN %I TO %I',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      r.relname,r.attname,replace(r.attname,'workspace','project'));
  END LOOP;
  FOR r IN SELECT c.conname,t.relname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.conname LIKE '%workspace%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',r.relname,r.conname,replace(r.conname,'workspace','project'));
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='i' AND c.relname LIKE '%workspace%'
  LOOP EXECUTE format('ALTER INDEX public.%I RENAME TO %I',r.relname,replace(r.relname,'workspace','project')); END LOOP;
  FOR r IN SELECT t.tgname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname LIKE '%workspace%'
  LOOP EXECUTE format('ALTER TRIGGER %I ON public.%I RENAME TO %I',r.tgname,r.relname,replace(r.tgname,'workspace','project')); END LOOP;
END $migration$;
--> statement-breakpoint
-- Column renames do not rewrite dollar-quoted function bodies or JSON keys.
-- Keep function OIDs, owners, security-definer settings and ACLs intact.
-- Existing SQL input argument names remain private implementation details:
-- CREATE OR REPLACE cannot rename them without dropping dependencies.
DO $migration$
DECLARE r record; definition text; body text; argument text;
BEGIN
  FOR r IN SELECT p.oid,p.proname,p.prosrc,p.proargnames,pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f' AND p.prosrc LIKE '%workspace%'
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e')
      AND p.proname<>'org_spend_status'
  LOOP
    IF r.proname LIKE '%workspace%' THEN
      EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I',r.proname,r.args,replace(r.proname,'workspace','project'));
    END IF;
    definition := pg_get_functiondef(r.oid);
    body := replace(replace(replace(r.prosrc,'workspace','project'),'Workspace','Project'),'WORKSPACE','PROJECT');
    FOREACH argument IN ARRAY coalesce(r.proargnames,ARRAY[]::text[]) LOOP
      IF argument LIKE '%workspace%' THEN body := regexp_replace(body,'\m'||replace(argument,'workspace','project')||'\M',argument,'g'); END IF;
    END LOOP;
    EXECUTE replace(definition,r.prosrc,body);
  END LOOP;
END $migration$;
--> statement-breakpoint
-- org_spend_status changes its OUT column names. No CASCADE: unexpected
-- dependencies must block the cutover rather than being silently discarded.
-- Preserve its grants explicitly across recreation.
CREATE TEMP TABLE project_spend_function ON COMMIT DROP AS
SELECT pg_get_functiondef(p.oid) AS definition,pg_get_function_identity_arguments(p.oid) AS args,
  pg_get_userbyid(p.proowner) AS owner_name,p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='org_spend_status';
--> statement-breakpoint
DO $migration$
DECLARE r record; permission record; identity text;
BEGIN
  SELECT * INTO STRICT r FROM project_spend_function;
  EXECUTE format('DROP FUNCTION public.org_spend_status(%s)',r.args);
  EXECUTE replace(r.definition,'workspace','project');
  SELECT p.oid::regprocedure::text INTO STRICT identity FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='org_spend_status';
  -- Remove grants from default ACLs before restoring exactly the prior ACL.
  FOR permission IN SELECT DISTINCT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=identity::regprocedure LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',identity,CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END);
  END LOOP;
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I',identity,r.owner_name);
  FOR permission IN SELECT * FROM aclexplode(coalesce(r.proacl,acldefault('f',(SELECT oid FROM pg_roles WHERE rolname=r.owner_name)))) LOOP
    EXECUTE format('GRANT %s ON FUNCTION %s TO %s%s',permission.privilege_type,identity,CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,CASE WHEN permission.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $migration$;
--> statement-breakpoint
-- Rewrite the view's JSON selector after renaming its output column in place.
DO $migration$
BEGIN
  EXECUTE 'CREATE OR REPLACE VIEW public.usage_attribution AS '||replace(pg_get_viewdef('public.usage_attribution'::regclass,true),'workspaceIds','projectIds');
END $migration$;
--> statement-breakpoint
-- Only system-owned attribution keys are migrated; never recursively rewrite
-- customer metadata, extraction schemas, document fields or stored file bytes.
UPDATE usage_events SET metadata=(metadata-'workspaceId'-'workspaceIds')
  || CASE WHEN metadata ? 'workspaceId' THEN jsonb_build_object('projectId',metadata->'workspaceId') ELSE '{}'::jsonb END
  || CASE WHEN metadata ? 'workspaceIds' THEN jsonb_build_object('projectIds',metadata->'workspaceIds') ELSE '{}'::jsonb END
WHERE metadata ?| ARRAY['workspaceId','workspaceIds'];
--> statement-breakpoint
UPDATE search_sessions SET metadata=(metadata-'workspaceId'-'workspaceIds')
  || CASE WHEN metadata ? 'workspaceId' THEN jsonb_build_object('projectId',metadata->'workspaceId') ELSE '{}'::jsonb END
  || CASE WHEN metadata ? 'workspaceIds' THEN jsonb_build_object('projectIds',metadata->'workspaceIds') ELSE '{}'::jsonb END
WHERE metadata ?| ARRAY['workspaceId','workspaceIds'];
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT documents_dedup_scope_check;
ALTER TABLE documents ADD CONSTRAINT documents_dedup_scope_check CHECK (dedup_scope IN ('project','org')) NOT VALID;
UPDATE documents SET dedup_scope='project' WHERE dedup_scope='workspace';
ALTER TABLE documents VALIDATE CONSTRAINT documents_dedup_scope_check;
UPDATE project_runs SET pause_reason='project_budget_paused' WHERE pause_reason='workspace_budget_paused';

--> statement-breakpoint
-- Persisted protocol selectors must retain exactly the same scope across cutover.
UPDATE api_keys SET scopes=array_replace(scopes,'workspaces:manage','projects:manage')
WHERE 'workspaces:manage'=ANY(scopes);
--> statement-breakpoint
UPDATE webhook_outbox SET payload=(payload-'workspaceId')||jsonb_build_object('projectId',payload->'workspaceId')
WHERE payload ? 'workspaceId';
--> statement-breakpoint
UPDATE storage_cleanup_queue SET payload=(payload-'workspaceId')||jsonb_build_object('projectId',payload->'workspaceId')
WHERE payload ? 'workspaceId';
