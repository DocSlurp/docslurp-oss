import { describe, expect, it } from "vitest";

import { OCR_ROUTE_OPTIONS, selectOcrRoute } from "../tier-options.js";

const measured = { evalScore: 0.95 };

describe("scanned-page OCR route tiers", () => {
  it("fastest is the recogniser alone, with hosted escalation of doubted pages as configured", () => {
    expect(selectOcrRoute("fastest", { pageReader: measured, hostedEscalation: true })).toEqual({ optionId: "scan-ocr/recogniser", pageReader: "off", hostedEscalation: true });
    expect(selectOcrRoute("fastest", { pageReader: measured, hostedEscalation: false }).hostedEscalation).toBe(false);
  });

  it("smart takes the best-scored reader for every page and keeps hosted escalation as the fallback", () => {
    expect(selectOcrRoute("smart", { pageReader: measured, hostedEscalation: true })).toEqual({ optionId: "scan-ocr/page-reader", pageReader: "all", hostedEscalation: true });
    // A page reader that scores under the hosted escalation reader is not smart.
    expect(selectOcrRoute("smart", { pageReader: { evalScore: 0.5 }, hostedEscalation: true })).toEqual({ optionId: "scan-ocr/hosted-escalation", pageReader: "off", hostedEscalation: true });
  });

  it("never picks an unmeasured or missing page reader", () => {
    for (const pageReader of [null, { evalScore: null }, { evalScore: Number.NaN }, { evalScore: 2 }]) {
      expect(selectOcrRoute("smart", { pageReader, hostedEscalation: true }).pageReader).toBe("off");
      expect(selectOcrRoute("balanced", { pageReader, hostedEscalation: true }).pageReader).toBe("off");
    }
  });

  it("never picks a reader at or under the recogniser alone, even with escalation off", () => {
    expect(selectOcrRoute("smart", { pageReader: { evalScore: 0.1 }, hostedEscalation: false }).pageReader).toBe("off");
    expect(selectOcrRoute("balanced", { pageReader: { evalScore: 0.1 }, hostedEscalation: false }).pageReader).toBe("off");
  });

  it("treats a hosted escalation model other than the measured one as unmeasured", () => {
    const other = { pageReader: null, hostedEscalation: true, hostedEscalationModel: "llm://openrouter/some/other-model" };
    expect(selectOcrRoute("smart", other).optionId).toBe("scan-ocr/recogniser");
    expect(selectOcrRoute("smart", { ...other, hostedEscalationModel: "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct" }).optionId).toBe("scan-ocr/hosted-escalation");
    // A page reader measured above the recogniser still wins smart when the escalation model is unmeasured.
    expect(selectOcrRoute("smart", { ...other, pageReader: { evalScore: 0.6 } }).pageReader).toBe("all");
  });

  it("falls back to the recogniser when nothing else is available", () => {
    expect(selectOcrRoute("smart", { pageReader: null, hostedEscalation: false })).toEqual({ optionId: "scan-ocr/recogniser", pageReader: "off", hostedEscalation: false });
  });

  it("balanced sends the doubted pages to the page reader when one is measured, else to hosted escalation", () => {
    expect(selectOcrRoute("balanced", { pageReader: measured, hostedEscalation: true })).toEqual({ optionId: "scan-ocr/page-reader", pageReader: "escalation", hostedEscalation: true });
    expect(selectOcrRoute("balanced", { pageReader: null, hostedEscalation: true })).toEqual({ optionId: "scan-ocr/hosted-escalation", pageReader: "off", hostedEscalation: true });
  });

  it("records every measured option's composite and run", () => {
    for (const option of OCR_ROUTE_OPTIONS) {
      if (option.reader === "page-reader") expect(option.evalScore).toBeNull();
      else expect(option.evalScore! > 0 && option.evalScore! <= 1 && Boolean(option.evalRef)).toBe(true);
    }
  });
});
