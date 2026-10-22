/**
 * Worker liveness over HTTP (WORKER_HEALTH_PORT, Fly machine check).
 *
 * The worker has no inbound traffic, so without this a machine that
 * crash-loops on Temporal connect, or whose pollers died, still counts as a
 * successful `flyctl deploy`. `/health` returns 200 only while every Temporal
 * worker in the process is RUNNING with live pollers, and 503 otherwise
 * (starting, draining, failed). `/metrics` (optional) serves Prometheus text
 * for Fly's scraper, e.g. the autoscaler target from the maintenance leader.
 */

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

export type WorkerRunState = "INITIALIZED" | "RUNNING" | "STOPPED" | "STOPPING" | "DRAINING" | "DRAINED" | "FAILED";
export type PollerState = "POLLING" | "SHUTDOWN" | "FAILED";

export interface WorkerStatusLike {
  runState: WorkerRunState;
  workflowPollerState: PollerState;
  activityPollerState: PollerState;
  numInFlightActivities?: number;
}

export interface WorkerHealth {
  ok: boolean;
  state: string;
  detail: string;
  inFlightActivities: number;
}

/** Pure: healthy only while every worker runs and no poller has failed. */
export function evaluateWorkerHealth(statuses: readonly WorkerStatusLike[]): WorkerHealth {
  const inFlightActivities = statuses.reduce((sum, status) => sum + (status.numInFlightActivities ?? 0), 0);
  if (statuses.length === 0) return { ok: false, state: "starting", detail: "no Temporal worker created yet", inFlightActivities };
  const notRunning = statuses.find((status) => status.runState !== "RUNNING");
  if (notRunning) {
    return { ok: false, state: notRunning.runState.toLowerCase(), detail: `Temporal worker is ${notRunning.runState}`, inFlightActivities };
  }
  const failedPoller = statuses.find((status) => status.workflowPollerState === "FAILED" || status.activityPollerState === "FAILED");
  if (failedPoller) return { ok: false, state: "poller-failed", detail: "a Temporal task poller failed", inFlightActivities };
  return { ok: true, state: "running", detail: "polling Temporal", inFlightActivities };
}

export function resolveWorkerHealthPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const parsed = Number.parseInt(env.WORKER_HEALTH_PORT?.trim() ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : null;
}

export function startWorkerHealthServer(args: {
  port: number;
  host?: string;
  health: () => WorkerHealth;
  metrics?: () => Promise<string>;
  /** Overrides WORKER_METRICS_SECRET; when set, /metrics requires `Authorization: Bearer <secret>`. */
  metricsSecret?: string;
}): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (path === "/health") {
      const health = args.health();
      res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ service: "docslurp-worker", ...health }));
      return;
    }
    if (path === "/metrics" && args.metrics) {
      // /metrics is private (6PN only) but can be gated with a bearer secret by
      // setting WORKER_METRICS_SECRET; the default keeps the scraper working
      // (SEC-2026-10-10).
      const required = (args.metricsSecret ?? process.env.WORKER_METRICS_SECRET ?? "").trim();
      if (required) {
        const provided = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] ?? "")?.[1] ?? "";
        const a = Buffer.from(provided);
        const b = Buffer.from(required);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          res.writeHead(401).end();
          return;
        }
      }
      args.metrics().then((body) => {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : body);
      }).catch((error) => {
        console.warn(`[worker-health] metrics failed: ${error instanceof Error ? error.message : String(error)}`);
        res.writeHead(500).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.on("error", (error) => console.error(`[worker-health] server error: ${error.message}`));
  // No host: Node binds "::" (dual-stack) when available, which covers Fly's 6PN checks.
  if (args.host) server.listen(args.port, args.host);
  else server.listen(args.port);
  server.unref();
  return server;
}
