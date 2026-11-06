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

/**
 * Whether this process refuses to start when its database role could move the pricing high-water mark (council M #1):
 * DOCSLURP_REFUSE_PRICING_STATE_WRITER=1/0, defaulting to on wherever pricing is required (the service profile, or
 * DOCSLURP_PRICING_REQUIRED=1).
 */
export function refusePricingStateWriter(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DOCSLURP_REFUSE_PRICING_STATE_WRITER?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return pricingRequired(env);
}

/**
 * One row: every way the connected role could move the pricing high-water mark. The single definition the startup check
 * (assertRuntimeCannotMovePricingState) and the deploy gate (server/db/runtime-role-check.mjs) share (council P #1):
 * superuser; ownership of pricing_provider_state (direct or inherited); INSERT, UPDATE, DELETE or TRUNCATE on it (has_table_privilege
 * counts direct and inherited grants and PUBLIC); membership of pg_write_all_data; EXECUTE on pricing_state_raise.
 */
export const PRICING_STATE_WRITER_SQL = `
  select current_user::text as role,
    coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
    case when to_regclass('public.pricing_provider_state') is null then false
      else pg_has_role(current_user, (select relowner from pg_class where oid = to_regclass('public.pricing_provider_state')), 'USAGE') end as owns_state,
    case when to_regclass('public.pricing_provider_state') is null then ''
      else concat_ws(',',
        case when has_table_privilege(current_user, 'public.pricing_provider_state', 'INSERT') then 'insert' end,
        case when has_table_privilege(current_user, 'public.pricing_provider_state', 'UPDATE') then 'update' end,
        case when has_table_privilege(current_user, 'public.pricing_provider_state', 'DELETE') then 'delete' end,
        case when has_table_privilege(current_user, 'public.pricing_provider_state', 'TRUNCATE') then 'truncate' end) end as writes_state,
    case when exists (select 1 from pg_roles where rolname = 'pg_write_all_data') then pg_has_role(current_user, 'pg_write_all_data', 'USAGE') else false end as write_all_data,
    case when to_regprocedure('public.pricing_state_raise(text, bigint)') is null then false
      else has_function_privilege(current_user, 'public.pricing_state_raise(text, bigint)', 'EXECUTE') end as raises_state
`;

/** Pure: why a PRICING_STATE_WRITER_SQL row could move the mark; empty when it cannot. */
export function pricingStateWriterReasons(row: Record<string, unknown> | undefined): string[] {
  if (!row) return ["the pricing state writer check returned no row"];
  const writes = typeof row.writes_state === "string" ? row.writes_state.split(",").filter(Boolean) : [];
  return [
    row.superuser === true ? "is a superuser" : null,
    row.owns_state === true ? "owns pricing_provider_state" : null,
    writes.length ? `can ${writes.join(", ")} pricing_provider_state` : null,
    row.write_all_data === true ? "is a member of pg_write_all_data" : null,
    row.raises_state === true ? "may execute pricing_state_raise" : null,
  ].filter((reason): reason is string => reason !== null);
}

/**
 * Throw when this process's database role could move the pricing high-water mark (pricingStateWriterReasons). A runtime
 * process (API, worker, chat executor) must connect as its least-privilege role; the deploy gates the same rule
 * (runtime-role-check.mjs), and this refuses at startup as well.
 */
export async function assertRuntimeCannotMovePricingState(sql: DurableStateSql): Promise<void> {
  const rows = await sql.unsafe(PRICING_STATE_WRITER_SQL);
  const row = rows[0] as Record<string, unknown> | undefined;
  const reasons = pricingStateWriterReasons(row);
  if (reasons.length) {
    throw new Error(`database role ${String(row?.role ?? "?")} ${reasons.join("; ")}: a runtime process must connect as its least-privilege role (docslurp_app or docslurp_worker); refusing to start (DOCSLURP_REFUSE_PRICING_STATE_WRITER=0 is an emergency override only)`);
  }
}

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
  // Before anything prices: a runtime role that could move the mark refuses to start (council M #1, P #1).
  if (options.sql && refusePricingStateWriter(env)) await assertRuntimeCannotMovePricingState(options.sql);
  else if (options.sql && pricingRequired(env)) {
    // The emergency override (DOCSLURP_REFUSE_PRICING_STATE_WRITER=0 where pricing is required, for a role rollback):
    // loud on every start, and the check still runs so the log names what this role could do (council P #2).
    const reasons = await options.sql.unsafe(PRICING_STATE_WRITER_SQL).then((rows) => pricingStateWriterReasons(rows[0] as Record<string, unknown> | undefined), (error: unknown) => [`could not be checked: ${error instanceof Error ? error.message : String(error)}`]);
    console.error(`[pricing] EMERGENCY OVERRIDE: DOCSLURP_REFUSE_PRICING_STATE_WRITER=0 lets this process start as a role that ${reasons.length ? reasons.join("; ") : "cannot move the pricing mark"}. Remove the override once the least-privilege roles are restored; deploys still refuse this role.`);
  }
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
