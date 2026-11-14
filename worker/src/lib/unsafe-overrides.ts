import { isDevelopmentEnvironment, normalizeEnvSetting } from "@docslurp/shared";

import { vmOnlyParsing } from "./vm-only-parsing.js";

/**
 * Settings that run untrusted-file processing with weaker protection than the default. Each exists for local
 * development and tests only (#398):
 *
 * - DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: provider `none` runs parsers without a PID namespace.
 * - DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS: socket-denied commands run on a provider that cannot filter UNIX sockets.
 * - QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING: a missing quarantine inspection tool accepts the file instead of blocking it.
 * - DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB: a stale or missing ClamAV signature database only warns.
 *
 * These four are fail-open flags: anything but an explicit off value counts as set. Two more settings weaken protection
 * through their value rather than an on/off flag:
 *
 * - QUARANTINE_ENABLED: an explicit off value (or anything that is not an on value) parses files unscanned.
 * - DOCSLURP_PARSER_SANDBOX=none: parsers run on the host with no filesystem or network isolation.
 *
 * Outside a development environment (`isDevelopmentEnvironment` in @docslurp/shared: NODE_ENV development, test or unset
 * after trimming ASCII whitespace, never a service profile, and never where parsing is VM-only) the worker refuses to
 * start with any of them set. It never ignores one silently. `scripts/start-worker.sh` applies the same rule before the
 * worker starts (a parity test keeps the two in step).
 */
export const UNSAFE_OVERRIDES = [
  "DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED",
  "DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS",
  "QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING",
  "DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB",
] as const;

/** A fail-open flag: on values weaken protection. */
export type UnsafeOverride = (typeof UNSAFE_OVERRIDES)[number];

/** Settings whose value weakens protection: quarantine turned off, or the unisolated `none` parser sandbox. */
export const UNSAFE_VALUE_SETTINGS = ["QUARANTINE_ENABLED", "DOCSLURP_PARSER_SANDBOX"] as const;

/** Every development-only setting the startup check refuses outside development. */
export const UNSAFE_SETTINGS = [...UNSAFE_OVERRIDES, ...UNSAFE_VALUE_SETTINGS] as const;
export type UnsafeSetting = (typeof UNSAFE_SETTINGS)[number];

const ON_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

/** Whether a normalized value of the setting weakens protection. */
const UNSAFE_WHEN: Record<UnsafeSetting, (value: string) => boolean> = {
  DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: (value) => !OFF_VALUES.has(value),
  DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS: (value) => !OFF_VALUES.has(value),
  QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING: (value) => !OFF_VALUES.has(value),
  DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB: (value) => !OFF_VALUES.has(value),
  // Inverted: unset or an on value keeps quarantine; anything else (off values, typos) is refused, loudly.
  QUARANTINE_ENABLED: (value) => value !== "" && !ON_VALUES.has(value),
  DOCSLURP_PARSER_SANDBOX: (value) => value === "none",
};

function refusalMessage(names: readonly string[], nodeEnv: string): string {
  const plural = names.length > 1;
  return (
    `${names.join(", ")} ${plural ? "weaken" : "weakens"} untrusted-file protection as set and ${plural ? "are" : "is"} allowed ` +
    "only in development or test (NODE_ENV development, test or unset, without the service profile); " +
    `got NODE_ENV=${nodeEnv ? JSON.stringify(nodeEnv) : "unset"}. Unset ${plural ? "them" : "it"}; refusing to start`
  );
}

export class UnsafeOverrideError extends Error {
  readonly names: readonly UnsafeSetting[];

  constructor(names: readonly UnsafeSetting[], nodeEnv: string) {
    super(refusalMessage(names, nodeEnv));
    this.name = "UnsafeOverrideError";
    this.names = names;
  }
}

/** Whether this environment may use the development-only settings: NODE_ENV development, test or unset, never the service profile or VM-only parsing. */
export function unsafeOverridesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (vmOnlyParsing(env)) return false;
  return isDevelopmentEnvironment(env);
}

/** The settings set to a value that weakens protection (so a typo counts as set, and is refused outside development). */
export function requestedUnsafeOverrides(env: NodeJS.ProcessEnv = process.env): UnsafeSetting[] {
  return UNSAFE_SETTINGS.filter((name) => UNSAFE_WHEN[name](normalizeEnvSetting(env[name])));
}

/**
 * Whether the fail-open flag is in effect: set to an on value in an environment that allows it. Every reader goes through
 * this, so even a code path that skipped the startup check never weakens protection outside development.
 * `fallback` applies when the variable is unset or empty, and only where overrides are allowed.
 */
export function unsafeOverrideEnabled(name: UnsafeOverride, env: NodeJS.ProcessEnv = process.env, fallback = false): boolean {
  if (!unsafeOverridesAllowed(env)) return false;
  const value = normalizeEnvSetting(env[name]);
  if (value === "") return fallback;
  return ON_VALUES.has(value);
}

/** Startup check: throws `UnsafeOverrideError` naming every development-only setting set where it is not allowed. */
export function assertNoUnsafeOverrides(env: NodeJS.ProcessEnv = process.env): void {
  if (unsafeOverridesAllowed(env)) return;
  const requested = requestedUnsafeOverrides(env);
  if (requested.length === 0) return;
  const nodeEnv = env.NODE_ENV ?? process.env.NODE_ENV ?? "";
  console.error(`[worker-start] status=refused reason=unsafe-override names=${requested.join(",")} node_env=${nodeEnv ? JSON.stringify(nodeEnv) : "unset"}`);
  throw new UnsafeOverrideError(requested, nodeEnv);
}
