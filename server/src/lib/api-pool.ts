import { hostname } from "node:os";

import postgres from "postgres";
import { instrumentPostgres } from "@docslurp/shared/observability";

import { PoolActivity } from "./pool-activity.js";

export const DEFAULT_DATABASE_POOL_MAX = 20;

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value?.trim() ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

/**
 * Query connections in the API's postgres.js pool (DATABASE_POOL_MAX, default
 * 20). The LISTEN connection and the watchdog/readiness probe connection come
 * on top. Workers connect through the PgBouncer pooler and size their own
 * pools (WORKER_DB_POOL_MAX).
 */
export function resolveDatabasePoolMax(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env.DATABASE_POOL_MAX, DEFAULT_DATABASE_POOL_MAX, 1, 200);
}

/**
 * `application_name` of this process's pool connections, unique per machine
 * and process so the watchdog can ask Postgres (pg_stat_activity) whether this
 * pool's queries are actually running. Postgres truncates at 63 bytes.
 */
export function apiApplicationName(env: NodeJS.ProcessEnv = process.env): string {
  const machine = env.FLY_MACHINE_ID?.trim() || hostname();
  return `docslurp-api:${machine}:${process.pid}`.slice(0, 63);
}

export const numericType = {
  to: 1700,
  from: [1700],
  serialize: (value: unknown) => String(value),
  parse: (value: string): unknown => Number(value),
};

export interface ApiPool {
  sql: ReturnType<typeof createApiSql>;
  activity: PoolActivity;
  applicationName: string;
  max: number;
}

function createApiSql(databaseUrl: string, options: { max: number; applicationName: string; activity: PoolActivity }) {
  return instrumentPostgres(postgres<Record<string, postgres.PostgresType>>(databaseUrl, {
    max: options.max,
    // Pooler-held named statements can retain result types across schema deployments.
    prepare: false,
    types: { numeric: numericType },
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: options.applicationName },
  }), databaseUrl, { onQueryStart: options.activity.start });
}

/** The API's request pool with its activity tracker (see db.ts). */
export function createApiPool(databaseUrl: string, options: { max?: number; applicationName?: string } = {}): ApiPool {
  const activity = new PoolActivity();
  const max = options.max ?? resolveDatabasePoolMax();
  const applicationName = options.applicationName ?? apiApplicationName();
  return { sql: createApiSql(databaseUrl, { max, applicationName, activity }), activity, applicationName, max };
}
