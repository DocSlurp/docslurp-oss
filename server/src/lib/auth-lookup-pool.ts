import postgres from "postgres";
import { instrumentPostgres } from "@docslurp/shared/observability";

import { env } from "../config.js";
import { numericType } from "./api-pool.js";
import { processSingleton } from "./process-singleton.js";

/** The database-side bound on every credential lookup statement (a connection startup parameter). */
export const LOOKUP_STATEMENT_TIMEOUT_MS = 3_000;
/** Connections in the credential-lookup pool per API process (AUTH_LOOKUP_POOL_MAX). */
export const DEFAULT_AUTH_LOOKUP_POOL_MAX = 4;

export function resolveAuthLookupPoolMax(source: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(source.AUTH_LOOKUP_POOL_MAX);
  return source.AUTH_LOOKUP_POOL_MAX?.trim() && Number.isFinite(parsed)
    ? Math.min(32, Math.max(1, Math.trunc(parsed)))
    : DEFAULT_AUTH_LOOKUP_POOL_MAX;
}

/**
 * The credential-lookup pool's connection options. `statement_timeout` and
 * `default_transaction_read_only` are startup parameters, so Postgres bounds
 * and confines every lookup with no per-lookup SET or transaction: a lookup is
 * one round trip. Startup parameters need a direct connection (a transaction-
 * mode pooler rejects or drops them), as the API's LISTEN and session advisory
 * locks already do.
 */
export function authLookupPoolOptions(max: number) {
  return {
    max,
    prepare: false,
    types: { numeric: numericType },
    idle_timeout: 20,
    max_lifetime: 900,
    connect_timeout: 3,
    onnotice: () => {},
    connection: {
      application_name: "docslurp-auth-lookup",
      statement_timeout: LOOKUP_STATEMENT_TIMEOUT_MS,
      default_transaction_read_only: true,
    },
  };
}

export function createAuthLookupSql(databaseUrl: string, max: number) {
  return instrumentPostgres(postgres(databaseUrl, authLookupPoolOptions(max)), databaseUrl);
}

export type AuthLookupSql = ReturnType<typeof createAuthLookupSql>;

/**
 * A small pool of its own for credential lookups (API keys and OAuth tokens on
 * route auth, lib/route-credentials.ts), apart from the request pool and Better
 * Auth's pool: a lookup stall holds at most these connections and never the
 * ones sign-in or requests need. Created on first use; budget it with the
 * others (docs/self-host/configuration.md, DATABASE_POOL_MAX).
 */
const state = processSingleton(`auth-lookup-pool:${env.databaseUrl}`, () => ({
  sql: null as AuthLookupSql | null,
  max: resolveAuthLookupPoolMax(),
}));

export function authLookupSql(): AuthLookupSql {
  return state.sql ??= createAuthLookupSql(env.databaseUrl, state.max);
}

export function authLookupPoolMax(): number {
  return state.max;
}

export async function closeAuthLookupPool(): Promise<void> {
  const sql = state.sql;
  state.sql = null;
  await sql?.end({ timeout: 5 });
}
