/**
 * Whether this process must parse customer bytes only behind the parser VM boundary: under NODE_ENV=production or the
 * hosted service profile (DOCSLURP_SERVICE_PROFILE=service), read from the given environment or the process's own. Every
 * VM-only gate keys on this, so a service deployment that forgot NODE_ENV never falls back to in-process parsing (council
 * G L3); `assertServiceProfileRuntime` also refuses to start one.
 */
export function vmOnlyParsing(env: NodeJS.ProcessEnv = process.env): boolean {
  return [env, process.env].some((source) =>
    source.NODE_ENV?.trim().toLowerCase() === "production" || source.DOCSLURP_SERVICE_PROFILE?.trim().toLowerCase() === "service");
}

/** The service profile runs only with NODE_ENV=production; startup and preflight throw otherwise. */
export function assertServiceProfileRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DOCSLURP_SERVICE_PROFILE?.trim().toLowerCase() === "service" && env.NODE_ENV?.trim().toLowerCase() !== "production") {
    throw new Error(`DOCSLURP_SERVICE_PROFILE=service requires NODE_ENV=production (got ${env.NODE_ENV?.trim() ? `'${env.NODE_ENV.trim()}'` : "unset"}); refusing to start`);
  }
}
