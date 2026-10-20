import { assertSandboxPolicy } from "./policy.js";
import { loadSandboxProvider, resolveSandboxProviderId } from "./registry.js";
import { type ParserSandboxProvider, type SandboxIsolation } from "./types.js";

export interface InitializedParserSandbox {
  provider: ParserSandboxProvider;
  config: Record<string, unknown>;
  isolation: SandboxIsolation;
}

/**
 * Resolve, load, probe and policy-check the configured parser sandbox provider.
 * Fails closed: a provider that cannot isolate (or a policy violation) stops startup.
 */
export async function initializeParserSandbox(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<InitializedParserSandbox> {
  const id = resolveSandboxProviderId(env, platform);
  const provider = await loadSandboxProvider(id);
  const config = provider.readConfig(env) as Record<string, unknown>;
  const probe = await provider.probe(config);
  if (!probe.ok) throw new Error(`parser isolation unavailable: ${probe.detail}`);

  const { warnings } = assertSandboxPolicy({ providerId: provider.id, isolation: probe.isolation, env });
  for (const warning of warnings) console.warn(warning);
  const { isolation } = probe;
  console.log(
    `[parser-sandbox] provider=${provider.id} filesystem=${isolation.filesystem} ` +
      `network=${isolation.network} processes=${isolation.processes} location=${isolation.location}`,
  );
  return { provider, config, isolation };
}

let registeredSandbox: InitializedParserSandbox | undefined;
let lazySandbox: Promise<InitializedParserSandbox> | undefined;

/**
 * Register the process's initialized sandbox (the Temporal worker does this at start) so
 * every CommandRunner shares it instead of probing a provider of its own. `undefined`
 * clears it, and any lazily initialized one.
 */
export function setDefaultParserSandbox(sandbox: InitializedParserSandbox | undefined): void {
  registeredSandbox = sandbox;
  lazySandbox = undefined;
}

/** The registered sandbox, if any; never initializes one. */
export function registeredParserSandbox(): InitializedParserSandbox | undefined {
  return registeredSandbox;
}

/**
 * The registered sandbox, or (outside the worker: CLIs, tests) one initialized from the
 * environment on first use. A failed initialization is not cached; the next call retries.
 */
export function defaultParserSandbox(): Promise<InitializedParserSandbox> {
  if (registeredSandbox) return Promise.resolve(registeredSandbox);
  if (!lazySandbox) {
    const initializing = initializeParserSandbox(process.env, process.platform);
    lazySandbox = initializing;
    initializing.catch(() => {
      if (lazySandbox === initializing) lazySandbox = undefined;
    });
  }
  return lazySandbox;
}
