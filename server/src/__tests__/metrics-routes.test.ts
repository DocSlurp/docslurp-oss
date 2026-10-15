import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) });
const startPipelineWorkflowMock = vi.fn(async () => undefined);

vi.mock("../db.js", () => ({
  sql: sqlMock
}));

vi.mock("../lib/temporal.js", () => ({
  startPipelineWorkflow: startPipelineWorkflowMock
}));

vi.mock("../config.js", () => ({
  env: {
    metricsSecret: "metrics-secret"
  }
}));

// Scaler config is read at import: 8-slot machines, no response cache between cases.
process.env.DOCSLURP_SCALER_CACHE_MS = "0";
process.env.DOCSLURP_WORKER_SLOTS_PER_MACHINE = "8";

const { defaultPipelineFeatures } = await import("@docslurp/shared");
const { healthRoutes } = await import("../routes/health.js");

function buildApp() {
  const app = new Hono();
  app.route("/", healthRoutes);
  return app;
}

describe("healthRoutes /metrics", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    sqlMock.mockReset();
    startPipelineWorkflowMock.mockReset();
    startPipelineWorkflowMock.mockResolvedValue(undefined);
  });

  it("rejects requests without the configured bearer token", async () => {
    const response = await app.request("/metrics");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns Prometheus text when authorized", async () => {
    sqlMock
      .mockResolvedValueOnce([
        { status: "completed", count: 4 },
        { status: "queued", count: 2 }
      ])
      .mockResolvedValueOnce([
        {
          queue_depth: 2,
          queued_documents: 0,
          queued_pages: 137,
          processing_runs: 3,
          stale_leases: 1,
          worker_active: 1,
          pages_processed_total: 42,
          oldest_queued_run_age_seconds: 300,
          oldest_queued_run_created_at_seconds: 1741478400
        }
      ])
      .mockResolvedValueOnce([
        {
          stage_name: "extract-markdown",
          p50_seconds: 0.2,
          p95_seconds: 0.8
        }
      ])
      .mockResolvedValueOnce([
        {
          provider: "openai",
          model: "text-embedding-3-small",
          total_cost_cents: 123
        }
      ]);

    const response = await app.request("/metrics", {
      headers: {
        Authorization: "Bearer metrics-secret"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");

    const body = await response.text();
    expect(body).toContain('docslurp_runs_total{status="completed"} 4');
    expect(body).toContain("docslurp_pages_processed_total 42");
    expect(body).toContain("docslurp_queue_depth 2");
    expect(body).toContain("docslurp_queued_documents 0");
    expect(body).toContain("docslurp_queued_pages 137");
    expect(body).toContain("docslurp_processing_runs 3");
    expect(body).toContain("docslurp_stale_leases 1");
    expect(body).toContain("docslurp_worker_active 1");
    expect(body).toContain("docslurp_worker_target_machines 1");
    expect(body).toContain("docslurp_worker_slots_per_machine 8");
    expect(body).toContain("docslurp_worker_max_autoscale_machines 12");
    expect(body).toContain("docslurp_oldest_queued_run_created_at_seconds 1741478400");
    expect(body).toContain("docslurp_oldest_queued_run_age_seconds 300");
    expect(body).toContain('docslurp_stage_duration_seconds_p50{stage="extract-markdown"} 0.2');
    expect(body).toContain('docslurp_stage_duration_seconds_p95{stage="extract-markdown"} 0.8');
    expect(body).toContain('docslurp_cost_cents_total{provider="openai",model="text-embedding-3-small"} 123');
  });

  it("exposes a narrow Fly scaler metrics endpoint with the computed worker target", async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        queue_depth: 2,
        queued_documents: 2,
        queued_pages: 350,
        processing_runs: 1,
        stale_leases: 0,
        worker_active: 1,
        pages_processed_total: 42,
        oldest_queued_run_age_seconds: 120,
        oldest_queued_run_created_at_seconds: 1741478400,
        org_demand: [{ org_key: "org-a", slots: 20, demand: 9 }]
      }
    ]);

    const response = await app.request("/fly-scaler-metrics");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");

    const body = await response.text();
    expect(body).toContain("docslurp_queue_depth 2");
    expect(body).toContain("docslurp_queued_documents 2");
    expect(body).toContain("docslurp_queued_pages 350");
    expect(body).toContain("docslurp_worker_slot_demand 9");
    expect(body).toContain("docslurp_worker_target_machines 2"); // ceil(9 / 8)
    expect(body).not.toContain("docslurp_cost_cents_total");
  });

  it("caps each org's demand at its plan worker slots", async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      worker_active: 1,
      org_demand: JSON.stringify([
        { org_key: "free", slots: 2, demand: 500 },
        { org_key: "silver", slots: 20, demand: 30 },
        { org_key: "gold", slots: 100, demand: 41 },
      ]),
    }]);
    const body = await (await app.request("/fly-scaler-metrics")).text();
    expect(body).toContain("docslurp_worker_slot_demand 63"); // 2 + 20 + 41
    expect(body).toContain("docslurp_worker_target_machines 8"); // ceil(63 / 8)
    expect(body).toContain("docslurp_worker_demand_orgs 3");
  });

  it("does not start extra workers for thousands of native-text pages without page activities", async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      queue_depth: 0, queued_documents: 0, queued_pages: 0,
      processing_documents: 1, processing_pages: 5000, processing_runs: 1,
      pending_page_tasks: 0, worker_active: 1,
      org_demand: [{ org_key: "org-a", slots: 1000, demand: 1 }],
    }]);
    const response = await app.request("/fly-scaler-metrics");
    expect(await response.text()).toContain("docslurp_worker_target_machines 1");
  });

  it("clamps the target to DOCSLURP_WORKER_MAX_AUTOSCALE_MACHINES", async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      processing_documents: 1, processing_pages: 20, pending_page_tasks: 128, worker_active: 1,
      org_demand: [{ org_key: "platinum", slots: 1000, demand: 1000 }],
    }]);
    const body = await (await app.request("/fly-scaler-metrics")).text();
    expect(body).toContain("docslurp_pending_page_tasks 128");
    expect(body).toContain("docslurp_worker_target_machines 12"); // Test config cap; Fly is 125.
  });

  it("defaults the Fly worker target to zero when no work is queued or active", async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        queue_depth: 0,
        queued_documents: 0,
        queued_pages: 0,
        processing_runs: 0,
        stale_leases: 0,
        worker_active: 0,
        pages_processed_total: 42,
        oldest_queued_run_age_seconds: null,
        oldest_queued_run_created_at_seconds: null
      }
    ]);

    const response = await app.request("/fly-scaler-metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("docslurp_worker_target_machines 0");
  });

  it("does not keep workers alive for stale processing rows without a live lease", async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        queue_depth: 0,
        queued_documents: 0,
        queued_pages: 0,
        processing_runs: 3,
        stale_leases: 3,
        worker_active: 0,
        pages_processed_total: 42,
        oldest_queued_run_age_seconds: null,
        oldest_queued_run_created_at_seconds: null
      }
    ]);

    const response = await app.request("/fly-scaler-metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("docslurp_processing_runs 3");
    expect(body).toContain("docslurp_stale_leases 3");
    expect(body).toContain("docslurp_worker_target_machines 0");
  });

  it("retries Fly scaler metrics once after a transient database connection closure", async () => {
    const transientError = Object.assign(new Error("write CONNECTION_CLOSED"), {
      code: "CONNECTION_CLOSED",
      errno: "CONNECTION_CLOSED"
    });

    sqlMock
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          queue_depth: 0,
          queued_documents: 0,
          queued_pages: 0,
          processing_runs: 0,
          stale_leases: 0,
          worker_active: 0,
          pages_processed_total: 42,
          oldest_queued_run_age_seconds: null,
          oldest_queued_run_created_at_seconds: null
        }
      ]);

    const response = await app.request("/fly-scaler-metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(sqlMock).toHaveBeenCalledTimes(3);
    expect(body).toContain("docslurp_worker_target_machines 0");
  });

  it("counts queued runs as one document-stage slot each", async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        queue_depth: 5,
        queued_documents: 5,
        queued_pages: 5,
        processing_runs: 0,
        stale_leases: 0,
        worker_active: 0,
        pages_processed_total: 42,
        oldest_queued_run_age_seconds: 7_119_565,
        oldest_queued_run_created_at_seconds: 1775420378.14763,
        org_demand: [{ org_key: "org-a", slots: 20, demand: 5 }]
      }
    ]);

    const response = await app.request("/fly-scaler-metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("docslurp_queued_documents 5");
    expect(body).toContain("docslurp_worker_target_machines 1"); // 5 slots fit one 8-slot machine
  });

  it.each([null, JSON.stringify({ old: true })])("restarts stale queued runs with JSON-object stats (%s)", async (stats) => {
    const staleRun = {
      id: "run-stale",
      user_id: "user-1",
      pipeline: null,
      stage: "queued",
      total_documents: 1,
      created_at: new Date(Date.now() - 15 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 15 * 60_000).toISOString(),
      stats
    };

    sqlMock
      .mockResolvedValueOnce([staleRun])
      // Run Lifecycle records the confirmed workflow start.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          queue_depth: 1,
          queued_documents: 1,
          queued_pages: 4,
          processing_runs: 0,
          stale_leases: 0,
          worker_active: 0,
          pages_processed_total: 42,
          oldest_queued_run_age_seconds: 900,
          oldest_queued_run_created_at_seconds: 1741478400,
          org_demand: [{ org_key: "org-a", slots: 2, demand: 1 }]
        }
      ]);

    const response = await app.request("/fly-scaler-metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(startPipelineWorkflowMock).toHaveBeenCalledWith("run-stale", defaultPipelineFeatures);
    expect(body).toContain("docslurp_worker_target_machines 1");
    expect((sqlMock.mock.calls[1][0] as TemplateStringsArray).join("")).toContain("workflow_started_at = now()");
    const savedStats = sqlMock.mock.calls[2][1];
    expect(typeof savedStats).toBe("object");
    expect(Object.keys(savedStats)).toEqual(["staleQueueRecovery"]);
    expect(savedStats.staleQueueRecovery.attempts).toBe(1);
  });

  it("marks long-stuck queued runs as failed before calculating the Fly worker target", async () => {
    const stuckRun = {
      id: "run-stuck",
      user_id: "user-1",
      pipeline: null,
      stage: "queued",
      total_documents: 1,
      created_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      stats: null
    };

    sqlMock
      .mockResolvedValueOnce([stuckRun])
      // Run Lifecycle fail: read current, compare-and-set update, stage
      // states, documents, run.failed event.
      .mockResolvedValueOnce([{ status: "queued", control_state: null, stats: null, failure_count: 0 }])
      .mockResolvedValueOnce([{ id: "run-stuck", user_id: "user-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          queue_depth: 0,
          queued_documents: 0,
          queued_pages: 0,
          processing_runs: 0,
          stale_leases: 0,
          worker_active: 0,
          pages_processed_total: 42,
          oldest_queued_run_age_seconds: null,
          oldest_queued_run_created_at_seconds: null
        }
      ]);

    const response = await app.request("/fly-scaler-metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(startPipelineWorkflowMock).not.toHaveBeenCalled();
    expect(sqlMock).toHaveBeenCalledTimes(7);
    expect(body).toContain("docslurp_worker_target_machines 0");
  });
});
