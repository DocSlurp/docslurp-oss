import { isDevelopmentEnvironment } from "@docslurp/shared";

/** Every non-development environment requires the audited VM boundary, including the real process floor. */
export function vmOnlyParsing(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isDevelopmentEnvironment(env);
}

/** The service profile runs only with NODE_ENV=production; startup and preflight throw otherwise. */
export function assertServiceProfileRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DOCSLURP_SERVICE_PROFILE?.trim().toLowerCase() === "service" && env.NODE_ENV?.trim().toLowerCase() !== "production") {
    throw new Error(`DOCSLURP_SERVICE_PROFILE=service requires NODE_ENV=production (got ${env.NODE_ENV?.trim() ? `'${env.NODE_ENV.trim()}'` : "unset"}); refusing to start`);
  }
}
