/*
 * Load the deployment's pricing provider (Node only; `@docslurp/shared/pricing-loader`).
 *
 * DOCSLURP_PRICING_PLUGIN names one module (an absolute path or a file: URL) exporting `register(host)`, which returns a
 * PricingProvider (pricing-provider.ts). The server and the worker call `loadPricingProvider()` at startup, before they
 * serve a request or poll a task queue.
 *
 * Fail closed:
 * - a named plugin that cannot load, or returns an invalid provider, is a startup error;
 * - DOCSLURP_SERVICE_PROFILE=service or DOCSLURP_PRICING_REQUIRED=1 without DOCSLURP_PRICING_PLUGIN is a startup error, so
 *   a deployment that bills never prices with the open default;
 * Without a plugin and outside the service profile, the open default prices (a flat, published rule).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  installPricingProvider,
  pricing,
  pricingProviderInstalled,
  pricingRequired,
  PRICING_PROVIDER_API_VERSION,
  type PricingProvider,
} from "./pricing-provider.js";

/**
 * Durable, fleet-shared, monotone state for the pricing provider: named bigint counters in Postgres
 * (pricing_provider_state, migration 0131), shared by every API, worker and chat-executor process. Read-only here: `read`
 * returns a key's value (null when never raised) and throws when the database is unavailable; what the provider does then
 * (fail closed) is its own rule. Runtime processes never raise a value (council J): only the operator's activation tool
 * does, with the table owner's credential, through PricingStateAdmin. Keys are 1-128 characters of [a-z0-9._:-],
 * starting with a letter or digit.
 */
export interface PricingDurableState {
  read(key: string): Promise<bigint | null>;
}

/**
 * The operator's side of the durable state: `raise` is a strict compare-and-set through pricing_state_raise. It seeds a
 * missing key, or sets an existing key to a candidate strictly above the stored value, and returns the new value; a
 * candidate at or below the stored value fails, so of concurrent raises to one value exactly one succeeds. A candidate
 * below 1 is refused, and an existing key rises by at most 1000 per raise.
 * Needs the table owner's credential: no runtime role may execute pricing_state_raise (migration 0131).
 */
export interface PricingStateAdmin extends PricingDurableState {
  raise(key: string, candidate: bigint): Promise<bigint>;
}

const DURABLE_KEY = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/** The minimal SQL client the durable state needs: postgres.js `sql.unsafe` (or any client with the same shape). */
export interface DurableStateSql {
  unsafe(query: string, params?: unknown[]): PromiseLike<ReadonlyArray<Record<string, unknown>>>;
}

function durableKey(key: string): string {
  if (typeof key !== "string" || !DURABLE_KEY.test(key)) throw new Error("pricing durable state: invalid key");
  return key;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d{1,19}$/.test(value)) return BigInt(value);
  throw new Error("pricing durable state: the database returned a non-integer value");
}

/** The read-only durable state over a runtime process's own pool (the plugin host's `durableState`). */
export function pricingDurableStateFromSql(sql: DurableStateSql): PricingDurableState {
  return {
    async read(key) {
      const rows = await sql.unsafe("select value::text as value from pricing_provider_state where key = $1", [durableKey(key)]);
      return rows.length === 0 ? null : toBigInt(rows[0]!.value);
    },
  };
}

/** The operator's durable state over a connection as the table owner: reads, and raises through pricing_state_raise. */
export function pricingStateAdminFromSql(sql: DurableStateSql): PricingStateAdmin {
  return {
    ...pricingDurableStateFromSql(sql),
    async raise(key, candidate) {
      if (typeof candidate !== "bigint" || candidate < INT8_MIN || candidate > INT8_MAX) throw new Error("pricing durable state: candidate must be a 64-bit bigint");
      const rows = await sql.unsafe("select pricing_state_raise($1, $2::bigint)::text as value", [durableKey(key), candidate.toString()]);
      if (rows.length !== 1) throw new Error("pricing durable state: raise returned no value");
      return toBigInt(rows[0]!.value);
    },
  };
}

/** The least-privilege roles a runtime process may connect as (core server/db/roles.mjs: app and worker). */
export const RUNTIME_DATABASE_ROLES: readonly string[] = Object.freeze(["docslurp_app", "docslurp_worker"]);

/**
 * Whether this process refuses to start unless its database role is a safe runtime identity (assertRuntimeDatabaseIdentity).
 * Always on wherever pricing is required (the service profile, or DOCSLURP_PRICING_REQUIRED=1): there,
 * DOCSLURP_REFUSE_PRICING_STATE_WRITER=0 is ignored (council O #3). Elsewhere it is opt-in with
 * DOCSLURP_REFUSE_PRICING_STATE_WRITER=1.
 */
export function refusePricingStateWriter(env: Record<string, string | undefined> = process.env): boolean {
  if (pricingRequired(env)) return true;
  const raw = env.DOCSLURP_REFUSE_PRICING_STATE_WRITER?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * SECURITY DEFINER functions a runtime role may reach (execute, or fire as a trigger on a table it writes): the realtime
 * revision triggers and the API's compaction call (migration 0120). Any other owner-privileged function a runtime role
 * can reach refuses the identity (recheck Q #5); core server/db/roles.mjs revokes PUBLIC EXECUTE on the rest.
 */
export const RUNTIME_SECURITY_DEFINER_ALLOWLIST: readonly string[] = Object.freeze([
  "public.realtime_changed()",
  "public.realtime_statement_changed()",
  "public.realtime_search_session_changed()",
  "public.realtime_materialization_changed()",
  "public.realtime_compact_revisions(text)",
]);

/**
 * One row describing the connected role, $1 the roles it may hold (text[]), $2 RUNTIME_SECURITY_DEFINER_ALLOWLIST. The
 * single identity definition the deploy gate (server/db/runtime-role-check.mjs, one expected role) and startup (both
 * runtime roles) share (councils P #1, O #1, recheck Q #5). Every privilege is evaluated for each role the connection
 * holds (itself and the allowed roles it is a member of, so a SET ROLE into an allowed role is covered):
 *
 * - superuser, or create-role/create-db/replication/bypass-RLS;
 * - any role membership other than the allowed roles, direct or indirect and whatever its INHERIT or SET option
 *   (a SET ROLE to the owner or postgres; pg_execute_server_program; pg_write_all_data; pg_database_owner);
 * - CREATE on the database, or on any schema outside the system schemas (public, docslurp_mastra, drizzle, ...);
 * - owned relations, functions, types or schemas outside the system schemas, or owned large objects;
 * - any grant option (WITH GRANT OPTION) on a relation, column, function, schema, the database or a large object (recheck
 *   S #6): a runtime role must not be able to hand its privileges to another role;
 * - ownership of pricing_provider_state, INSERT/UPDATE (any column)/DELETE/TRUNCATE on it, or EXECUTE on
 *   pricing_state_raise;
 * - a SECURITY DEFINER function outside the allowlist that it may execute, or that fires as a trigger on a table it
 *   may write;
 * - a view or rule over pricing_provider_state on a relation it may write (writes through it run as the owner).
 */
export const RUNTIME_IDENTITY_SQL = `
  with me as (select * from pg_roles where rolname = current_user),
  held as (select r.* from pg_roles r, me where r.oid = me.oid or (r.rolname = any($1::text[]) and pg_has_role(me.oid, r.oid, 'MEMBER'))),
  system_ns as (select oid from pg_namespace where nspname in ('pg_catalog', 'information_schema') or nspname like 'pg_toast%' or nspname like 'pg_temp%'),
  extension_members as (select d.objid from pg_depend d join pg_extension e on e.oid = d.refobjid
    where d.deptype = 'e' and d.classid = 'pg_proc'::regclass and e.extname = any (array['pgcrypto', 'plpgsql'])),
  state as (select to_regclass('public.pricing_provider_state') as oid),
  writable as (select c.oid from pg_class c, held h where c.relkind in ('r', 'p', 'v', 'f', 'm') and c.relnamespace not in (select oid from system_ns)
    and (has_any_column_privilege(h.oid, c.oid, 'INSERT, UPDATE') or has_table_privilege(h.oid, c.oid, 'DELETE, TRUNCATE'))),
  -- What a write the role may make can touch (council X #4): its writable relations and, through their views' and rules'
  -- actions, every relation those reach, recursively. Triggers there fire whatever the role may EXECUTE.
  touched as (
    with recursive reach(oid) as (
      select oid from writable
      union
      select d.refobjid from pg_rewrite rw join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid
        and d.refclassid = 'pg_class'::regclass
        join reach on rw.ev_class = reach.oid
      where d.refobjid <> reach.oid
    )
    select distinct oid from reach),
  over_state as (
    with recursive reach(oid) as (
      select oid from state where oid is not null
      union
      select rw.ev_class from pg_rewrite rw join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid
        join reach on d.refobjid = reach.oid where rw.ev_class <> reach.oid
    )
    select oid from reach where oid <> (select oid from state))
  select me.rolname::text as role,
    (select bool_or(rolsuper) from held) as superuser,
    (select bool_or(rolcreaterole or rolcreatedb or rolreplication or rolbypassrls) from held) as elevated,
    coalesce((select string_agg(r.rolname::text, ',' order by r.rolname) from pg_roles r
      where r.oid <> me.oid and not (r.rolname = any($1::text[])) and pg_has_role(me.oid, r.oid, 'MEMBER')), '') as other_memberships,
    coalesce((select string_agg(rolname::text, ',' order by rolname) from held where rolname = any($1::text[])), '') as allowed_held,
    coalesce((select string_agg(distinct m.roleid::regrole::text, ',' order by m.roleid::regrole::text) from pg_auth_members m
      where m.member in (select oid from held) and m.admin_option), '') as admin_memberships,
    (select bool_or(has_database_privilege(h.oid, current_database(), 'CREATE')) from held h) as can_create_in_database,
    coalesce((select string_agg(distinct n.nspname::text, ',' order by n.nspname::text) from pg_namespace n, held h
      where n.oid not in (select oid from system_ns) and has_schema_privilege(h.oid, n.oid, 'CREATE')), '') as create_schemas,
    ((select count(*) from pg_class where relowner in (select oid from held) and relnamespace not in (select oid from system_ns))
      + (select count(*) from pg_proc where proowner in (select oid from held) and pronamespace not in (select oid from system_ns))
      + (select count(*) from pg_type where typowner in (select oid from held) and typnamespace not in (select oid from system_ns))
      + (select count(*) from pg_namespace where nspowner in (select oid from held) and oid not in (select oid from system_ns))
      + (select count(*) from pg_largeobject_metadata where lomowner in (select oid from held))
      + (select count(*) from pg_operator where oprowner in (select oid from held) and oprnamespace not in (select oid from system_ns))
      + (select count(*) from pg_opclass where opcowner in (select oid from held) and opcnamespace not in (select oid from system_ns))
      + (select count(*) from pg_opfamily where opfowner in (select oid from held) and opfnamespace not in (select oid from system_ns))
      + (select count(*) from pg_collation where collowner in (select oid from held) and collnamespace not in (select oid from system_ns))
      + (select count(*) from pg_conversion where conowner in (select oid from held) and connamespace not in (select oid from system_ns))
      + (select count(*) from pg_ts_config where cfgowner in (select oid from held) and cfgnamespace not in (select oid from system_ns))
      + (select count(*) from pg_ts_dict where dictowner in (select oid from held) and dictnamespace not in (select oid from system_ns))
      + (select count(*) from pg_statistic_ext where stxowner in (select oid from held))
      + (select count(*) from pg_foreign_data_wrapper where fdwowner in (select oid from held))
      + (select count(*) from pg_foreign_server where srvowner in (select oid from held))
      + (select count(*) from pg_publication where pubowner in (select oid from held))
      + (select count(*) from pg_event_trigger where evtowner in (select oid from held))
      + (select count(*) from pg_extension where extowner in (select oid from held)))::int as owned_objects,
    coalesce((select string_agg(distinct kind, ',' order by kind) from (
      select 'relation' as kind from pg_class c, aclexplode(c.relacl) a
        where c.relnamespace not in (select oid from system_ns) and a.is_grantable and a.grantee in (select oid from held)
      union all select 'column' from pg_attribute att join pg_class c on c.oid = att.attrelid, aclexplode(att.attacl) a
        where c.relnamespace not in (select oid from system_ns) and a.is_grantable and a.grantee in (select oid from held)
      union all select 'function' from pg_proc p, aclexplode(p.proacl) a
        where p.pronamespace not in (select oid from system_ns) and a.is_grantable and a.grantee in (select oid from held)
      union all select 'schema' from pg_namespace n, aclexplode(n.nspacl) a
        where n.oid not in (select oid from system_ns) and a.is_grantable and a.grantee in (select oid from held)
      union all select 'database' from pg_database d, aclexplode(d.datacl) a
        where d.datname = current_database() and a.is_grantable and a.grantee in (select oid from held)
      union all select 'large object' from pg_largeobject_metadata l, aclexplode(l.lomacl) a
        where a.is_grantable and a.grantee in (select oid from held)
      union all select 'type' from pg_type t, aclexplode(t.typacl) a where a.is_grantable and a.grantee in (select oid from held)
      union all select 'language' from pg_language l, aclexplode(l.lanacl) a where a.is_grantable and a.grantee in (select oid from held)
      union all select 'foreign data wrapper' from pg_foreign_data_wrapper w, aclexplode(w.fdwacl) a
        where a.is_grantable and a.grantee in (select oid from held)
      union all select 'foreign server' from pg_foreign_server f, aclexplode(f.srvacl) a where a.is_grantable and a.grantee in (select oid from held)
      union all select 'tablespace' from pg_tablespace t, aclexplode(t.spcacl) a where a.is_grantable and a.grantee in (select oid from held)
      union all select 'parameter' from pg_parameter_acl p, aclexplode(p.paracl) a where a.is_grantable and a.grantee in (select oid from held)
      union all select 'default privileges' from pg_default_acl p, aclexplode(p.defaclacl) a where a.is_grantable and a.grantee in (select oid from held)
    ) grantable), '') as grant_options,
    case when (select oid from state) is null then false
      else (select relowner from pg_class where oid = (select oid from state)) in (select oid from held) end as owns_state,
    case when (select oid from state) is null then ''
      else concat_ws(',',
        case when (select bool_or(has_any_column_privilege(h.oid, 'public.pricing_provider_state', 'INSERT')) from held h) then 'insert' end,
        case when (select bool_or(has_any_column_privilege(h.oid, 'public.pricing_provider_state', 'UPDATE')) from held h) then 'update' end,
        case when (select bool_or(has_table_privilege(h.oid, 'public.pricing_provider_state', 'DELETE')) from held h) then 'delete' end,
        case when (select bool_or(has_table_privilege(h.oid, 'public.pricing_provider_state', 'TRUNCATE')) from held h) then 'truncate' end) end as writes_state,
    case when to_regprocedure('public.pricing_state_raise(text, bigint)') is null then false
      else (select bool_or(has_function_privilege(h.oid, 'public.pricing_state_raise(text, bigint)', 'EXECUTE')) from held h) end as raises_state,
    coalesce((select string_agg(distinct p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) from pg_proc p
      where p.prosecdef and p.pronamespace not in (select oid from system_ns) and p.oid not in (select objid from extension_members)
        and not (p.oid = any (array(select to_regprocedure(a) from unnest($2::text[]) a where to_regprocedure(a) is not null)))
        and (exists (select 1 from held h where has_function_privilege(h.oid, p.oid, 'EXECUTE'))
          or exists (select 1 from pg_trigger t where t.tgfoid = p.oid and t.tgrelid in (select oid from touched)))), '') as definer_functions,
    case when (select oid from state) is null then ''
      else coalesce((select string_agg(distinct o.oid::regclass::text, ',' order by o.oid::regclass::text) from over_state o
        where o.oid in (select oid from writable)), '') end as state_write_paths,
    -- A foreign key from pricing_provider_state whose ON DELETE or ON UPDATE action changes state rows (CASCADE, SET NULL,
    -- SET DEFAULT), to a parent the role can delete from or update, directly or through a view or rule (council X #4).
    case when (select oid from state) is null then ''
      else coalesce((select string_agg(distinct c.confrelid::regclass::text, ',' order by c.confrelid::regclass::text) from pg_constraint c
        where c.contype = 'f' and c.conrelid = (select oid from state)
          and ((c.confdeltype in ('c', 'n', 'd') and (c.confrelid in (select oid from touched)
                 or exists (select 1 from held h where has_table_privilege(h.oid, c.confrelid, 'DELETE, TRUNCATE'))))
            or (c.confupdtype in ('c', 'n', 'd') and (c.confrelid in (select oid from touched)
                 or exists (select 1 from held h where has_any_column_privilege(h.oid, c.confrelid, 'UPDATE')))))), '') end as state_fk_paths
  from me
`;

/** Pure: why a RUNTIME_IDENTITY_SQL row is not a safe runtime identity for `allowed`; empty when it is. */
export function runtimeIdentityReasons(row: Record<string, unknown> | undefined, allowed: readonly string[] = RUNTIME_DATABASE_ROLES): string[] {
  if (!row) return ["the runtime identity check returned no row"];
  const list = (value: unknown) => (typeof value === "string" ? value.split(",").filter(Boolean) : []);
  const others = list(row.other_memberships);
  const held = list(row.allowed_held);
  const writes = list(row.writes_state);
  const schemas = list(row.create_schemas);
  const definers = list(row.definer_functions);
  const paths = list(row.state_write_paths);
  const fkPaths = list(row.state_fk_paths);
  const grantable = list(row.grant_options);
  const admins = list(row.admin_memberships);
  return [
    row.superuser === true ? "is (or can become) a superuser" : null,
    row.elevated === true ? "can create roles or databases, replicate or bypass row security" : null,
    others.length ? `is a member of ${others.join(", ")} (SET ROLE or inherited privileges)` : null,
    held.length ? null : `is not a member of ${allowed.join(" or ")}`,
    row.can_create_in_database === true ? "can CREATE in the database (a schema could shadow another role's search_path)" : null,
    schemas.length ? `can CREATE in schema ${schemas.join(", ")}` : null,
    Number(row.owned_objects) > 0 ? `owns ${Number(row.owned_objects)} object(s) (relations, functions, types, schemas, large objects, operators, foreign servers, publications or other schema objects)` : null,
    admins.length ? `holds ADMIN OPTION on ${admins.join(", ")}: it could grant that role to others` : null,
    grantable.length ? `holds grant options (WITH GRANT OPTION) on ${grantable.join(", ")}: it could pass privileges on` : null,
    row.owns_state === true ? "owns pricing_provider_state" : null,
    writes.length ? `can ${writes.join(", ")} pricing_provider_state` : null,
    row.raises_state === true ? "may execute pricing_state_raise" : null,
    definers.length ? `can reach SECURITY DEFINER function(s) outside the allowlist: ${definers.join(", ")}` : null,
    paths.length ? `can write ${paths.join(", ")}, a view or rule over pricing_provider_state` : null,
    fkPaths.length ? `can delete from or update ${fkPaths.join(", ")}, whose foreign key from pricing_provider_state cascades or sets values` : null,
  ].filter((reason): reason is string => reason !== null);
}

/**
 * Throw unless this process's database role is a safe runtime identity (runtimeIdentityReasons over `allowed`): a runtime
 * process (API, worker, chat executor) must connect as its least-privilege role. The deploy gates the same rule.
 */
export async function assertRuntimeDatabaseIdentity(sql: DurableStateSql, allowed: readonly string[] = RUNTIME_DATABASE_ROLES): Promise<void> {
  const rows = await sql.unsafe(RUNTIME_IDENTITY_SQL, [allowed as string[], RUNTIME_SECURITY_DEFINER_ALLOWLIST as string[]]);
  const row = rows[0] as Record<string, unknown> | undefined;
  const reasons = runtimeIdentityReasons(row, allowed);
  if (reasons.length) {
    throw new Error(`database role ${String(row?.role ?? "?")} ${reasons.join("; ")}: a runtime process must connect as its least-privilege role (${allowed.join(" or ")}); refusing to start`);
  }
}

/** The startup check's earlier name. */
export const assertRuntimeCannotMovePricingState = (sql: DurableStateSql): Promise<void> => assertRuntimeDatabaseIdentity(sql);

/** A process that has no database: every call throws, so a provider that needs durable state fails closed there. */
export const UNAVAILABLE_PRICING_DURABLE_STATE: PricingDurableState = {
  async read() { throw new Error("pricing durable state is not available in this process"); },
};

/**
 * What a pricing plugin's `register(host)` receives. `shared` is the host's own `@docslurp/shared`: a plugin imports only
 * types from it and calls its helpers through `host.shared`, so one copy of the shared module (and its provider registry)
 * runs in the process.
 */
export interface PricingPluginHost {
  apiVersion: typeof PRICING_PROVIDER_API_VERSION;
  env: Readonly<Record<string, string | undefined>>;
  shared: typeof import("./index.js");
  /** Durable, fleet-shared monotone state, read-only (PricingDurableState); throws in a process without a database. */
  durableState: PricingDurableState;
}

export interface LoadPricingProviderOptions {
  /** The entrypoint's durable state (pricingDurableStateFromSql over its pool); omitted gives one that always throws. */
  durableState?: PricingDurableState;
  /** The entrypoint's pool: with refusePricingStateWriter(env), startup refuses a role that could move the mark. */
  sql?: DurableStateSql;
  /** Tests: how the plugin module is imported. */
  importModule?: (specifier: string) => Promise<unknown>;
}

export interface PricingPluginModule {
  register(host: PricingPluginHost): PricingProvider | Promise<PricingProvider>;
}

/** The module DOCSLURP_PRICING_PLUGIN names, as a file URL, or null when unset. */
export function pricingPluginSpecifier(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.DOCSLURP_PRICING_PLUGIN?.trim() ?? "";
  if (!raw) return null;
  if (raw.includes(",")) throw new Error("DOCSLURP_PRICING_PLUGIN names exactly one module");
  if (raw.startsWith("file:")) return new URL(raw).href;
  if (!path.isAbsolute(raw)) throw new Error(`DOCSLURP_PRICING_PLUGIN must be an absolute path or a file: URL: ${raw}`);
  return pathToFileURL(raw).href;
}

let loadedFrom: string | null | undefined;

/**
 * Install the configured provider once per process and return the active provider's id. Throws on any failure: a
 * process told to use a pricing plugin, or running the service profile, must not start without it.
 */
export async function loadPricingProvider(
  env: Record<string, string | undefined> = process.env,
  options: LoadPricingProviderOptions = {},
): Promise<string> {
  const importModule = options.importModule ?? ((specifier: string) => import(specifier));
  const specifier = pricingPluginSpecifier(env);
  if (loadedFrom !== undefined) {
    if (loadedFrom !== specifier) throw new Error("A pricing provider is already loaded from a different DOCSLURP_PRICING_PLUGIN");
    return pricing().id;
  }
  if (!specifier) {
    if (pricingRequired(env)) {
      throw new Error("DOCSLURP_SERVICE_PROFILE=service or DOCSLURP_PRICING_REQUIRED=1 needs a pricing provider in DOCSLURP_PRICING_PLUGIN; refusing to start with the open pricing default");
    }
    loadedFrom = null;
    console.warn("[pricing] provider=open: no DOCSLURP_PRICING_PLUGIN; charges follow the open default's flat per-page rule");
    return pricing().id;
  }
  // Before any plugin loads or anything prices: a runtime process refuses to start unless its role is a safe runtime
  // identity (councils M #1, P #1, O #1). Where pricing is required this cannot be turned off (council O #3).
  if (pricingRequired(env) && /^(0|false)$/i.test(env.DOCSLURP_REFUSE_PRICING_STATE_WRITER?.trim() ?? "")) {
    console.error("[pricing] DOCSLURP_REFUSE_PRICING_STATE_WRITER=0 is ignored where pricing is required; the runtime identity check still runs");
  }
  // A process that must check its identity but was handed no database cannot skip the check (recheck Q #6).
  if (pricingRequired(env) && !options.sql) {
    throw new Error("pricing is required but the runtime identity check has no database connection (options.sql); refusing to start");
  }
  if (options.sql && refusePricingStateWriter(env)) await assertRuntimeDatabaseIdentity(options.sql);
  let module: Partial<PricingPluginModule>;
  try {
    module = (await importModule(specifier)) as Partial<PricingPluginModule>;
  } catch (error) {
    throw new Error(`Pricing plugin failed to load: ${specifier}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof module.register !== "function") throw new Error(`Pricing plugin exports no register(host): ${specifier}`);
  const shared = await import("./index.js");
  const provider = await module.register({
    apiVersion: PRICING_PROVIDER_API_VERSION,
    env,
    shared,
    durableState: options.durableState ?? UNAVAILABLE_PRICING_DURABLE_STATE,
  });
  installPricingProvider(provider);
  loadedFrom = specifier;
  // Generic ids only: the provider's details are its own to log.
  console.log(`[pricing] provider=${provider.id} version=${provider.version} api=${PRICING_PROVIDER_API_VERSION}`);
  return provider.id;
}

/** Whether startup loaded a deployment provider (for health checks). */
export function pricingPluginLoaded(): boolean {
  return pricingProviderInstalled();
}

/** Tests only. */
export function resetPricingLoaderForTests(): void {
  loadedFrom = undefined;
}
