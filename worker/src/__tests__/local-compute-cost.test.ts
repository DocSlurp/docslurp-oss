import { describe, expect, it } from "vitest";
import { CREDIT_RATE_CARD } from "@docslurp/shared";

import {
  flySharedComputeRates,
  buildLocalComputePerformanceEvents,
  buildLocalComputeUsageEvent,
  buildAllocatedResourceObservation,
  calculateLocalComputeCost,
  resolveWorkerDeploymentProfile,
  type LocalComputeRates,
} from "../pipeline/local-compute-cost.js";

const rates: LocalComputeRates = {
  cpuCentsPerSecond: 2,
  memoryCentsPerGbSecond: 3,
  gpuCentsPerSecond: 5,
  storageCentsPerGbMonth: 7,
  networkIngressCentsPerGb: 11,
  networkEgressCentsPerGb: 13,
};

describe("Local Compute Cost Module", () => {
  it("prices the deployed Fly worker without double-counting included RAM across the October rate change", () => {
    const before = flySharedComputeRates(new Date("2026-09-30T00:00:00Z"));
    const after = flySharedComputeRates(new Date("2026-10-01T00:00:00Z"));
    const hourly = (r: typeof before) => (2 * r.cpuCentsPerSecond + 3 * r.memoryCentsPerGbSecond) * 3600 / 100;
    expect(hourly(before)).toBeCloseTo(0.0054 + 2.5 * 5 / 720, 10);
    expect(hourly(after)).toBeCloseTo(0.0061 + 2.5 * 6 / 720, 10);
  });
  it("prices CPU, memory, GPU, storage, and network resources", () => {
    const result = calculateLocalComputeCost({
      cpuSeconds: 2,
      memoryGbSeconds: 3,
      gpuSeconds: 4,
      storageBytes: 1024 ** 3,
      storageDurationSeconds: 30 * 24 * 60 * 60,
      networkIngressBytes: 2 * 1024 ** 3,
      networkEgressBytes: 3 * 1024 ** 3,
    }, rates);

    expect(result.breakdown).toEqual({
      cpuCents: 4,
      memoryCents: 9,
      gpuCents: 20,
      storageCents: 7,
      networkIngressCents: 22,
      networkEgressCents: 39,
    });
    expect(result.totalCents).toBe(101);
  });

  it("preserves sub-cent local work instead of rounding it to zero", () => {
    const event = buildLocalComputeUsageEvent({
      metric: "parser-process",
      profile: {
        id: "lean:test:local",
        lane: "lean",
        workerClass: "test",
        region: "local",
        image: "test-image",
        allocatedVcpu: 1,
        allocatedMemoryGb: 1,
        rates: {
          ...rates,
          cpuCentsPerSecond: 0.001,
          memoryCentsPerGbSecond: 0.0001,
        },
      },
      observation: { cpuSeconds: 0.25, memoryGbSeconds: 0.5 },
    });

    expect(event.inputTokens).toBeUndefined();
    expect(event.costCents).toBeCloseTo(0.0003, 8);
    expect(event.costCents).toBeGreaterThan(0);
    expect(event.metadata?.billable).toBe(false);
  });

  it("never bills compute: infra cost and the internal list reference are kept for our reports", () => {
    const profile = resolveWorkerDeploymentProfile({ DOCSLURP_DEPLOYMENT_PROFILE: "lean" });
    const observation = { cpuSeconds: 3600, memoryGbSeconds: 7200, gpuSeconds: 360 };
    const event = buildLocalComputeUsageEvent({
      metric: "worker-page",
      profile: { ...profile, rates },
      observation,
      env: { DOCSLURP_BILL_COMPUTE: "true", STRIPE_SECRET_KEY: "sk_test" },
    });
    const list = CREDIT_RATE_CARD.cpuVcpuHour + 2 * CREDIT_RATE_CARD.memoryGbHour + 0.1 * CREDIT_RATE_CARD.gpuStandardHour;
    expect(event.metadata?.billable).toBe(false);
    expect(event.metadata?.internalListCredits).toBeCloseTo(list, 9);
    expect(event.metadata?.infraCostCents).toBe(3600 * 2 + 7200 * 3 + 360 * 5);
    expect(buildLocalComputeUsageEvent({ metric: "parser-process", profile: { ...profile, rates }, observation, costRollup: "included" }).costCents).toBe(0);
  });

  it("resolves explicit lean/heavy deployment metadata and rates", () => {
    const profile = resolveWorkerDeploymentProfile({
      NODE_ENV: "production",
      DOCSLURP_DEPLOYMENT_PROFILE: "heavy",
      DOCSLURP_WORKER_CLASS: "performance-2x",
      DOCSLURP_WORKER_REGION: "iad",
      DOCSLURP_WORKER_IMAGE: "worker-full@sha256:test",
      DOCSLURP_CPU_CENTS_PER_SECOND: "0.25",
    });

    expect(profile).toMatchObject({
      id: "heavy:performance-2x:iad",
      lane: "heavy",
      workerClass: "performance-2x",
      region: "iad",
      image: "worker-full@sha256:test",
      allocatedVcpu: 2,
      allocatedMemoryGb: 4,
    });
    expect(profile.rates.cpuCentsPerSecond).toBe(0.25);
  });

  it("reports throughput and cost-efficiency formulas", () => {
    const events = buildLocalComputePerformanceEvents({
      scope: "document",
      stageName: "extract-markdown",
      observation: {
        pages: 10,
        wallTimeMs: 120_000,
        cpuSeconds: 50,
        memoryGbSeconds: 60,
      },
      profile: {
        id: "lean:test:local",
        lane: "lean",
        workerClass: "test",
        region: "local",
        image: "test-image",
        allocatedVcpu: 1,
        allocatedMemoryGb: 1,
        rates,
      },
    });
    const byMetric = Object.fromEntries(events.map((event) => [event.metric, event.value]));

    expect(byMetric["pages-per-minute"]).toBe(5);
    expect(byMetric["time-to-ingest-100-pages"]).toBe(20);
    expect(byMetric["local-compute-cost"]).toBe(280);
    expect(byMetric["pages-per-dollar"]).toBeCloseTo(10 / 2.8, 8);
    expect(byMetric["cost-per-1000-pages"]).toBe(28_000);
  });

  it("prices a child-heavy stage from allocated capacity when parent CPU is idle", () => {
    const profile = {
      ...resolveWorkerDeploymentProfile({
        NODE_ENV: "production",
        DOCSLURP_DEPLOYMENT_PROFILE: "heavy",
        DOCSLURP_ALLOCATED_VCPU: "2",
        DOCSLURP_ALLOCATED_MEMORY_GB: "4",
      }),
      rates,
    };
    const observation = buildAllocatedResourceObservation({
      profile,
      wallTimeMs: 50_000,
      pages: 1,
    });
    const event = buildLocalComputeUsageEvent({
      metric: "worker-stage",
      profile,
      observation,
      metadata: { processCpuSeconds: 0 },
    });

    expect(observation.cpuSeconds).toBe(100);
    expect(observation.memoryGbSeconds).toBe(200);
    expect(event.costCents).toBe(800);
  });

});
