import { env } from "./config.js";
import { createApiPool } from "./lib/api-pool.js";
import { processSingleton } from "./lib/process-singleton.js";

/**
 * The API's request pool: at most DATABASE_POOL_MAX (default 20) query
 * connections plus one LISTEN connection per process. Route-auth credential
 * lookups use their own small pool (lib/auth-lookup-pool.ts, AUTH_LOOKUP_POOL_MAX,
 * default 4); budget both (docs/self-host/configuration.md). Health probes do not use
 * it (services/db-probe.ts), so a saturated pool cannot fail them. In dev it is
 * cached across Vite SSR module reloads (see process-singleton.ts); a fresh pool
 * per reload leaked its connections each time and exhausted Postgres during
 * long `astro dev` sessions.
 */
export const apiPool = processSingleton(`api-pool:${env.databaseUrl}`, () => createApiPool(env.databaseUrl));

export const sql = apiPool.sql;

export type SqlClient = typeof sql;
