/**
 * Process-wide state that survives Vite SSR module re-evaluation.
 *
 * `astro dev` re-evaluates a server module (and every module that imports it)
 * when its source changes. Module-level resources then get created again while
 * the previous instance stays alive: a `postgres()` pool keeps its connections,
 * a `setInterval` keeps querying through the old pool and a LISTEN connection
 * never idles out. Over a long dev session that exhausted Postgres
 * `max_connections`. Production evaluates each module once, so these helpers
 * are no-ops there in practice.
 */

const REGISTRY = Symbol.for("docslurp.processSingletons");
const TASKS = Symbol.for("docslurp.processTasks");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY]?: Map<string, unknown>;
  [TASKS]?: Map<string, () => void | Promise<void>>;
};

const globalState = globalThis as GlobalWithRegistry;

/**
 * True when module-level resources should be reused across module reloads:
 * every non-production process except Vitest, whose tests reset modules and
 * end their own clients on purpose.
 */
export function reusesAcrossModuleReloads(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && !env.VITEST;
}

/**
 * Returns the resource cached under `key`, creating it on first use. Outside
 * `reusesAcrossModuleReloads()` it always creates a fresh one.
 */
export function processSingleton<T>(key: string, create: () => T, env: NodeJS.ProcessEnv = process.env): T {
  if (!reusesAcrossModuleReloads(env)) return create();
  const registry = (globalState[REGISTRY] ??= new Map());
  if (registry.has(key)) return registry.get(key) as T;
  const value = create();
  registry.set(key, value);
  return value;
}

/**
 * Registers how to stop a running background task (timers, LISTEN
 * subscriptions). Returns the stop function registered under `key` by an
 * earlier instance of the module, which the caller must await before starting
 * its own, so a reload replaces the task instead of duplicating it.
 */
export function replaceProcessTask(
  key: string,
  stop: () => void | Promise<void>,
): (() => void | Promise<void>) | undefined {
  const tasks = (globalState[TASKS] ??= new Map());
  const previous = tasks.get(key);
  tasks.set(key, stop);
  return previous === stop ? undefined : previous;
}
