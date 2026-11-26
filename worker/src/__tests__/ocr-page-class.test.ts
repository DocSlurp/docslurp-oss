import { describe, expect, it, vi } from "vitest";

import { resolveWorkerCapabilities } from "../db/worker-capabilities.js";
import type { ProjectRun } from "../models.js";
import { OCR_PAGE_CLASS_SLOT, ocrPageClassConfigured, pinRunOcrPageClass, runUsesOcrPageClass } from "../pipeline/ocr-page-class.js";
import { WorkflowState } from "../pipeline/pipeline.js";

function ledger(values: Record<string, string> = {}) {
  return { values, read: (key: string) => values[key], record: (key: string, value: string) => { values[key] = value; } };
}

describe("OCR page class rollout gate", () => {
  it("pins a run to the class only when the operator has it on and every live worker advertises it; the pin is kept", async () => {
    const on = ledger();
    expect(await pinRunOcrPageClass({ artifactLedger: on }, async () => true, {})).toBe(true);
    expect(on.values[OCR_PAGE_CLASS_SLOT]).toBe("1");
    // A retried start keeps the first decision, whatever the fleet says now.
    expect(await pinRunOcrPageClass({ artifactLedger: on }, async () => false, {})).toBe(true);
    const older = ledger();
    expect(await pinRunOcrPageClass({ artifactLedger: older }, async () => false, {})).toBe(false);
    expect(older.values[OCR_PAGE_CLASS_SLOT]).toBe("0");
    const failing = ledger();
    expect(await pinRunOcrPageClass({ artifactLedger: failing }, async () => { throw new Error("registry down"); }, {})).toBe(false);
    const fleet = vi.fn(async () => true);
    const off = ledger();
    expect(await pinRunOcrPageClass({ artifactLedger: off }, fleet, { DOCSLURP_OCR_PAGE_CLASS: "off" })).toBe(false);
    expect(fleet).not.toHaveBeenCalled();
    expect(ocrPageClassConfigured({})).toBe(true);
    expect(ocrPageClassConfigured({ DOCSLURP_OCR_PAGE_CLASS: "0" })).toBe(false);
  });

  it("reads the pin; a run started before the class (per-read pin, no OCR pin) keeps billing OCR reads Rich", () => {
    expect(runUsesOcrPageClass(ledger({ [OCR_PAGE_CLASS_SLOT]: "1" }))).toBe(true);
    expect(runUsesOcrPageClass(ledger({ [OCR_PAGE_CLASS_SLOT]: "0", "run:page-billing-rules": "v" }))).toBe(false);
    expect(runUsesOcrPageClass(ledger({ "run:page-billing-rules": "v" }))).toBe(false);
    expect(runUsesOcrPageClass(ledger())).toBe(true);
  });

  it("the run's ledger follows the pin, also when it is pinned after the state was built", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const state = WorkflowState.create({ id: "run-g", pipeline: {}, stats: {}, artifacts: {}, stage: "x" } as unknown as ProjectRun, []);
    state.artifactLedger.record("run:page-billing-rules", "v");
    state.artifactLedger.record(OCR_PAGE_CLASS_SLOT, "0");
    state.usageLedger.chargeOcrPage({ documentId: "d", pageNumber: 1, readBy: "page-ocr" });
    expect(state.usageLedger.pageChargeClass("d", 1)).toBe("rich");
    state.artifactLedger.record(OCR_PAGE_CLASS_SLOT, "1");
    state.usageLedger.chargeOcrPage({ documentId: "d", pageNumber: 2, readBy: "page-ocr" });
    expect(state.usageLedger.pageChargeClass("d", 2)).toBe("ocr");
  });

  it("a worker advertises the capability only when the settlement trigger exists", async () => {
    const base = { creditLeasesActive: async () => false, lexicalColumnPresent: async () => false };
    expect(await resolveWorkerCapabilities({ ...base, ocrPageClassSettlement: async () => true })).toContain("billing.ocr-page-class");
    expect(await resolveWorkerCapabilities({ ...base, ocrPageClassSettlement: async () => false })).not.toContain("billing.ocr-page-class");
    expect(await resolveWorkerCapabilities({ ...base, ocrPageClassSettlement: async () => { throw new Error("no"); } })).not.toContain("billing.ocr-page-class");
    expect(await resolveWorkerCapabilities(base)).not.toContain("billing.ocr-page-class");
  });
});
