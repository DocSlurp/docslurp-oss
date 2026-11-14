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
 * Outside a development environment (NODE_ENV development, test or unset, and not the hosted service profile) the
 * worker refuses to start when any of them is set to anything but an explicit off value. It never ignores one silently.
 * `scripts/start-worker.sh` applies the same rule to DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB before the worker starts.
 */
export const UNSAFE_OVERRIDES = [
  "DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED",
  "DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS",
  "QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING",
  "DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB",
] as const;

export type UnsafeOverride = (typeof UNSAFE_OVERRIDES)[number];

const DEVELOPMENT_ENVIRONMENTS = new Set(["", "development", "test"]);
const ON_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

function refusalMessage(names: readonly string[], nodeEnv: string): string {
  const plural = names.length > 1;
  return (
    `${names.join(", ")} ${plural ? "weaken" : "weakens"} untrusted-file protection and ${plural ? "are" : "is"} allowed ` +
    "only in development or test (NODE_ENV development, test or unset, without the service profile); " +
    `got NODE_ENV=${nodeEnv || "unset"}. Unset ${plural ? "them" : "it"}; refusing to start`
  );
}

export class UnsafeOverrideError extends Error {
  readonly names: readonly UnsafeOverride[];

  constructor(names: readonly UnsafeOverride[], nodeEnv: string) {
    super(refusalMessage(names, nodeEnv));
    this.name = "UnsafeOverrideError";
    this.names = names;
  }
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/** Whether this environment may use the development-only overrides: NODE_ENV development, test or unset, never the service profile. */
export function unsafeOverridesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (vmOnlyParsing(env)) return false;
  return [env, process.env].every((source) => DEVELOPMENT_ENVIRONMENTS.has(normalized(source.NODE_ENV)));
}

/** The overrides set to anything other than an explicit off value (so a typo counts as set, and is refused in production). */
export function requestedUnsafeOverrides(env: NodeJS.ProcessEnv = process.env): UnsafeOverride[] {
  return UNSAFE_OVERRIDES.filter((name) => !OFF_VALUES.has(normalized(env[name])));
}

/**
 * Whether the override is in effect: set to an on value in an environment that allows it. Every reader goes through
 * this, so even a code path that skipped the startup check never weakens protection outside development.
 * `fallback` applies when the variable is unset or empty, and only where overrides are allowed.
 */
export function unsafeOverrideEnabled(name: UnsafeOverride, env: NodeJS.ProcessEnv = process.env, fallback = false): boolean {
  if (!unsafeOverridesAllowed(env)) return false;
  const value = normalized(env[name]);
  if (value === "") return fallback;
  return ON_VALUES.has(value);
}

/** Startup check: throws `UnsafeOverrideError` naming every override set where it is not allowed. */
export function assertNoUnsafeOverrides(env: NodeJS.ProcessEnv = process.env): void {
  if (unsafeOverridesAllowed(env)) return;
  const requested = requestedUnsafeOverrides(env);
  if (requested.length === 0) return;
  const nodeEnv = (env.NODE_ENV ?? process.env.NODE_ENV ?? "").trim();
  console.error(`[worker-start] status=refused reason=unsafe-override names=${requested.join(",")} node_env=${nodeEnv || "unset"}`);
  throw new UnsafeOverrideError(requested, nodeEnv);
}
