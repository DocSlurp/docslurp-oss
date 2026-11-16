/**
 * Retired environment variables (tombstones; design extraction-config-simplification.md, release R1).
 *
 * A retired variable is refused at startup for as long as this list exists, even after every reader of it is gone: a
 * deployment that still sets one would otherwise run with a setting it believes is in force and is not (fail open).
 * Entries are never removed. `retired-env.test.ts` fails when code outside this module (and the isolation-floor
 * classifiers, which only ever read them to be stricter) reads a retired name.
 *
 * Release R0 accepted every name here beside its replacement; roll back from R1 only to R0 (docs/releases.md).
 */

type Env = Readonly<Record<string, string | undefined>>;

export type RetiredEnvVar = Readonly<{ name: string; replacement: string }>;

export const RETIRED_ENV_VARS: readonly RetiredEnvVar[] = Object.freeze([
  { name: "DOCSLURP_SERVICE_PROFILE", replacement: "DOCSLURP_PROFILE (service = service, self-hosted = selfhost)" },
]);

/** Retired variables set (non-empty after trimming) in `env`, in list order. */
export function retiredEnvVarsSet(env: Env): RetiredEnvVar[] {
  return RETIRED_ENV_VARS.filter((entry) => (env[entry.name] ?? "").trim() !== "");
}

/** The startup refusal for `env`, or null when no retired variable is set. */
export function retiredEnvRefusal(env: Env): string | null {
  const found = retiredEnvVarsSet(env);
  if (found.length === 0) return null;
  return `retired environment variable(s) set: ${found.map((entry) => `${entry.name} (use ${entry.replacement})`).join("; ")}; unset them; refusing to start`;
}
