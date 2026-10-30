import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";

import { env } from "../config.js";
import { sql } from "../db.js";
import { getRequestId } from "../lib/request-context.js";
import { sweepStaleQueuedRuns } from "../services/stale-queued-runs.js";
import { spendByProviderModel } from "../services/usage-attribution.js";
import { httpResponseStats } from "../lib/http-response-stats.js";
import { currentAlertEvaluator } from "../services/alerts/alert-evaluator.js";
import {
  formatWorkerScalerMetricLines,
  queryWorkerScalerSnapshot,
  resolveWorkerScalerConfig,
  resolveWorkerScalerQueryParams,
  type WorkerScalerSnapshot,
} from "../lib/worker-autoscale.js";

type RunMetricRow = {
  status: string;
  count: number;
};

type StageMetricRow = {
  stage_name: string;
  p50_seconds: number | null;
  p95_seconds: number | null;
};

type CostMetricRow = {
  provider: string;
  model: string;
  total_cost_cents: number;
};

type QueueMetricRow = WorkerScalerSnapshot;

type QueueMetrics = QueueMetricRow;

const SCALER = resolveWorkerScalerConfig();
const SCALER_QUERY = resolveWorkerScalerQueryParams();
// fly-autoscaler polls every ~15 s; one cached answer per window keeps 125+
// scaler scrapes and dashboards from re-running the demand query.
const SCALER_CACHE_MS = Math.max(0, Number.parseInt(process.env.DOCSLURP_SCALER_CACHE_MS ?? "10000", 10) || 0);

function metricLine(name: string, value: number, labels?: Record<string, string>): string {
  const suffix = labels && Object.keys(labels).length > 0
    ? `{${Object.entries(labels)
        .map(([key, rawValue]) => `${key}="${rawValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
        .join(",")}}`
    : "";
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

function authorizedMetricsRequest(authorization: string | undefined): boolean {
  if (!env.metricsSecret) {
    return false;
  }

  const expected = `Bearer ${env.metricsSecret}`;
  const actualBuffer = Buffer.from(authorization ?? "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * True when the request came through Fly's public edge. The proxy stamps every
 * forwarded request with Fly-Client-IP; Fly health checks and the managed
 * Prometheus scraper reach the machine over the private network and carry
 * none. Only meaningful on Fly (FLY_APP_NAME), so self-hosted setups behind
 * their own proxy keep their existing behaviour.
 */
export function arrivedThroughPublicEdge(header: (name: string) => string | undefined): boolean {
  return Boolean(process.env.FLY_APP_NAME) && Boolean(header("fly-client-ip")?.trim());
}

function appendQueueMetricLines(lines: string[], queue: QueueMetrics): void {
  lines.push(...formatWorkerScalerMetricLines(queue, SCALER, SCALER_QUERY));
}

function isTransientDatabaseConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const errno = (error as { errno?: unknown }).errno;
  return code === "CONNECTION_CLOSED" || errno === "CONNECTION_CLOSED";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildPrometheusPayload(): Promise<string> {
  const [runsByStatus, queueRows, stageRows, costRows] = await Promise.all([
    sql<RunMetricRow[]>`
      select status, count(*)::int as count
      from workspace_runs
      group by status
      order by status
    `,
    sql<QueueMetricRow[]>`
      select
        count(*) filter (
          where status = 'queued'
            and coalesce(control_state, '') not in ('paused', 'cancelled')
        )::int as queue_depth,
        coalesce(sum(total_documents) filter (
          where status = 'queued'
            and coalesce(control_state, '') not in ('paused', 'cancelled')
        ), 0)::int as queued_documents,
        coalesce(sum(pages_total) filter (
          where status = 'queued'
            and coalesce(control_state, '') not in ('paused', 'cancelled')
        ), 0)::int as queued_pages,
        (select count(*)::int from page_work_tasks p join workspace_runs r on r.id=p.run_id
          where p.status in ('queued','processing') and r.status='processing'
          and coalesce(r.control_state,'') not in ('paused','cancel_requested','cancelled')) as pending_page_tasks,
        (select coalesce(json_agg(d), '[]'::json) from (
          select org_key, max(slots)::int as slots, sum(greatest(1, least(fanout_cap, page_demand)))::int as demand
          from (
            select coalesce(r.org_id, 'workspace:' || r.workspace_id) as org_key,
              coalesce(o.worker_slots, ${SCALER_QUERY.defaultOrgSlots}) as slots,
              least(${SCALER_QUERY.pageFanout}, coalesce(o.worker_slots, ${SCALER_QUERY.defaultOrgSlots}), 128) as fanout_cap,
              greatest(
                (select count(*) from page_work_tasks p where p.run_id = r.id and p.status in ('queued','processing')),
                case when coalesce((r.pipeline->>'visionFallback')::boolean,false)
                  and coalesce((r.pipeline->>'maxCostCents')::numeric,0)=0
                  and not exists(select 1 from workspace_run_stage_states s where s.run_id=r.id and s.stage_name='vision-extract' and s.status='completed')
                then r.pages_total else 0 end
              ) as page_demand
            from workspace_runs r
            left join organizations o on o.id = r.org_id
            where (r.status = 'queued' and coalesce(r.control_state,'') not in ('paused','cancelled'))
              or (r.status = 'processing' and coalesce(r.control_state,'') not in ('paused','cancel_requested','cancelled')
                and coalesce(r.lease_expires_at, now()) >= now())
          ) runs
          group by org_key
        ) d) as org_demand,
        count(*) filter (
          where status = 'processing'
        )::int as processing_runs,
        coalesce(sum(total_documents) filter (
          where status = 'processing'
            and coalesce(control_state, '') not in ('paused', 'cancel_requested', 'cancelled')
            and coalesce(lease_expires_at, now()) >= now()
        ), 0)::int as processing_documents,
        coalesce(sum(pages_total) filter (
          where status = 'processing'
            and coalesce(control_state, '') not in ('paused', 'cancel_requested', 'cancelled')
            and coalesce(lease_expires_at, now()) >= now()
        ), 0)::int as processing_pages,
        count(*) filter (
          where status = 'processing'
            and coalesce(lease_expires_at, to_timestamp(0)) < now()
        )::int as stale_leases,
        count(*) filter (
          where status = 'processing'
            and coalesce(control_state, '') not in ('paused', 'cancel_requested', 'cancelled')
            and coalesce(lease_expires_at, now()) >= now()
        )::int as worker_active,
        coalesce(sum(pages_processed), 0)::int as pages_processed_total,
        extract(epoch from (
          now() - min(created_at) filter (
            where status = 'queued'
              and coalesce(control_state, '') not in ('paused', 'cancelled')
          )
        )) as oldest_queued_run_age_seconds,
        extract(epoch from min(created_at) filter (
          where status = 'queued'
            and coalesce(control_state, '') not in ('paused', 'cancelled')
        )) as oldest_queued_run_created_at_seconds
      from workspace_runs
    `,
    sql<StageMetricRow[]>`
      select
        stage_name,
        percentile_cont(0.5) within group (order by value / 1000.0) as p50_seconds,
        percentile_cont(0.95) within group (order by value / 1000.0) as p95_seconds
      from performance_log
      where metric = 'stage-duration' and unit = 'ms'
      group by stage_name
      order by stage_name
    `,
    spendByProviderModel() as Promise<CostMetricRow[]>
  ]);

  const queue = queueRows[0] ?? {
    queue_depth: 0,
    queued_documents: 0,
    queued_pages: 0,
    processing_runs: 0,
    processing_documents: 0,
    processing_pages: 0,
    stale_leases: 0,
    worker_active: 0,
    pages_processed_total: 0,
    oldest_queued_run_age_seconds: null,
    oldest_queued_run_created_at_seconds: null
  };

  const lines = [
    "# HELP docslurp_runs_total Total runs by status.",
    "# TYPE docslurp_runs_total gauge",
    ...(runsByStatus ?? []).map((row) => metricLine("docslurp_runs_total", Number(row.count ?? 0), { status: row.status })),
    "# HELP docslurp_pages_processed_total Total processed pages across all runs.",
    "# TYPE docslurp_pages_processed_total counter",
    metricLine("docslurp_pages_processed_total", Number(queue.pages_processed_total ?? 0)),
    "# HELP docslurp_stage_duration_seconds_p50 P50 stage duration in seconds.",
    "# TYPE docslurp_stage_duration_seconds_p50 gauge",
    ...(stageRows ?? []).map((row) =>
      metricLine("docslurp_stage_duration_seconds_p50", Number(row.p50_seconds ?? 0), { stage: row.stage_name })
    ),
    "# HELP docslurp_stage_duration_seconds_p95 P95 stage duration in seconds.",
    "# TYPE docslurp_stage_duration_seconds_p95 gauge",
    ...(stageRows ?? []).map((row) =>
      metricLine("docslurp_stage_duration_seconds_p95", Number(row.p95_seconds ?? 0), { stage: row.stage_name })
    ),
    "# HELP docslurp_cost_cents_total Total recorded cost cents by provider and model.",
    "# TYPE docslurp_cost_cents_total counter",
    ...(costRows ?? []).map((row) =>
      metricLine("docslurp_cost_cents_total", Number(row.total_cost_cents ?? 0), {
        provider: row.provider,
        model: row.model
      })
    )
  ];
  appendQueueMetricLines(lines, queue);
  appendAlertMetricLines(lines);
  await appendGatedFeatureMetricLines(lines);

  return `${lines.join("\n")}\n`;
}

/** Configured vs effective gated flags (services/worker-fleet.ts). Never fails the scrape. */
async function appendGatedFeatureMetricLines(lines: string[]): Promise<void> {
  try {
    const { workerFleetReport } = await import("../services/worker-fleet.js");
    const report = await workerFleetReport();
    lines.push(
      "# HELP docslurp_gated_feature 1 when a worker-gated flag is configured on / in effect for new runs (services/worker-fleet.ts).",
      "# TYPE docslurp_gated_feature gauge",
      ...report.features.flatMap((feature) => [
        metricLine("docslurp_gated_feature", feature.configured ? 1 : 0, { flag: feature.flag, state: "configured" }),
        metricLine("docslurp_gated_feature", feature.effective ? 1 : 0, { flag: feature.flag, state: "effective" }),
      ]),
      "# HELP docslurp_worker_fleet_workers Workers counted by the capability handshake, by registration.",
      "# TYPE docslurp_worker_fleet_workers gauge",
      metricLine("docslurp_worker_fleet_workers", report.workers.filter((worker) => worker.registered).length, { registered: "true", basis: report.basis }),
      metricLine("docslurp_worker_fleet_workers", report.workers.filter((worker) => !worker.registered).length, { registered: "false", basis: report.basis }),
    );
  } catch (error) {
    console.warn(`[metrics] gated feature metrics unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Per-process HTTP counters and the alert evaluator's last view. Evaluator
 * gauges for fleet checks are only emitted by the instance that currently
 * leads, so Prometheus rules aggregate with max() (ops/prometheus/alerts.yml).
 */
function appendAlertMetricLines(lines: string[]): void {
  lines.push(
    "# HELP docslurp_http_responses_total API responses served by this instance, by status class.",
    "# TYPE docslurp_http_responses_total counter",
    ...Object.entries(httpResponseStats.totals).map(([cls, count]) => metricLine("docslurp_http_responses_total", count, { class: cls })),
  );
  const evaluator = currentAlertEvaluator();
  if (!evaluator || evaluator.lastEvaluatedAt === null) return;
  const active = new Set(evaluator.tracker.activeAlerts());
  const known = evaluator.lastChecks.filter((check) => check.state !== "unknown");
  lines.push(
    "# HELP docslurp_alert_evaluator_last_run_timestamp_seconds When this instance last evaluated alerts.",
    "# TYPE docslurp_alert_evaluator_last_run_timestamp_seconds gauge",
    metricLine("docslurp_alert_evaluator_last_run_timestamp_seconds", Math.floor(evaluator.lastEvaluatedAt / 1000)),
    "# HELP docslurp_alert_evaluator_leader 1 when this instance evaluates fleet-wide alerts.",
    "# TYPE docslurp_alert_evaluator_leader gauge",
    metricLine("docslurp_alert_evaluator_leader", evaluator.isLeader() ? 1 : 0),
    "# HELP docslurp_alert_condition 1 while a check is failing (before dedupe), 0 when ok; unknown checks are omitted.",
    "# TYPE docslurp_alert_condition gauge",
    ...known.map((check) => metricLine("docslurp_alert_condition", check.state === "firing" ? 1 : 0, { alert: check.id })),
    "# HELP docslurp_alert_active 1 while an alert has been notified as firing and not yet resolved.",
    "# TYPE docslurp_alert_active gauge",
    ...known.map((check) => metricLine("docslurp_alert_active", active.has(check.id) ? 1 : 0, { alert: check.id })),
  );
}

async function buildFlyScalerMetricsPayload(): Promise<string> {
  await sweepStaleQueuedRuns();

  const queue = await queryWorkerScalerSnapshot(sql, SCALER_QUERY);
  const lines: string[] = [];
  appendQueueMetricLines(lines, queue);
  return `${lines.join("\n")}\n`;
}

async function buildFlyScalerMetricsPayloadWithRetry(): Promise<string> {
  try {
    return await buildFlyScalerMetricsPayload();
  } catch (error) {
    if (!isTransientDatabaseConnectionError(error)) {
      throw error;
    }
    console.warn("[fly-scaler-metrics] retrying after transient database connection closure");
    await wait(250);
    return await buildFlyScalerMetricsPayload();
  }
}

let scalerCache: { at: number; payload: Promise<string> } | null = null;

/** One query per SCALER_CACHE_MS window, shared by concurrent scrapes. */
function cachedFlyScalerMetricsPayload(): Promise<string> {
  const now = Date.now();
  if (SCALER_CACHE_MS > 0 && scalerCache && now - scalerCache.at < SCALER_CACHE_MS) {
    return scalerCache.payload;
  }
  const payload = buildFlyScalerMetricsPayloadWithRetry();
  scalerCache = { at: now, payload };
  // Never cache a failure.
  payload.catch(() => {
    if (scalerCache?.payload === payload) scalerCache = null;
  });
  return payload;
}

export const healthRoutes = new Hono()
  .get("/health", (c) => {
    return c.json({ ok: true, service: "docslurp-app", requestId: getRequestId(c) });
  })
  // Dependency readiness (services/readiness.ts): 503 when a critical check fails.
  .get("/ready", async (c) => {
    // Lazy: keeps storage/Temporal clients out of the liveness and metrics import path.
    const { cachedReadiness } = await import("../services/readiness.js");
    const report = await cachedReadiness();
    c.header("Cache-Control", "no-store");
    // The public edge sees pass/fail per dependency, not latencies, the schema
    // version or error text. Fly checks (private network) and the metrics bearer see everything.
    const redact = arrivedThroughPublicEdge((name) => c.req.header(name))
      && !authorizedMetricsRequest(c.req.header("Authorization") ?? undefined);
    const body = redact
      ? { ...report, checks: report.checks.map(({ name, ok, critical }) => ({ name, ok, critical })) }
      : report;
    return c.json({ ...body, service: "docslurp-app", requestId: getRequestId(c) }, report.serving ? 200 : 503);
  })
  .get("/metrics", async (c) => {
    if (!env.metricsSecret) {
      return c.json({ error: "Metrics endpoint not configured" }, 404);
    }

    if (!authorizedMetricsRequest(c.req.header("Authorization") ?? undefined)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const payload = await buildPrometheusPayload();
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(payload);
  })
  // Operator view of the app/worker capability handshake: configured vs
  // effective gated flags and the workers behind the decision. Same bearer
  // secret as /metrics; 404 when METRICS_SECRET is unset.
  .get("/ops/worker-fleet", async (c) => {
    if (!env.metricsSecret) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!authorizedMetricsRequest(c.req.header("Authorization") ?? undefined)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { workerFleetReport } = await import("../services/worker-fleet.js");
    c.header("Cache-Control", "no-store");
    return c.json(await workerFleetReport());
  })
  .get("/fly-scaler-metrics", async (c) => {
    // Queue depth, demand and fleet sizing are scraped over Fly's private network
    // (fly.app.toml [metrics]). Public requests need the metrics bearer;
    // FLY_SCALER_METRICS_PUBLIC=true restores the old open behaviour.
    if (
      process.env.FLY_SCALER_METRICS_PUBLIC !== "true"
      && arrivedThroughPublicEdge((name) => c.req.header(name))
      && !authorizedMetricsRequest(c.req.header("Authorization") ?? undefined)
    ) {
      return c.json({ error: "Not found" }, 404);
    }
    const payload = await cachedFlyScalerMetricsPayload();
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(payload);
  });
