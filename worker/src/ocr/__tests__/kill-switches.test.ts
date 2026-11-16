import { afterEach, describe, expect, it } from "vitest";

import { resetExtractorPluginsForTest } from "../../extractors/plugins.js";
import { ocrEscalationEnabled } from "../hosted-reader.js";
import { assertOcrConfiguration } from "../mode.js";
import { assertOcrPageReaderConfiguration, assertVisionPageReaderConfiguration, ocrPageReaderMode, visionPageReaderMode } from "../page-reader-mode.js";
import { readPageRouterMode } from "../../config.js";

// #502: DOCSLURP_DISABLE switches only lower, and a switch never turns into a startup refusal (an emergency kill switch
// must not take the worker down): with the reader switched off its readiness checks are not needed.
afterEach(() => resetExtractorPluginsForTest());

describe("DOCSLURP_DISABLE in the OCR readers", () => {
  it("page-reader, ai and ocr turn the OCR page reader off; page-reader and ai turn the vision reader off", () => {
    for (const mode of ["all", "escalation"]) {
      expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: mode })).toBe(mode);
      for (const token of ["page-reader", "ai", "ocr", "AI , ocr"]) {
        expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: mode, DOCSLURP_DISABLE: token }), token).toBe("off");
      }
    }
    expect(visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "all" })).toBe("all");
    expect(visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "all", DOCSLURP_DISABLE: "page-reader" })).toBe("off");
    expect(visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "all", DOCSLURP_DISABLE: "ai" })).toBe("off");
    // Unrelated switches leave it alone; an unknown value is still refused.
    expect(visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "all", DOCSLURP_DISABLE: "charts" })).toBe("all");
    expect(() => ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: "maybe", DOCSLURP_DISABLE: "page-reader" })).toThrow(/must be one of/);
  });

  it("the switches stand the readers down without a startup refusal (no provider needed)", () => {
    expect(() => assertOcrPageReaderConfiguration({ DOCSLURP_OCR_PAGE_READER: "all", DOCSLURP_DISABLE: "page-reader" }, "vm")).not.toThrow();
    expect(() => assertOcrPageReaderConfiguration({ DOCSLURP_OCR_PAGE_READER: "all" }, "vm")).toThrow(/needs a page image reader plugin/);
    expect(() => assertVisionPageReaderConfiguration({ DOCSLURP_VISION_PAGE_READER: "all", DOCSLURP_DISABLE: "ai" })).not.toThrow();
    // ocr off with the reader configured: the mode check passes (no OCR pages to read) instead of refusing.
    expect(assertOcrConfiguration({ DOCSLURP_OCR_MODE: "local", DOCSLURP_OCR_PAGE_READER: "all", DOCSLURP_DISABLE: "ocr" })).toBe("off");
  });

  it("ai-escalation and ai turn escalation off; nothing turns it on", () => {
    expect(ocrEscalationEnabled({ DOCSLURP_OCR_ESCALATION: "on" })).toBe(true);
    expect(ocrEscalationEnabled({ DOCSLURP_OCR_ESCALATION: "on", DOCSLURP_DISABLE: "ai-escalation" })).toBe(false);
    expect(ocrEscalationEnabled({ DOCSLURP_OCR_ESCALATION: "on", DOCSLURP_DISABLE: "ai" })).toBe(false);
    expect(ocrEscalationEnabled({ DOCSLURP_OCR_ESCALATION: "on", DOCSLURP_DISABLE: "unknown-token" })).toBe(false);
    for (const disable of ["", "ocr", "router", "charts"]) {
      expect(ocrEscalationEnabled({ DOCSLURP_DISABLE: disable })).toBe(false);
    }
  });

  it("leaves the page router reader itself unchanged (config.ts and run creation apply the router switch)", () => {
    expect(readPageRouterMode("active")).toBe("active");
    // config.ts reads the switch from process.env; the reader itself is unchanged.
    expect(readPageRouterMode("off")).toBe("off");
  });
});
