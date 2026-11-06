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
 * (pricing_provider_state, migration 0131), shared by every API, worker and chat-executor process. `read` returns a key's
 * value (null when never raised); `raise` stores max(stored, candidate) atomically and returns the stored value, which is
 * never lowered. Both throw when the database is unavailable: what the provider does then (fail closed) is its own rule.
 * Keys are 1-128 characters of [a-z0-9._:-], starting with a letter or digit.
 */
export interface PricingDurableState {
  read(key: string): Promise<bigint | null>;
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

/** The durable state over a database connection (the entrypoint's own pool): reads the table, raises through pricing_state_raise. */
export function pricingDurableStateFromSql(sql: DurableStateSql): PricingDurableState {
  return {
    async read(key) {
      const rows = await sql.unsafe("select value::text as value from pricing_provider_state where key = $1", [durableKey(key)]);
      return rows.length === 0 ? null : toBigInt(rows[0]!.value);
    },
    async raise(key, candidate) {
      if (typeof candidate !== "bigint" || candidate < INT8_MIN || candidate > INT8_MAX) throw new Error("pricing durable state: candidate must be a 64-bit bigint");
      const rows = await sql.unsafe("select pricing_state_raise($1, $2::bigint)::text as value", [durableKey(key), candidate.toString()]);
      if (rows.length !== 1) throw new Error("pricing durable state: raise returned no value");
      return toBigInt(rows[0]!.value);
    },
  };
}

/** A process that has no database: every call throws, so a provider that needs durable state fails closed there. */
export const UNAVAILABLE_PRICING_DURABLE_STATE: PricingDurableState = {
  async read() { throw new Error("pricing durable state is not available in this process"); },
  async raise() { throw new Error("pricing durable state is not available in this process"); },
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
  /** Durable, fleet-shared monotone state (PricingDurableState); throws in a process without a database. */
  durableState: PricingDurableState;
}

export interface LoadPricingProviderOptions {
  /** The entrypoint's durable state (pricingDurableStateFromSql over its pool); omitted gives one that always throws. */
  durableState?: PricingDurableState;
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
