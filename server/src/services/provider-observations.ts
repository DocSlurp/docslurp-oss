import { emitTelemetryLog } from "@docslurp/shared/observability";
import { tierOptionModels, type EndpointObservation } from "@docslurp/shared";
import { sql as defaultSql } from "../db.js";

/**
 * Live provider observations for route tiers (migration 0140): the API's maintenance sweep polls OpenRouter's public
 * endpoint listings for every model a tier option can route to, and tier selection reads `provider_endpoint_current`.
 * Off unless DOCSLURP_PROVIDER_OBSERVATIONS=1. The listing is public and unauthenticated: no key is sent.
 */

type Sql = typeof defaultSql;
const OPENROUTER = "https://openrouter.ai/api/v1";
/** How often the fleet polls (one instance per window, under an advisory lock). */
export const OBSERVATION_POLL_INTERVAL_MS = 15 * 60_000;
/** Rows older than this are deleted by the sweep. */
export const OBSERVATION_RETENTION_DAYS = 30;
/** Largest listing read for one model. */
const MAX_LISTING_BYTES = 1024 * 1024;
const LOCK_KEY = "docslurp.provider-observations.poll";

export function providerObservationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DOCSLURP_PROVIDER_OBSERVATIONS?.trim() === "1";
}

/** USD per token (OpenRouter's unit) to USD per million tokens; null for anything that is not a finite, non-negative price. */
function perMillion(value: unknown): number | null {
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1e6 * 1e9) / 1e9 : null;
}

const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown, max = 200): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

export interface ListedEndpointRow {
  model: string;
  endpoint: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  overrides: unknown;
  quantization: string | null;
  status: number | null;
  uptime30m: number | null;
}

/** Rows for one model from an OpenRouter `/models/{id}/endpoints` payload; malformed entries are skipped. */
export function parseEndpointListing(model: string, payload: unknown): ListedEndpointRow[] {
  const endpoints = (payload as { data?: { endpoints?: unknown } } | null)?.data?.endpoints;
  if (!Array.isArray(endpoints)) return [];
  const rows: ListedEndpointRow[] = [];
  for (const raw of endpoints.slice(0, 200)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const endpoint = text(entry.tag) ?? text(entry.provider_name);
    if (!endpoint) continue;
    const pricing = (entry.pricing && typeof entry.pricing === "object" ? entry.pricing : {}) as Record<string, unknown>;
    const uptime = finiteOrNull(entry.uptime_last_30m);
    rows.push({
      model, endpoint,
      input: perMillion(pricing.prompt), output: perMillion(pricing.completion), cacheRead: perMillion(pricing.input_cache_read),
      overrides: Array.isArray(pricing.overrides) ? pricing.overrides : null,
      quantization: text(entry.quantization, 40),
      status: finiteOrNull(entry.status),
      uptime30m: uptime !== null && uptime >= 0 && uptime <= 100 ? uptime : null,
    });
  }
  return rows;
}

async function fetchListing(model: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(`${OPENROUTER}/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_LISTING_BYTES) throw new Error("listing too large");
  return JSON.parse(body);
}

/**
 * Poll every tier model once and insert one row per listed endpoint. Returns the rows written, or null when another
 * instance holds the poll lock or polled within the interval.
 */
export async function pollProviderObservations(options: { sql?: Sql; fetchImpl?: typeof fetch; models?: readonly string[] } = {}): Promise<number | null> {
  const sql = options.sql ?? defaultSql;
  const fetchImpl = options.fetchImpl ?? fetch;
  const models = options.models ?? tierOptionModels();
  return sql.begin(async (tx) => {
    const [{ locked }] = await tx`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as locked`;
    if (!locked) return null;
    const [{ recent }] = await tx`
      select exists (select 1 from provider_endpoint_observations where source = 'openrouter-endpoints'
        and observed_at > now() - make_interval(secs => ${OBSERVATION_POLL_INTERVAL_MS / 1000 - 30})) as recent`;
    if (recent) return null;
    let written = 0;
    for (const model of models) {
      let rows: ListedEndpointRow[];
      try {
        rows = parseEndpointListing(model, await fetchListing(model, fetchImpl));
      } catch (error) {
        emitTelemetryLog({ severityText: "warn", body: "provider observation poll failed", eventName: "docslurp.provider_observations.poll_failed", attributes: { model, error: error instanceof Error ? error.message : String(error) } });
        continue;
      }
      for (const row of rows) {
        await tx`insert into provider_endpoint_observations
          (source, model, endpoint, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, price_overrides, quantization, status, uptime_30m)
          values ('openrouter-endpoints', ${row.model}, ${row.endpoint}, ${row.input}, ${row.output}, ${row.cacheRead},
            ${row.overrides === null ? null : tx.json(row.overrides as never)}, ${row.quantization}, ${row.status}, ${row.uptime30m})`;
        written += 1;
      }
    }
    await tx`delete from provider_endpoint_observations where observed_at < now() - make_interval(days => ${OBSERVATION_RETENTION_DAYS})`;
    return written;
  });
}

/**
 * Record one served request's latency (time to first token) and generation time on the host that served it, from
 * OpenRouter's generation receipt. Best effort: a failure is logged, never thrown into the caller's request.
 */
export async function recordServedLatency(row: { model: string; endpoint: string; latencyMs: number | null; generationMs: number | null }, sql: Sql = defaultSql): Promise<void> {
  const latency = row.latencyMs !== null && Number.isFinite(row.latencyMs) && row.latencyMs >= 0 ? Math.round(row.latencyMs) : null;
  const generation = row.generationMs !== null && Number.isFinite(row.generationMs) && row.generationMs >= 0 ? Math.round(row.generationMs) : null;
  if (latency === null && generation === null) return;
  if (!text(row.model) || !text(row.endpoint)) return;
  try {
    await sql`insert into provider_endpoint_observations (source, model, endpoint, latency_ms, generation_ms)
      values ('traffic', ${row.model}, ${row.endpoint}, ${latency}, ${generation})`;
  } catch (error) {
    emitTelemetryLog({ severityText: "warn", body: "provider latency record failed", eventName: "docslurp.provider_observations.record_failed", attributes: { model: row.model, error: error instanceof Error ? error.message : String(error) } });
  }
}

/** Current observations of `models` for tier selection. */
export async function readProviderObservations(models: readonly string[], sql: Sql = defaultSql): Promise<EndpointObservation[]> {
  if (models.length === 0) return [];
  const rows = await sql<{ model: string; endpoint: string; observed_at: Date; input_usd_per_mtok: string | null; output_usd_per_mtok: string | null; status: number | null; uptime_30m: string | null; latency_p50_ms: number | null }[]>`
    select model, endpoint, observed_at, input_usd_per_mtok, output_usd_per_mtok, status, uptime_30m, latency_p50_ms
    from provider_endpoint_current where model = any(${models as string[]})`;
  const num = (value: string | number | null) => (value === null ? null : Number(value));
  return rows.map((row) => ({
    model: row.model, endpoint: row.endpoint, observedAt: new Date(row.observed_at),
    inputUsdPerMTok: num(row.input_usd_per_mtok), outputUsdPerMTok: num(row.output_usd_per_mtok),
    status: row.status, uptime30m: num(row.uptime_30m), latencyP50Ms: num(row.latency_p50_ms),
  }));
}

let lastPollAt = 0;

/** Maintenance-sweep entry: at most one poll per interval per process; the fleet shares the advisory lock. */
export async function sweepProviderObservations(now = Date.now()): Promise<void> {
  if (!providerObservationsEnabled()) return;
  if (now - lastPollAt < OBSERVATION_POLL_INTERVAL_MS) return;
  lastPollAt = now;
  const written = await pollProviderObservations();
  if (written !== null) emitTelemetryLog({ severityText: "info", body: "provider observations polled", eventName: "docslurp.provider_observations.polled", attributes: { rows: written } });
}
