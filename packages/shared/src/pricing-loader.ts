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
  pricingServiceProfile,
  PRICING_PROVIDER_API_VERSION,
  type PricingProvider,
} from "./pricing-provider.js";

/**
 * What a pricing plugin's `register(host)` receives. `shared` is the host's own `@docslurp/shared`: a plugin imports only
 * types from it and calls its helpers through `host.shared`, so one copy of the shared module (and its provider registry)
 * runs in the process.
 */
export interface PricingPluginHost {
  apiVersion: typeof PRICING_PROVIDER_API_VERSION;
  env: Readonly<Record<string, string | undefined>>;
  shared: typeof import("./index.js");
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
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<string> {
  const specifier = pricingPluginSpecifier(env);
  if (loadedFrom !== undefined) {
    if (loadedFrom !== specifier) throw new Error("A pricing provider is already loaded from a different DOCSLURP_PRICING_PLUGIN");
    return pricing().id;
  }
  if (!specifier) {
    if (pricingServiceProfile(env) || env.DOCSLURP_PRICING_REQUIRED?.trim() === "1") {
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
  const provider = await module.register({ apiVersion: PRICING_PROVIDER_API_VERSION, env, shared });
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
