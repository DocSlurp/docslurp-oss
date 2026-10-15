import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { evaluateWorkerHealth, resolveWorkerHealthPort, startWorkerHealthServer, type WorkerStatusLike } from "../temporal/health-server.js";

const running: WorkerStatusLike = { runState: "RUNNING", workflowPollerState: "POLLING", activityPollerState: "POLLING", numInFlightActivities: 2 };

describe("worker health", () => {
  it("is healthy only while every Temporal worker runs with live pollers", () => {
    expect(evaluateWorkerHealth([running, running])).toMatchObject({ ok: true, inFlightActivities: 4 });
    expect(evaluateWorkerHealth([])).toMatchObject({ ok: false, state: "starting" });
    expect(evaluateWorkerHealth([running, { ...running, runState: "DRAINING" }])).toMatchObject({ ok: false, state: "draining" });
    expect(evaluateWorkerHealth([{ ...running, runState: "FAILED" }])).toMatchObject({ ok: false, state: "failed" });
    expect(evaluateWorkerHealth([{ ...running, activityPollerState: "FAILED" }])).toMatchObject({ ok: false, state: "poller-failed" });
  });

  it("parses WORKER_HEALTH_PORT and treats junk as disabled", () => {
    expect(resolveWorkerHealthPort({ WORKER_HEALTH_PORT: "9091" })).toBe(9091);
    expect(resolveWorkerHealthPort({ WORKER_HEALTH_PORT: "" })).toBeNull();
    expect(resolveWorkerHealthPort({ WORKER_HEALTH_PORT: "99999" })).toBeNull();
  });

  it("serves 200/503 on /health and Prometheus text on /metrics", async () => {
    let healthy = true;
    const server = startWorkerHealthServer({
      port: 0,
      host: "127.0.0.1",
      health: () => evaluateWorkerHealth(healthy ? [running] : [{ ...running, runState: "STOPPED" }]),
      metrics: async () => "docslurp_worker_target_machines 3\n",
    });
    try {
      if (!server.listening) await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ok = await fetch(`${base}/health`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ service: "docslurp-worker", ok: true });
      healthy = false;
      expect((await fetch(`${base}/health`)).status).toBe(503);
      expect(await (await fetch(`${base}/metrics`)).text()).toContain("docslurp_worker_target_machines 3");
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
