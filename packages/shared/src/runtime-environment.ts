/**
 * The one rule for "is this a development environment?" (#398), shared by the worker, the API and
 * `scripts/start-worker.sh` (which implements the same rule in bash; a parity test keeps them in step).
 *
 * A value is normalized by trimming ASCII whitespace (space, tab, LF, VT, FF, CR) from both ends and lower-casing
 * ASCII letters only. Nothing else is folded: JavaScript's `trim()` also strips Unicode spaces such as U+00A0 and
 * U+FEFF, which a shell does not, so the two layers would disagree about the same value. After normalizing, NODE_ENV
 * `development`, `test` or empty is development; any other value (a typo, `staging`, `preview`, a value padded with a
 * Unicode space) is not. A service profile (any DOCSLURP_PROFILE or DOCSLURP_SERVICE_PROFILE containing `service`) is
 * never development (the retired DOCSLURP_SERVICE_PROFILE is still read here, and only here outside retired-env.ts, so a stale
 * value can only make the floor stricter; startup refuses it anyway). No profile lowers this floor: `DOCSLURP_PROFILE=dev` or `selfhost` never makes a non-development
 * NODE_ENV development (deployment-profile.ts refuses `dev` outside development at startup).
 */
const ASCII_EDGE_WHITESPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const DEVELOPMENT_NODE_ENVS = new Set(["", "development", "test"]);

/** Trim ASCII whitespace from both ends and lower-case ASCII letters; everything else is kept as is. */
export function normalizeEnvSetting(value: string | undefined | null): string {
  return (value ?? "").replace(ASCII_EDGE_WHITESPACE, "").replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Whether one environment source is development under the rule above. */
export function isDevelopmentEnvSource(source: Record<string, string | undefined>): boolean {
  return DEVELOPMENT_NODE_ENVS.has(normalizeEnvSetting(source.NODE_ENV))
    && !normalizeEnvSetting(source.DOCSLURP_SERVICE_PROFILE).includes("service")
    && !normalizeEnvSetting(source.DOCSLURP_PROFILE).includes("service");
}

/**
 * Whether development-only behaviour (fail-open settings, disabling quarantine, the unisolated `none` parser sandbox)
 * may apply: both the given environment and the process's own must be development, so a test or caller passing a
 * development env inside a production process never weakens it.
 */
export function isDevelopmentEnvironment(env: Record<string, string | undefined> = processEnv()): boolean {
  return isDevelopmentEnvSource(env) && isDevelopmentEnvSource(processEnv());
}

function processEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}
