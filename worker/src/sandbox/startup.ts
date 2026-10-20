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
