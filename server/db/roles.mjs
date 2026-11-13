// Least-privilege Postgres roles (docs/self-host/database-roles.md).
//
//   owner   (docslurp)          owns every object; runs migrations (MIGRATION_DATABASE_URL)
//   app     (docslurp_app)      DML on every table, no DDL, not an owner
//   worker  (docslurp_worker)   DML only on the tables below; denied auth, credential and billing tables
//   backup  (docslurp_backup)   pg_read_all_data (granted by the superuser, see ops scripts)
//
// Runtime login roles are created outside migrations (cluster-wide CREATEROLE).
// Migration 0120 separately provisions its isolated non-login publisher, or
// requires an administrator to provision it for a restricted migration owner. `reconcileRoleGrants` runs as the owner after every migration
// (migrate.mjs) and grants only to the roles that exist, so a database without
// them behaves exactly as before. It is idempotent: the worker's table grants
// are revoked and re-granted from WORKER_TABLES each time, and the app's come
// from schema-wide grants plus default privileges for future objects.
//
// Every relation in schema public must appear in exactly one of WORKER_TABLES or
// WORKER_DENIED_TABLES; server/src/__tests__/db-roles.test.ts fails otherwise,
// so a migration cannot add a table the worker silently can or cannot use.

export const DEFAULT_DB_ROLES = Object.freeze({
  owner: "docslurp",
  app: "docslurp_app",
  worker: "docslurp_worker",
  backup: "docslurp_backup",
});

const DML = ["select", "insert", "update", "delete"];

/**
 * Relations the worker uses, with the privileges it needs and where. Column
 * lists restrict SELECT to the named columns. Rows written by triggers count:
 * most trigger functions are SECURITY INVOKER, so they run with the worker's
 * privileges (foreign-key cascades run as the table owner and need nothing).
 */
export const WORKER_TABLES = Object.freeze({
  api_key_usage: { privileges: DML, evidence: "worker/src/db/store.ts recordApiKeyPageUsage (upsert) and pruneOperationalLogs (delete); metering counters, no key material" },
  audit_log: { privileges: ["insert"], evidence: "worker/src/db/store.ts insert into audit_log" },
  billing_runtime: { privileges: ["select"], evidence: "worker/src/db/store.ts meteringEnforced" },
  chunk_entities: { privileges: DML, evidence: "worker/src/db/store.ts graph writes; superseded-purge.ts" },
  credit_debits_pending: { privileges: DML, evidence: "worker/src/db/usage-event-store.ts enqueue_org_credit_debit / apply_pending_org_debits" },
  credit_leases: { privileges: DML, evidence: "worker/src/db/credit-lease.ts; grant_credit_lease(); project_runs lease triggers" },
  credit_ledger: { privileges: ["insert"], evidence: "apply_pending_org_debits() -> debit_org_credits() -> append_credit_ledger() (usage-event-store.ts flush)" },
  document_assets: { privileges: DML, evidence: "worker/src/db/document-asset-ledger.ts writeDocumentAssetLedger (org-scoped upsert and prune)" },
  document_chunks: { privileges: DML, evidence: "worker/src/db/store.ts chunk writes; superseded-purge.ts" },
  document_cleanup_queue: { privileges: DML, evidence: "worker/src/db/superseded-purge.ts drainDocumentCleanupQueue; documents delete trigger" },
  document_exports: { privileges: ["select", "update"], evidence: "worker/src/exports/build-document-export.ts claims and finishes zip exports" },
  document_extraction_levels: { privileges: DML, evidence: "worker/src/db/document-asset-ledger.ts writeDocumentAssetLedger and listResumableDocuments" },
  document_extraction_shards: { privileges: DML, evidence: "worker/src/db/document-asset-ledger.ts writeDocumentAssetLedger (per-shard records) and listResumableDocuments" },
  document_maps: { privileges: DML, evidence: "worker/src/deferred/backfill-adoption.ts; document map stage" },
  document_page_facts: { privileges: DML, evidence: "worker/src/db/store.ts page facts" },
  document_page_renders: { privileges: DML, evidence: "packages/shared/src/worker-autoscale.ts; page render stages" },
  document_page_states: { privileges: DML, evidence: "worker/src/db/page-base-fee.ts; deferred indexing" },
  document_page_vectors: { privileges: DML, evidence: "worker/src/deferred/backfill-adoption.ts" },
  document_pages: { privileges: DML, evidence: "worker/src/db/store.ts page writes" },
  document_propositions: { privileges: DML, evidence: "worker/src/db/store.ts propositions" },
  document_run_stage_states: { privileges: DML, evidence: "worker/src/db/store.ts stage state" },
  document_summaries: { privileges: DML, evidence: "worker/src/db/store.ts summaries" },
  documents: { privileges: DML, evidence: "worker/src/db/store.ts and most stages" },
  embedding_reuse_refs: { privileges: DML, evidence: "worker/src/db/store.ts embedding reuse" },
  graph_jobs: { privileges: DML, evidence: "worker/src/graph/rebuild-job.ts" },
  kg_communities: { privileges: DML, evidence: "worker/src/db/store.ts graph communities" },
  kg_community_members: { privileges: DML, evidence: "worker/src/graph; superseded-purge.ts" },
  kg_document_state: { privileges: DML, evidence: "worker/src/db/store.ts graph state" },
  kg_edge_evidence: { privileges: DML, evidence: "worker/src/db/store.ts graph edges" },
  kg_edges: { privileges: DML, evidence: "worker/src/db/store.ts graph edges" },
  kg_nodes: { privileges: DML, evidence: "worker/src/graph/graph-store.ts" },
  media_reconciliation_actions: { privileges: DML, evidence: "worker/src/media/reconcile.ts" },
  media_video_admissions: { privileges: DML, evidence: "worker/src/media/journal.ts" },
  notification_deliveries: { privileges: ["select", "insert"], evidence: "worker/src/db/store.ts notification emails" },
  notification_prefs: { privileges: ["select"], evidence: "worker/src/db/store.ts run/cost emails" },
  organizations: { privileges: ["select", "update"], evidence: "worker/src/db/store.ts budget alerts; superseded-purge.ts retention_swept_at; debit_org_credits()" },
  org_teardown_failures: { privileges: ["select", "insert"], evidence: "worker/src/sandbox/source-quarantine.ts (recordOrgFailure insert ... returning; orgFailures count); operators delete rows" },
  page_stage_states: { privileges: DML, evidence: "worker/src/db/store.ts page stage state" },
  page_work_tasks: { privileges: DML, evidence: "worker/src/db/page-task-store.ts" },
  run_terminal_receipts: { privileges: ["select", "insert"], evidence: "worker/src/db/store.ts finalizeRun reads and inserts immutable generation receipts" },
  parser_eval_results: { privileges: ["insert"], evidence: "worker/src/db/store.ts parser evaluations" },
  performance_log: { privileges: DML, evidence: "worker/src/db/store.ts perf log and pruning" },
  pii_detections: { privileges: DML, evidence: "worker/src/stages/pii-detect.ts" },
  privacy_audit_log: { privileges: ["insert"], evidence: "worker/src/lib/privacy-guard.ts" },
  quarantined_sources: { privileges: ["select", "insert", "update"], evidence: "worker/src/sandbox/source-quarantine.ts (find; insert ... on conflict do update returning; noteRefusal update); operators delete rows" },
  remote_capacity_leases: { privileges: DML, evidence: "worker/src/media/capacity, journal.ts" },
  remote_capacity_watchdog: { privileges: DML, evidence: "worker/src/media/capacity/store.ts" },
  remote_media_jobs: { privileges: DML, evidence: "worker/src/media/journal.ts, reconcile.ts" },
  run_fast_page_image_budgets: { privileges: ["select", "insert", "update"], evidence: "worker/src/db/fast-page-image-budget.ts per-run Fast render budget" },
  run_fast_page_image_grants: { privileges: ["select", "insert"], evidence: "worker/src/db/fast-page-image-budget.ts per-document Fast render grants" },
  search_index_staleness: { privileges: DML, evidence: "worker/src/db/superseded-purge.ts DERIVED_TABLES" },
  upload_cleanup_owners: { privileges: ["select"], evidence: "worker/src/db/superseded-purge.ts original-upload ownership verification" },
  storage_cleanup_queue: { privileges: DML, evidence: "worker/src/db/superseded-purge.ts drainStorageCleanupQueue; project_runs trigger" },
  upload_session_files: { privileges: ["select"], evidence: "worker/src/db/superseded-purge.ts retained source keys" },
  upload_sessions: { privileges: ["select"], evidence: "worker/src/db/superseded-purge.ts" },
  usage_attribution: { privileges: ["select"], evidence: "worker/src/db/store.ts budget alerts; page-base-fee.ts (view)" },
  usage_events: { privileges: ["select", "insert"], evidence: "worker/src/db/usage-event-store.ts (insert ... on conflict do nothing returning id, cost_cents)" },
  user: { privileges: [], columns: { select: ["id", "email"] }, evidence: "worker/src/db/store.ts notification emails (owner email only)" },
  vector_index_outbox: { privileges: DML, evidence: "worker/src/stages/lancedb-write-queue.ts" },
  geo_accepted_sources: { privileges: DML, evidence: "structured-extract accepted-source checkpoint" },
  geo_projection_generations: { optional: true, privileges: DML, evidence: "optional PostGIS accepted-source publisher" },
  geo_projection_features: { optional: true, privileges: DML, evidence: "optional PostGIS accepted-source publisher" },
  // Escalation reads are written once per call (insert ... on conflict do nothing) and read back on retry; never updated or
  // deleted by the worker: rows go with their run (ON DELETE CASCADE, as the table owner).
  ocr_escalation_reads: { privileges: ["select", "insert"], evidence: "worker/src/db/store.ts ocrEscalationReads / recordOcrEscalationRead (worker/src/ocr/hosted-reader.ts)" },
  ready_geo_projection_generations: { optional: true, privileges: ["select"], evidence: "optional PostGIS readiness" },
  vector_index_tables: { privileges: DML, evidence: "worker/src/stages LanceDB tables; superseded-purge.ts" },
  vector_indexes: { privileges: DML, evidence: "worker/src/db/store.ts vector index rows" },
  vision_admission_tickets: { privileges: ["select", "insert", "delete"], evidence: "worker/src/db/vision-attempt-store.ts (durable admission ticket: overrun owner and retention)" },
  vision_org_attempts: { privileges: DML, evidence: "worker/src/db/vision-attempt-store.ts (vision attempt guard org count); usage-event-store.ts (charged request leaves at checkpoint)" },
  vision_run_attempts: { privileges: ["select", "insert", "update"], evidence: "worker/src/db/vision-attempt-store.ts (vision attempt guard run counts)" },
  vision_route_overruns: { privileges: ["select", "insert", "delete"], evidence: "worker/src/db/vision-attempt-store.ts (per-org route overrun count, route weight correction, retention)" },
  webhook_outbox: { privileges: ["select", "insert"], evidence: "worker/src/db/store.ts enqueueWebhook (insert ... returning id)" },
  // user_id stays for this release only: N-1 workers still check subscriptions by webhooks.user_id during the rollout
  // (docs/rollout-0121-0127.md), and losing it would fail their terminal-checkpoint outbox insert. A later release drops it.
  webhooks: { privileges: [], columns: { select: ["user_id", "org_id", "active", "events"] }, evidence: "worker/src/db/store.ts enqueueWebhookEvent subscription check by organization (no url or signing secret); user_id for N-1 workers during the 0125 rollout" },
  worker_capabilities: { privileges: DML, evidence: "worker/src/db/worker-capabilities.ts" },
  worker_maintenance_leases: { privileges: DML, evidence: "worker/src/db/worker-slot-store.ts" },
  worker_slot_tokens: { privileges: DML, evidence: "worker/src/db/worker-slot-store.ts; acquire/renew/release_worker_slot()" },
  project_corpus_stats: { privileges: DML, evidence: "documents trigger apply_project_corpus_stats()" },
  project_run_events: { privileges: ["select", "insert"], evidence: "worker/src/db/run-event-store.ts" },
  project_run_stage_states: { privileges: DML, evidence: "worker/src/db/store.ts run stage state" },
  project_runs: { privileges: DML, evidence: "worker/src/db/store.ts and page-task-store.ts" },
  project_secrets: { privileges: [], columns: { select: ["id", "project_id", "name", "type", "expires_at"] }, evidence: "worker/src/db/store.ts expiring-secret reminders (no encrypted_value)" },
  projects: { privileges: ["select", "update"], evidence: "worker/src/db/store.ts budget alerts; deferred/materialize-activity.ts" },
  // Read only: raised by the table owner through pricing_state_raise() (0131), never by a runtime role.
  pricing_provider_state: { privileges: ["select"], evidence: "packages/shared/src/pricing-loader.ts durableState (pricing provider, migration 0131)" },
  // Route tiers (0136): the worker reads current observations to rank vision hosts and records served latency.
  provider_endpoint_observations: { privileges: ["select", "insert"], evidence: "server/src/services/provider-observations.ts recordServedLatency (traffic rows); tier selection" },
  provider_endpoint_current: { privileges: ["select"], evidence: "server/src/services/provider-observations.ts readProviderObservations (view)" },
});

/** Relations the worker must not touch, and why. */
export const WORKER_DENIED_TABLES = Object.freeze({
  account: "Better Auth credentials (password hashes, OAuth tokens)",
  admin_credit_requests: "billing administration",
  admin_stats: "admin dashboard materialized view",
  api_keys: "API key hashes and scopes",
  auth_rate_limits: "authentication budgets: per-recipient email, code checks, SSO",
  budget_alerts: "API-managed budget alert settings",
  chat_answer_evidence_spans: "chat (API only)",
  chat_message_feedback: "chat (API only)",
  chat_sessions: "chat (API only)",
  chat_operations: "first-party chat identity/session/budget metadata (API/native chat executor only)",
  chat_operation_events: "retained chat output (API/native chat executor only)",
  chat_run_dependencies: "authorized chat task discovery links (API only); ingestion publishes through document_page_states",
  realtime_revision_counters: "private numeric publication storage; only validated triggers may write",
  realtime_revisions: "aggregate dashboard revision view (API only); ingestion triggers use realtime_revision_counters",
  realtime_scope_revisions: "per-project/run dashboard revision view (API only, 0152); ingestion triggers use realtime_revision_counters",
  extracts: "extract retention, charges and deletion (API maintenance sweep only); the worker reads runs' storage_prefix",
  chat_turns: "chat (API only)",
  connector_sync_log: "connector administration (API only)",
  credit_grants: "billing: purchased and promotional credit",
  document_corrections: "API-managed review corrections",
  document_tags: "API-managed tags",
  feedback_reports: "support reports filed by users (API only)",
  idempotency_cache: "API request replay cache",
  interactive_spend_holds: "API interactive spend admission",
  mcp_oauth_clients: "MCP OAuth credentials",
  mcp_oauth_device_attempts: "MCP OAuth credentials",
  mcp_oauth_device_codes: "MCP OAuth credentials",
  mcp_oauth_grants: "MCP OAuth credentials",
  mcp_oauth_requests: "MCP OAuth credentials",
  mcp_oauth_tokens: "MCP OAuth credentials",
  mcp_service_connections: "MCP connector credentials",
  mfa_totp_replay: "Better Auth two-factor replay guard",
  oauth_accounts: "OAuth identity links and tokens",
  org_invites: "membership invitations",
  org_memberships: "membership and roles",
  org_memberships_removed_backup: "memberships removed by 0127 (one organization per user); admin recovery only",
  organizations_removed_backup: "empty personal organizations and their empty projects deleted by 0127; admin recovery only",
  parser_eval_fixtures: "evaluation fixtures (admin)",
  passkey: "Better Auth passkey credentials",
  query_suggestions: "search (API only)",
  rateLimit: "Better Auth rate limiting",
  schema_migrations: "legacy migration bookkeeping",
  search_eval_fixtures: "search evaluation (admin)",
  search_experiment_results: "search evaluation view (admin)",
  search_experiments: "search evaluation (admin)",
  search_session_results: "search (API only)",
  search_sessions: "search (API only)",
  search_zero_results: "search (API only)",
  session: "Better Auth sessions",
  sso_auth_requests: "SSO",
  sso_domains: "SSO",
  sso_identity_links: "SSO",
  starter_credit_claims: "billing: starter credit claims",
  storage_meter_days: "billing: storage meter",
  stripe_credit_grant_voids: "billing: Stripe",
  stripe_webhook_events: "billing: Stripe",
  twoFactor: "Better Auth TOTP secrets and backup codes",
  user_settings: "user preferences",
  project_recommendation_seen_events: "per-user reviewed activity IDs; dashboard only",
  project_recommendation_visits: "per-user project review state; dashboard only",
  auth_otp_generations: "Better Auth OTP generation digests and recipient identifiers",
  verification: "Better Auth verification tokens",
  waitlist_signups: "marketing sign-ups (PII)",
  webhook_deliveries: "webhook delivery log, sent by the API",
  worker_slot_leases: "view over worker_slot_tokens for the API",
  project_connectors: "connector credentials",
  project_invites: "membership invitations",
  project_members: "membership and roles",
  project_search_settings: "search (API only)",
  project_slugs: "slug history (API only)",
  user_client_surfaces: "admin user directory analytics (API only)",
  user_signup_attribution: "admin user directory analytics (API only)",
});

/** `"name"` with embedded quotes doubled. */
/**
 * SECURITY DEFINER functions a runtime role may reach: the realtime revision triggers and the API's compaction call
 * (0120). Keep equal to @docslurp/shared's RUNTIME_SECURITY_DEFINER_ALLOWLIST (db-roles.test.ts checks); reconcile
 * revokes EXECUTE on every other owner definer function, and the runtime identity rule refuses one a runtime role reaches.
 */
export const RUNTIME_SECURITY_DEFINER_ALLOWLIST = Object.freeze([
  "public.realtime_changed()",
  "public.realtime_statement_changed()",
  "public.realtime_search_session_changed()",
  "public.realtime_materialization_changed()",
  "public.realtime_compact_revisions(text)",
]);

export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/**
 * The statements that bring grants in schema public to the declared state, for
 * the roles in `present` (role names that exist). Pure: `relations` are the
 * public relation names that exist, `sequences` maps a sequence name to the
 * table that owns it. `migrationsTable` says drizzle.__drizzle_migrations exists.
 * `columns` (table -> column names), when given, drops worker column grants for
 * columns that do not exist yet.
 */
export function roleGrantStatements({ owner, roles = DEFAULT_DB_ROLES, present, relations, sequences = {}, migrationsTable = false, nativeSchema = false, columns: existingColumns = null }) {
  const statements = [];
  const has = (role) => present.includes(role);
  const ownerIdent = quoteIdent(owner);
  // The schema owner (pg_database_owner on PG 15+) keeps CREATE; nobody else needs it.
  statements.push("revoke create on schema public from public");
  if (has(roles.app)) {
    const app = quoteIdent(roles.app);
    statements.push(
      `grant usage on schema public to ${app}`,
      `revoke create on schema public from ${app}`,
      `grant select, insert, update, delete on all tables in schema public to ${app}`,
      `grant usage, select, update on all sequences in schema public to ${app}`,
      `grant execute on all functions in schema public to ${app}`,
      `alter default privileges for role ${ownerIdent} in schema public grant select, insert, update, delete on tables to ${app}`,
      `alter default privileges for role ${ownerIdent} in schema public grant usage, select, update on sequences to ${app}`,
      `alter default privileges for role ${ownerIdent} in schema public grant execute on functions to ${app}`,
    );
  }
  if (has(roles.worker)) {
    const worker = quoteIdent(roles.worker);
    statements.push(
      `grant usage on schema public to ${worker}`,
      `revoke create on schema public from ${worker}`,
      // Start from nothing so a table removed from WORKER_TABLES loses its grant.
      `revoke all on all tables in schema public from ${worker}`,
      `revoke all on all sequences in schema public from ${worker}`,
    );
    const existing = new Set(relations);
    for (const [table, spec] of Object.entries(WORKER_TABLES)) {
      if (!existing.has(table)) continue;
      const target = `public.${quoteIdent(table)}`;
      if (spec.privileges.length > 0) statements.push(`grant ${spec.privileges.join(", ")} on ${target} to ${worker}`);
      for (const [privilege, columns] of Object.entries(spec.columns ?? {})) {
        // A database caught between migrations (a test that reconciles, then applies the
        // newest ones) lacks columns the next migration adds; `reconcileRoleGrants` always
        // runs after migrating, so by then they exist and are granted.
        const present = existingColumns?.[table] ? columns.filter((column) => existingColumns[table].includes(column)) : columns;
        if (present.length > 0) statements.push(`grant ${privilege} (${present.map(quoteIdent).join(", ")}) on ${target} to ${worker}`);
      }
    }
    for (const [sequence, table] of Object.entries(sequences)) {
      if (WORKER_TABLES[table]?.privileges.includes("insert")) {
        statements.push(`grant usage, select on sequence public.${quoteIdent(sequence)} to ${worker}`);
      }
    }
    if (migrationsTable) {
      // worker/src/db/worker-capabilities.ts reports the newest applied
      // migration (schema_applied_when) so the API can gate on schema skew.
      statements.push(
        `grant usage on schema drizzle to ${worker}`,
        `grant select on drizzle.__drizzle_migrations to ${worker}`,
      );
    }
  }
  if (relations.includes("realtime_revision_counters")) {
    // Schema-wide application grants must never expose publication internals.
    // realtime_scope_revisions and realtime_statement_changed() both arrive with 0152: the view is read like
    // realtime_revisions, the function is revoked like the other triggers; both are absent before 0152.
    const scoped = relations.includes("realtime_scope_revisions");
    const functions = `public.realtime_changed(),${scoped ? "public.realtime_statement_changed()," : ""}public.realtime_search_session_changed(),public.realtime_materialization_changed(),public.realtime_record_change(text),public.realtime_fold_committed(text),public.realtime_compact_revisions(text)`;
    const views = scoped ? "public.realtime_revisions,public.realtime_scope_revisions" : "public.realtime_revisions";
    statements.push(`revoke all on function ${functions} from public`,
      `revoke all on public.realtime_revision_counters,${views} from public`);
    for (const role of [roles.app, roles.worker].filter(has)) {
      statements.push(`revoke all on public.realtime_revision_counters,${views} from ${quoteIdent(role)}`,
        `revoke all on function ${functions} from ${quoteIdent(role)}`);
    }
    if (has(roles.app)) statements.push(`grant select on ${views} to ${quoteIdent(roles.app)}`,
      `grant execute on function public.realtime_compact_revisions(text) to ${quoteIdent(roles.app)}`);
  }
  if (relations.includes("pricing_provider_state")) {
    // Monotone pricing-provider state (0131): runtime roles only read it. pricing_state_raise is the table owner's (the
    // operator's activation credential); no runtime role executes it (council J). The app's schema-wide DML and default
    // privileges are taken back here.
    statements.push("revoke all on public.pricing_provider_state from public",
      "revoke all on function public.pricing_state_raise(text, bigint) from public");
    for (const role of [roles.app, roles.worker].filter(has)) {
      statements.push(`revoke all on public.pricing_provider_state from ${quoteIdent(role)}`,
        `grant select on public.pricing_provider_state to ${quoteIdent(role)}`,
        `revoke all on function public.pricing_state_raise(text, bigint) from ${quoteIdent(role)}`);
    }
  }
  if (nativeSchema) {
    // Native chat execution is an application service, never the ingestion role.
    statements.push("revoke all on schema docslurp_mastra from public",
      "revoke all on all tables in schema docslurp_mastra from public",
      "revoke all on all sequences in schema docslurp_mastra from public");
    if (has(roles.app)) {
      const app = quoteIdent(roles.app);
      statements.push(`grant usage on schema docslurp_mastra to ${app}`,
        `revoke create on schema docslurp_mastra from ${app}`,
        `grant select, insert, update, delete on all tables in schema docslurp_mastra to ${app}`,
        `grant usage, select, update on all sequences in schema docslurp_mastra to ${app}`,
        `alter default privileges for role ${ownerIdent} in schema docslurp_mastra grant select, insert, update, delete on tables to ${app}`,
        `alter default privileges for role ${ownerIdent} in schema docslurp_mastra grant usage, select, update on sequences to ${app}`);
    }
    if (has(roles.worker)) {
      const worker = quoteIdent(roles.worker);
      statements.push(`revoke all on schema docslurp_mastra from ${worker}`,
        `revoke all on all tables in schema docslurp_mastra from ${worker}`,
        `revoke all on all sequences in schema docslurp_mastra from ${worker}`);
    }
  }
  if (has(roles.backup)) {
    // pg_read_all_data (granted by the superuser) covers reads; usage keeps
    // pg_dump working on clusters older than PostgreSQL 14 when SELECT is granted instead.
    statements.push(`grant usage on schema public to ${quoteIdent(roles.backup)}`);
  }
  return statements;
}

/**
 * Applies roleGrantStatements in one transaction on `client` (a `pg` Client
 * connected as the owner or a superuser). Returns the roles it reconciled;
 * does nothing when none of them exist.
 */
export async function reconcileRoleGrants(client, { roles = DEFAULT_DB_ROLES, log = console.log } = {}) {
  const wanted = [roles.app, roles.worker, roles.backup];
  const { rows: roleRows } = await client.query("select rolname from pg_roles where rolname = any($1::text[])", [wanted]);
  const present = roleRows.map((row) => row.rolname);
  if (present.length === 0) return [];
  // The objects' owner, not necessarily current_user: a superuser may reconcile
  // (ops scripts), and default privileges must name the role that runs migrations.
  const { rows: [{ owner }] } = await client.query(
    "select coalesce((select tableowner from pg_tables where schemaname = 'public' and tablename = 'documents'), current_user::text) as owner",
  );
  const { rows: relationRows } = await client.query(
    "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')",
  );
  const { rows: sequenceRows } = await client.query(`
    select s.relname as sequence, t.relname as "table"
    from pg_class s
    join pg_namespace n on n.oid = s.relnamespace
    join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a','i')
    join pg_class t on t.oid = d.refobjid
    where s.relkind = 'S' and n.nspname = 'public'
  `);
  const { rows: columnRows } = await client.query(
    "select c.relname, array_agg(a.attname::text) as columns from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped group by c.relname",
  );
  // Owner SECURITY DEFINER functions outside the runtime allowlist (recheck Q #5): nobody but the owner executes them.
  const { rows: definerRows } = await client.query(`
    select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and not (p.oid = any (array(select to_regprocedure(a) from unnest($1::text[]) a where to_regprocedure(a) is not null)))`,
    [RUNTIME_SECURITY_DEFINER_ALLOWLIST]);
  const { rows: [{ migrations }] } = await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as migrations");
  const { rows: [{ native }] } = await client.query("select to_regnamespace('docslurp_mastra') is not null as native");
  const statements = roleGrantStatements({
    nativeSchema: native === true,
    owner,
    migrationsTable: migrations === true,
    roles,
    present,
    relations: relationRows.map((row) => row.relname),
    columns: Object.fromEntries(columnRows.map((row) => [row.relname, row.columns])),
    sequences: Object.fromEntries(sequenceRows.map((row) => [row.sequence, row.table])),
  });
  for (const { signature } of definerRows) {
    statements.push(`revoke all on function ${signature} from public`);
    for (const role of present) statements.push(`revoke all on function ${signature} from ${quoteIdent(role)}`);
  }
  await client.query("begin");
  try {
    for (const statement of statements) await client.query(statement);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  log(`[db-roles] reconciled grants for ${present.join(", ")} (${statements.length} statements)`);
  return present;
}

/**
 * Throws unless the connected role can run migrations: it must be able to
 * create in schema public and own the existing application tables. PostGIS
 * extension members remain owned by their privileged installer. Catches a
 * MIGRATION_DATABASE_URL left unset after DATABASE_URL moved to a restricted role.
 */
export async function assertMigrationOwner(client) {
  const { rows: [row] } = await client.query(`
    with application_tables as (
      select t.tableowner from pg_tables t
      join pg_namespace n on n.nspname = t.schemaname
      join pg_class c on c.relnamespace = n.oid and c.relname = t.tablename
      where t.schemaname = 'public' and not exists (
        select 1 from pg_depend d
        join pg_extension e on e.oid = d.refobjid
        where d.classid = 'pg_class'::regclass and d.objid = c.oid
          and d.objsubid = 0 and d.refclassid = 'pg_extension'::regclass
          and d.deptype = 'e' and e.extname = 'postgis'
      )
    )
    select current_user as role,
      (select rolsuper from pg_roles where rolname = current_user) as superuser,
      has_schema_privilege(current_user, 'public', 'CREATE') as can_create,
      (select count(*)::int from application_tables t
        where not pg_has_role(current_user, t.tableowner, 'USAGE')) as foreign_tables,
      (select min(t.tableowner) from application_tables t
        where not pg_has_role(current_user, t.tableowner, 'USAGE')) as owner
  `);
  if (row.superuser) return row.role;
  if (!row.can_create || row.foreign_tables > 0) {
    throw new Error(
      `[migrate] role "${row.role}" cannot run migrations: it ${row.can_create ? "does not own" : "has no CREATE on"} schema public` +
        `${row.owner ? ` (tables are owned by "${row.owner}")` : ""}. ` +
        "Set MIGRATION_DATABASE_URL to the owner role's connection string; DATABASE_URL may point at a restricted runtime role (docs/self-host/database-roles.md).",
    );
  }
  return row.role;
}

// CLI: `DATABASE_URL=<owner or superuser URL> node server/db/roles.mjs` reconciles
// grants without applying migrations (ops scripts run it right after creating the roles).
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const url = process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Set DATABASE_URL (or MIGRATION_DATABASE_URL) to the owner's connection string");
  const { createRequire } = await import("node:module");
  const { Client } = createRequire(import.meta.url)("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const reconciled = await reconcileRoleGrants(client);
    if (reconciled.length === 0) console.log(`[db-roles] none of ${Object.values(DEFAULT_DB_ROLES).slice(1).join(", ")} exist; nothing to do`);
  } finally {
    await client.end();
  }
}
