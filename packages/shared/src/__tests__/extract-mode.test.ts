import { afterEach, describe, expect, it } from "vitest";

import {
  BILLABLE_UNIT_METRICS,
  EXTRACT_FREE_RETENTION_HOURS,
  EXTRACT_MAX_RETENTION_DAYS,
  EXTRACT_RETENTION_METRIC,
  installTestPricing,
  resetPricingProviderForTests,
  extractOptionsSchema,
  extractRetentionCredits,
  extractStoragePrefix,
  isBillableUnitMetric,
  isPaidExtractRetention,
} from "../index.js";

const GiB = 1024 ** 3;

describe("extract mode contract", () => {
  afterEach(() => resetPricingProviderForTests());

  it("keeps 48 hours free and caps requests at 30 days", () => {
    expect(EXTRACT_FREE_RETENTION_HOURS).toBe(48);
    expect(EXTRACT_MAX_RETENTION_DAYS).toBe(30);
    expect(isBillableUnitMetric(EXTRACT_RETENTION_METRIC)).toBe(true);
    expect(EXTRACT_RETENTION_METRIC).toBe(BILLABLE_UNIT_METRICS.extractRetention);
  });

  it("charges nothing inside the free window and prorates the provider's retention price beyond it", () => {
    installTestPricing({ extractRetentionCredits: (bytes, months) => (bytes / GiB) * months * 11 });
    expect(extractRetentionCredits({ bytes: GiB, retentionHours: 48 })).toBe(0);
    expect(isPaidExtractRetention(48)).toBe(false);
    expect(isPaidExtractRetention(72)).toBe(true);
    // One GiB for 30 days: one 30-day month.
    expect(extractRetentionCredits({ bytes: GiB, retentionHours: 30 * 24 })).toBeCloseTo(11, 10);
    // 3 days is a tenth of that.
    expect(extractRetentionCredits({ bytes: GiB, retentionHours: 72 })).toBeCloseTo(1.1, 10);
    // A deployment with a longer free window.
    expect(extractRetentionCredits({ bytes: GiB, retentionHours: 72, freeHours: 96 })).toBe(0);
  });

  it("refuses bad inputs instead of charging", () => {
    expect(extractRetentionCredits({ bytes: Number.NaN, retentionHours: 720 })).toBe(0);
    expect(extractRetentionCredits({ bytes: -5, retentionHours: 720 })).toBe(0);
    expect(extractOptionsSchema.safeParse({ retentionDays: 0 }).success).toBe(false);
    expect(extractOptionsSchema.safeParse({ retentionDays: 1.5 }).success).toBe(false);
    expect(extractOptionsSchema.safeParse({ download: "everything" }).success).toBe(false);
  });

  it("builds a tenant-scoped prefix and rejects path tricks", () => {
    expect(extractStoragePrefix({ orgId: "org-1", extractId: "ext_abc" })).toBe("extracts/org-1/ext_abc");
    for (const orgId of ["", "../org", "org/2", "org 1", "org\u0000"]) {
      expect(() => extractStoragePrefix({ orgId, extractId: "ext_abc" })).toThrow();
    }
    expect(() => extractStoragePrefix({ orgId: "org-1", extractId: "../ext" })).toThrow();
  });
});
