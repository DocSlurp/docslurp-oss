import { describe, expect, it } from "vitest";

import {
  BILLABLE_UNIT_METRICS,
  EXTRACT_FREE_RETENTION_HOURS,
  EXTRACT_MAX_RETENTION_DAYS,
  EXTRACT_RETENTION_METRIC,
  EXTRACT_RETENTION_STORAGE_MULTIPLIER,
  PRICE_CARD,
  extractOptionsSchema,
  extractRetentionCredits,
  extractStoragePrefix,
  isBillableUnitMetric,
  isPaidExtractRetention,
} from "../index.js";

const GiB = 1024 ** 3;

describe("extract mode contract", () => {
  it("keeps 48 hours free, caps requests at 30 days and prices extended retention at 2x storage", () => {
    expect(EXTRACT_FREE_RETENTION_HOURS).toBe(48);
    expect(EXTRACT_MAX_RETENTION_DAYS).toBe(30);
    expect(EXTRACT_RETENTION_STORAGE_MULTIPLIER).toBe(2);
    expect(isBillableUnitMetric(EXTRACT_RETENTION_METRIC)).toBe(true);
    expect(EXTRACT_RETENTION_METRIC).toBe(BILLABLE_UNIT_METRICS.extractRetention);
  });

  it("charges nothing inside the free window and prorates 2x the storage price beyond it", () => {
    expect(extractRetentionCredits({ bytes: GiB, retentionHours: 48 })).toBe(0);
    expect(isPaidExtractRetention(48)).toBe(false);
    expect(isPaidExtractRetention(72)).toBe(true);
    // One GiB for 30 days: two months of storage.
    expect(extractRetentionCredits({ bytes: GiB, retentionHours: 30 * 24 })).toBeCloseTo(2 * PRICE_CARD.storageGbMonth, 10);
    // 3 days is a tenth of that.
    expect(extractRetentionCredits({ bytes: GiB, retentionHours: 72 })).toBeCloseTo(0.2 * PRICE_CARD.storageGbMonth, 10);
    // A deployment with a longer free window.
    expect(extractRetentionCredits({ bytes: GiB, retentionHours: 72, freeHours: 96 })).toBe(0);
  });

  it("prices 1,000 pages kept 30 days at about 9.5 credits (75 KB sources, estimated artifacts and indexes)", () => {
    const pages = 1_000;
    const bytes = pages * 75 * 1024 + pages * (96 + 28) * 1024;
    const credits = extractRetentionCredits({ bytes, retentionHours: 30 * 24 });
    expect(credits).toBeCloseTo(9.489, 3);
    // Pages per $1 of retention alone (1 credit = 1 cent).
    expect(Math.round(pages / (credits / 100))).toBe(10_538);
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
