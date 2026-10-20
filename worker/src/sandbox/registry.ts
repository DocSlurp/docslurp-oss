import type { ParserSandboxProvider } from "./types.js";

export const SANDBOX_PROVIDER_IDS = ["bubblewrap", "landlock", "modal", "none"] as const;
export type SandboxProviderId = (typeof SANDBOX_PROVIDER_IDS)[number];

export function resolveSandboxProviderId(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): SandboxProviderId {
  const raw = env.DOCSLURP_PARSER_SANDBOX?.trim().toLowerCase();
  if (!raw) {
    if (platform === "linux" || env.NODE_ENV === "production") return "bubblewrap";
    return "none";
  }
  if (!(SANDBOX_PROVIDER_IDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown DOCSLURP_PARSER_SANDBOX provider '${raw}'; expected one of: ${SANDBOX_PROVIDER_IDS.join(", ")}`,
    );
  }
  return raw as SandboxProviderId;
}

// Literal import specifiers (not a template string) so bundlers and vitest can resolve
// the `.js` -> `.ts` mapping. Add an entry here when a provider lands.
const PROVIDER_LOADERS: Partial<Record<SandboxProviderId, () => Promise<{ default: ParserSandboxProvider }>>> = {
  bubblewrap: () => import("./providers/bubblewrap/index.js"),
  landlock: () => import("./providers/landlock/index.js"),
  modal: () => import("./providers/modal/index.js"),
  none: () => import("./providers/none/index.js"),
};

export async function loadSandboxProvider(id: SandboxProviderId): Promise<ParserSandboxProvider> {
  const load = PROVIDER_LOADERS[id];
  if (!load) throw new Error(`Sandbox provider '${id}' is not available in this build`);
  return (await load()).default;
}
