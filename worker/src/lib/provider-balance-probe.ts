import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Provider balance probe: an optional, deployment-supplied check that the account behind a model route can take
 * more work, asked by long background jobs (the summary tree backfill) before they claim work and before every
 * batch. Nothing else at runtime reads a provider's live balance: a drained account is otherwise noticed only when a
 * request fails for payment.
 *
 * This repository holds the interface and the loader only. There is no built-in probe, no provider-specific code
 * and no floor value here: a deployment that wants the check names a module in `DOCSLURP_PROVIDER_BALANCE_PROBE`
 * (an absolute path or a `file:` URL) that exports `createProviderBalanceProbe(host)`; the module decides which
 * accounts it reads and what "enough" means. Unset means no probe, and jobs run without the check.
 *
 * Fail closed: a named module that cannot be loaded, and a probe that throws or times out, both read as "not
 * sufficient", so a job that was told to check never spends unchecked. The job parks and asks again later.
 */

export const PROVIDER_BALANCE_PROBE_ENV = "DOCSLURP_PROVIDER_BALANCE_PROBE";
export const PROVIDER_BALANCE_PROBE_API_VERSION = 1;

export interface ProviderBalanceRequest {
  /** Usage-ledger provider label of the route the work will call (as recorded in `usage_events.provider`). */
  provider: string;
  /** Usage-ledger model label of that route. */
  model: string;
  /** What is asking, for the probe's own logs (`summary-tree-backfill`). */
  purpose: string;
  signal?: AbortSignal;
}

export interface ProviderBalanceReading {
  /** False when the account is below the deployment's floor: the caller parks instead of starting more work. */
  sufficient: boolean;
  /** Seconds after which asking again makes sense; the caller's own interval applies when absent. */
  retryAfterSeconds?: number;
}

export interface ProviderBalanceProbe {
  check(request: ProviderBalanceRequest): Promise<ProviderBalanceReading>;
}

export interface ProviderBalanceProbeHost {
  apiVersion: typeof PROVIDER_BALANCE_PROBE_API_VERSION;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ProviderBalanceProbeModule {
  createProviderBalanceProbe(host: ProviderBalanceProbeHost): ProviderBalanceProbe | Promise<ProviderBalanceProbe>;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The module `DOCSLURP_PROVIDER_BALANCE_PROBE` names, as a file URL, or null when unset. */
export function providerBalanceProbeSpecifier(env: Env = process.env): string | null {
  const raw = env[PROVIDER_BALANCE_PROBE_ENV]?.trim() ?? "";
  if (!raw) return null;
  if (raw.startsWith("file:")) return new URL(raw).href;
  if (!path.isAbsolute(raw)) throw new Error(`${PROVIDER_BALANCE_PROBE_ENV} must be an absolute path or a file: URL`);
  return pathToFileURL(raw).href;
}

/** A probe that always reads "not sufficient": what a configured probe that could not be loaded becomes. */
const unavailableProbe: ProviderBalanceProbe = { check: async () => ({ sufficient: false }) };

let installed: ProviderBalanceProbe | null | undefined;
let loading: Promise<ProviderBalanceProbe | null> | null = null;

/** Installs a probe directly (an embedding host, tests). Null removes it. */
export function setProviderBalanceProbe(probe: ProviderBalanceProbe | null | undefined): void {
  installed = probe;
  loading = null;
}

/**
 * The deployment's probe: null when none is configured. Loaded once per process. A configured module that fails to
 * load is logged once and replaced by a probe that never reports a sufficient balance.
 */
export async function providerBalanceProbe(
  env: Env = process.env,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<ProviderBalanceProbe | null> {
  if (installed !== undefined) return installed;
  loading ??= (async () => {
    let specifier: string | null;
    try {
      specifier = providerBalanceProbeSpecifier(env);
      if (!specifier) return null;
      const loaded = await importModule(specifier) as Partial<ProviderBalanceProbeModule>;
      if (typeof loaded.createProviderBalanceProbe !== "function") throw new Error("the module does not export createProviderBalanceProbe");
      const probe = await loaded.createProviderBalanceProbe({ apiVersion: PROVIDER_BALANCE_PROBE_API_VERSION, env });
      if (!probe || typeof probe.check !== "function") throw new Error("createProviderBalanceProbe did not return a probe");
      console.log("[provider-balance] probe loaded");
      return probe;
    } catch (error) {
      console.error(`[provider-balance] ${PROVIDER_BALANCE_PROBE_ENV} could not be loaded; jobs that check it will park: ${error instanceof Error ? error.message.split("\n")[0] : "error"}`);
      return unavailableProbe;
    }
  })();
  installed = await loading;
  return installed;
}

/** One reading, never throwing: a probe that fails or does not answer within `timeoutMs` reads as not sufficient. */
export async function readProviderBalance(probe: ProviderBalanceProbe, request: ProviderBalanceRequest, timeoutMs = 10_000): Promise<ProviderBalanceReading> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reading = await Promise.race([
      probe.check(request),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); }),
    ]);
    if (!reading || typeof reading.sufficient !== "boolean") throw new Error("invalid reading");
    const retry = reading.retryAfterSeconds;
    return { sufficient: reading.sufficient, ...(typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}) };
  } catch (error) {
    // The error's first line only; a probe's message may name an account.
    console.warn(`[provider-balance] probe failed purpose=${request.purpose}: ${error instanceof Error ? error.name : "error"}`);
    return { sufficient: false };
  } finally {
    clearTimeout(timer);
  }
}
