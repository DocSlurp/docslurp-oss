/**
 * The durable read budgets for reads one capped signal family authorized (`encoding-read`, `table-rescue`): the shared
 * whole-page ceiling, the per-purpose "new page" rule and the region scope, on the process-local backend (the Postgres
 * backend applies the same rule: vision-attempt-store.test.ts).
 */
import { describe, expect, it } from "vitest";

import { MemoryVisionAttemptBackend, VisionRunGuard, type VisionAttemptTarget, type VisionGuardConfig } from "./vision-attempt-guard.js";

const config: VisionGuardConfig = {
  pageAttempts: 2, regionAttempts: 4, breakerMinFailures: 1_000, breakerFailureRate: 1, orgLimitCents: 1_000, throttleAllowance: 5, routeOverrunLimit: 3, routeWeightCorrectionMax: 4,
};

function guardOf(backend = new MemoryVisionAttemptBackend()) {
  return { backend, guard: new VisionRunGuard({ id: "run-1", orgId: "org-1" }, config, backend) };
}

async function admit(guard: VisionRunGuard, target: Omit<VisionAttemptTarget, "documentId">): Promise<string | null> {
  const gate = guard.call({ documentId: "doc-1", ...target });
  try {
    await gate.admit({ weightCents: 0.01 });
    return null;
  } catch (error) {
    return (error as { stop?: { reason: string } }).stop?.reason ?? String(error);
  } finally {
    await gate.finish();
  }
}

describe("whole-page reads share one per-page ceiling across page, table-rescue and encoding-read", () => {
  it("a page read under one purpose cannot take a second full budget under another (a resumed task, a re-routed plan)", async () => {
    const { guard } = guardOf();
    expect(await admit(guard, { pageNumber: 1, purpose: "page" })).toBeNull();
    expect(await admit(guard, { pageNumber: 1, purpose: "encoding-read", documentPageLimit: 3 })).toBeNull();
    // Two requests of page 1 in all: every whole-page purpose is now refused for it.
    for (const purpose of ["page", "encoding-read", "table-rescue"] as const) {
      expect(await admit(guard, { pageNumber: 1, purpose, ...(purpose === "page" ? {} : { documentPageLimit: 3 }) }), purpose).toBe("page-attempt-limit");
    }
    // Other purposes keep their own bound (map OCR, critique, OCR escalation), and other pages theirs.
    expect(await admit(guard, { pageNumber: 1, purpose: "critique" })).toBeNull();
    expect(await admit(guard, { pageNumber: 2, purpose: "page" })).toBeNull();
  });

  it("a page read before as an ordinary read is still new to a budget: it counts against the budget's pages", async () => {
    const { guard } = guardOf();
    expect(await admit(guard, { pageNumber: 1, purpose: "page" })).toBeNull();
    // A budget of one page: page 2 takes it; page 1 (read once as `page`, never under the budget) is refused as new.
    expect(await admit(guard, { pageNumber: 2, purpose: "encoding-read", documentPageLimit: 1 })).toBeNull();
    expect(await admit(guard, { pageNumber: 1, purpose: "encoding-read", documentPageLimit: 1 })).toBe("document-page-limit");
    // Page 2 keeps its own (shared) page bound inside the budget.
    expect(await admit(guard, { pageNumber: 2, purpose: "encoding-read", documentPageLimit: 1 })).toBeNull();
    expect(await admit(guard, { pageNumber: 2, purpose: "encoding-read", documentPageLimit: 1 })).toBe("page-attempt-limit");
  });

  it("region reads of a budgeted page count toward its distinct-page budget and take the region bound", async () => {
    const { guard } = guardOf();
    const region = (pageNumber: number) => ({ pageNumber, purpose: "encoding-read" as const, scope: "region" as const, documentPageLimit: 2 });
    // Four regions of page 1 (the region bound), then refused.
    for (let n = 0; n < 4; n += 1) expect(await admit(guard, region(1))).toBeNull();
    expect(await admit(guard, region(1))).toBe("page-attempt-limit");
    expect(await admit(guard, region(2))).toBeNull();
    // Pages 1 and 2 used the budget: a third page is refused, by region or whole page.
    expect(await admit(guard, region(3))).toBe("document-page-limit");
    expect(await admit(guard, { pageNumber: 3, purpose: "encoding-read", documentPageLimit: 2 })).toBe("document-page-limit");
    // Ordinary region reads of other pages are untouched by the budget.
    expect(await admit(guard, { pageNumber: 3, purpose: "region" })).toBeNull();
  });
});
