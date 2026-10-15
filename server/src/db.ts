import postgres from "postgres";

import { env } from "./config.js";
import { processSingleton } from "./lib/process-singleton.js";

function createSql(databaseUrl: string) {
  return postgres<Record<string, postgres.PostgresType>>(databaseUrl, {
    max: 10,
    // Pooler-held named statements can retain result types across schema deployments.
    prepare: false,
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
    idle_timeout: 20,
    connect_timeout: 10
  });
}

/**
 * The API's one postgres.js pool: at most `max` query connections plus one
 * LISTEN connection per process. In dev it is cached across Vite SSR module
 * reloads (see process-singleton.ts); a fresh pool per reload leaked ~10
 * connections each time and exhausted Postgres during long `astro dev` sessions.
 */
export const sql = processSingleton(`api-sql:${env.databaseUrl}`, () => createSql(env.databaseUrl));

export type SqlClient = typeof sql;
