import { describe, expect, it } from "vitest";

import { CREDIT_RATE_CARD } from "../billing.js";
import {
  INFRA_COST_OBSERVATIONS,
  RESOURCE_CLASS_POLICY,
  WORKER_SLOT,
  assessRateCard,
  breakEvenUtilization,
  flySharedMonthlyUsd,
  listUsdForBundle,
  marginAtUtilization,
  rateCardViolations,
  slotCreditsPerHour,
  slotInfraUsdPerHour,
  staleObservations,
} from "../infra-costs.js";

const RATE_CARD_KEYS = [
  "cpuVcpuHour",
  "memoryGbHour",
  "gpuStandardHour",
  "gpuLargeHour",
  "objectStorageGbMonth",
  "indexStorageGbMonth",
  "egressGb",
] as const;

describe("infra cost observations", () => {
  it("have unique ids, positive prices and a source", () => {
    const ids = INFRA_COST_OBSERVATIONS.map((observation) => observation.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const observation of INFRA_COST_OBSERVATIONS) {
      expect(observation.usd).toBeGreaterThan(0);
      expect(observation.sourceUrl).toMatch(/^https:\/\//);
      expect(observation.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("derive Fly presets linearly from the shared-cpu-1x anchor", () => {
    expect(flySharedMonthlyUsd(1, 0.25)).toBeCloseTo(2.19);
    expect(flySharedMonthlyUsd(8, 2)).toBeCloseTo(17.52);
    expect(flySharedMonthlyUsd(8, 16)).toBeCloseTo(17.52 + 14 * 6);
    const iad = INFRA_COST_OBSERVATIONS.find((observation) => observation.id === "fly:shared-cpu-8x-16gb:iad")!;
    const lax = INFRA_COST_OBSERVATIONS.find((observation) => observation.id === "fly:shared-cpu-8x-16gb:lax")!;
    expect(iad.usd).toBeCloseTo(101.52 / 720, 5);
    expect(lax.usd / iad.usd).toBeCloseTo(1.1995, 3);
  });
});

describe("resource class policy", () => {
  it("covers every billable rate-card line and the AI markup", () => {
    const covered = new Set(RESOURCE_CLASS_POLICY.flatMap((lane) => lane.skus.flatMap((sku) => Object.keys(sku.bundle))));
    for (const key of RATE_CARD_KEYS) expect(covered.has(key)).toBe(true);
    expect(covered.has("aiProviderUsd")).toBe(true);
  });

  it("references only recorded observations", () => {
    const ids = new Set(INFRA_COST_OBSERVATIONS.map((observation) => observation.id));
    for (const lane of RESOURCE_CLASS_POLICY) {
      for (const sku of lane.skus) expect(ids.has(sku.observationId)).toBe(true);
    }
  });

  it("is met by every allowed SKU under the current rate card", () => {
    const findings = assessRateCard(CREDIT_RATE_CARD);
    expect(rateCardViolations(findings)).toEqual([]);
    expect(findings.filter((finding) => finding.severity === "ok").length).toBeGreaterThanOrEqual(10);
  });

  it("reports disallowed SKUs instead of failing on them", () => {
    const findings = assessRateCard(CREDIT_RATE_CARD);
    const disallowed = new Map(findings.filter((finding) => finding.severity === "disallowed").map((finding) => [finding.observationId, finding]));
    expect(disallowed.has("fly:performance-1x-2gb:lax")).toBe(true);
    expect(disallowed.get("modal:l4-nonpreemptible")!.breakEven!).toBeGreaterThan(1);
    expect(disallowed.has("vast:h100-sxm")).toBe(true);
  });

  it("flags the previous card, which priced RAM and storage below cost", () => {
    const previous = { ...CREDIT_RATE_CARD, cpuVcpuHour: 4, memoryGbHour: 0.5, objectStorageGbMonth: 3, indexStorageGbMonth: 25 };
    const violations = rateCardViolations(assessRateCard(previous)).map((finding) => finding.observationId);
    expect(violations).toEqual(expect.arrayContaining(["fly:extra-ram:lax", "fly:shared-cpu-8x-16gb:lax", "tigris:standard", "neon:storage"]));
  });

  it("reports a missing observation as a violation", () => {
    const findings = assessRateCard(CREDIT_RATE_CARD, INFRA_COST_OBSERVATIONS.filter((observation) => observation.id !== "vast:l4"));
    expect(rateCardViolations(findings).map((finding) => finding.observationId)).toEqual(["vast:l4"]);
  });
});

describe("break-even math", () => {
  it("divides infra cost by list price and derives margin", () => {
    expect(breakEvenUtilization(0.3, 0.9)).toBeCloseTo(1 / 3);
    expect(breakEvenUtilization(1, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(marginAtUtilization(0.35, 0.7)).toBeCloseTo(0.5);
    expect(marginAtUtilization(0.35, 1)).toBeCloseTo(0.65);
  });

  it("prices bundles at list, including the AI markup", () => {
    expect(listUsdForBundle({ cpuVcpuHour: 1, memoryGbHour: 2 })).toBeCloseTo((CREDIT_RATE_CARD.cpuVcpuHour + 2 * CREDIT_RATE_CARD.memoryGbHour) / 100);
    expect(listUsdForBundle({ aiProviderUsd: 1 })).toBeCloseTo(1 + CREDIT_RATE_CARD.aiMarkupPercent / 100);
  });

  it("prices a worker slot from its host", () => {
    expect(slotCreditsPerHour()).toBe(WORKER_SLOT.vcpu * CREDIT_RATE_CARD.cpuVcpuHour + WORKER_SLOT.memoryGb * CREDIT_RATE_CARD.memoryGbHour);
    expect(slotInfraUsdPerHour() * WORKER_SLOT.slotsPerHost).toBeCloseTo(
      INFRA_COST_OBSERVATIONS.find((observation) => observation.id === WORKER_SLOT.hostObservationId)!.usd,
    );
  });
});

describe("staleness", () => {
  it("warns about observations older than 45 days", () => {
    const observations = [INFRA_COST_OBSERVATIONS[0]!];
    const observedAt = new Date(`${observations[0]!.observedAt}T00:00:00Z`);
    expect(staleObservations(observations, new Date(observedAt.getTime() + 44 * 86_400_000))).toEqual([]);
    expect(staleObservations(observations, new Date(observedAt.getTime() + 46 * 86_400_000)).length).toBe(observations.length);
    expect(staleObservations([{ ...INFRA_COST_OBSERVATIONS[0]!, observedAt: "unknown" }]).length).toBe(1);
  });
});
