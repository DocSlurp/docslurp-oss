import { assertServiceProfileRuntime } from "../lib/vm-only-parsing.js";
import { assertSandboxPolicy } from "./policy.js";
import { loadSandboxProvider, resolveSandboxProviderId } from "./registry.js";
import { type ParserSandboxProvider, type SandboxIsolation } from "./types.js";

export interface InitializedParserSandbox {
  provider: ParserSandboxProvider;
  config: Record<string, unknown>;
  isolation: SandboxIsolation;
  /** The VM image's tools (SandboxProbeResult.tools), when the provider reports them. */
  tools?: readonly string[];
  /** The VM image's guest capabilities (SandboxProbeResult.capabilities). */
  capabilities?: readonly string[];
}

/**
 * Resolve, load, probe and policy-check the configured parser sandbox provider.
 * Fails closed: a provider that cannot isolate (or a policy violation) stops startup.
 */
export async function initializeParserSandbox(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<InitializedParserSandbox> {
  assertServiceProfileRuntime(env);
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
  return { provider, config, isolation, ...(probe.tools ? { tools: probe.tools } : {}), ...(probe.capabilities ? { capabilities: probe.capabilities } : {}) };
}

let registeredSandbox: InitializedParserSandbox | undefined;
let lazySandbox: Promise<InitializedParserSandbox> | undefined;
/** The lazily initialized sandbox once it has resolved (CLIs and scripts that never register one). */
let lazyResolved: InitializedParserSandbox | undefined;

/**
 * Register the process's initialized sandbox (the Temporal worker does this at start) so
 * every CommandRunner shares it instead of probing a provider of its own. `undefined`
 * clears it, and any lazily initialized one.
 */
export function setDefaultParserSandbox(sandbox: InitializedParserSandbox | undefined): void {
  registeredSandbox = sandbox;
  lazySandbox = undefined;
  lazyResolved = undefined;
}

/**
 * Whether the parser image runs guest code with `capability`. A remote image (guest scripts shipped in the image, not
 * this worker) must report it in its contract; one that does not, an older image or one that reports none, lacks it.
 * A local sandbox runs this checkout's own guest scripts, so it has every capability this code knows. With no sandbox
 * known (none registered and no lazily initialized one resolved yet), nothing is assumed: false, fail closed (council
 * #387 r2 L1: a script running the pipeline on a remote provider must not skip the check).
 */
export function parserImageHasCapability(capability: string, ...given: [InitializedParserSandbox | undefined] | []): boolean {
  return parserImageCapability(capability, ...given) === "present";
}

/**
 * Why a capability is or is not available: `present`; `missing` (a remote image that does not report it); or
 * `sandbox-not-ready` (no sandbox registered or initialized yet, so nothing is known and nothing is assumed).
 */
export function parserImageCapability(capability: string, ...given: [InitializedParserSandbox | undefined] | []): "present" | "missing" | "sandbox-not-ready" {
  const sandbox = given.length ? given[0] : (registeredSandbox ?? lazyResolved);
  if (!sandbox) return "sandbox-not-ready";
  if (sandbox.isolation.location !== "remote") return "present";
  return sandbox.capabilities?.includes(capability) === true ? "present" : "missing";
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
    initializing.then((sandbox) => { if (lazySandbox === initializing) lazyResolved = sandbox; }, () => {
      if (lazySandbox === initializing) lazySandbox = undefined;
    });
  }
  return lazySandbox;
}
