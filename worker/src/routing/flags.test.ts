import { describe, expect, it } from "vitest";

import { DEFAULT_LABELER_MODEL, readRoutingFlags } from "./flags.js";

describe("routing flags", () => {
  it("defaults every flag to off / built-in values", () => {
    expect(readRoutingFlags({})).toEqual({
      disableNonFreeSoftware: false,
      tableGate: "off",
      preferNativeMarkdown: false,
      probeEngine: "python",
      nativeOcr: "scripts",
      labelerModel: DEFAULT_LABELER_MODEL,
      modelPricesPath: null,
      healthHistoryPath: null,
      localDecisionSidecarCmd: null,
    });
  });

  it("accepts the documented values case-insensitively", () => {
    const flags = readRoutingFlags({
      PAGE_ROUTER_TABLE_GATE: "SHADOW",
      PAGE_ROUTER_PREFER_NATIVE_MARKDOWN: "True",
      PAGE_PROBE_ENGINE: "Native-PDF",
      NATIVE_PDF_OCR: "Prefer",
      PAGE_ROUTER_LABELER_MODEL: " org/labeler ",
      PAGE_ROUTER_MODEL_PRICES_PATH: "/tmp/prices.json",
      DOCSLURP_DECISION_HEALTH_HISTORY: "/tmp/h.json",
      DECISION_LOCAL_SIDECAR_CMD: "python sidecar.py",
    });
    expect(flags).toMatchObject({ tableGate: "shadow", preferNativeMarkdown: true, probeEngine: "native-pdf", nativeOcr: "prefer", labelerModel: "org/labeler" });
    expect(flags.modelPricesPath).toBe("/tmp/prices.json");
    expect(flags.healthHistoryPath).toBe("/tmp/h.json");
    expect(flags.localDecisionSidecarCmd).toBe("python sidecar.py");
  });

  it("treats typos, unknown values and blanks as off / default", () => {
    const flags = readRoutingFlags({
      PAGE_ROUTER_TABLE_GATE: "shadwo",
      PAGE_ROUTER_PREFER_NATIVE_MARKDOWN: "yes",
      PAGE_PROBE_ENGINE: "native",
      NATIVE_PDF_OCR: "always",
      PAGE_ROUTER_LABELER_MODEL: "  ",
      PAGE_ROUTER_MODEL_PRICES_PATH: "",
    });
    expect(flags).toMatchObject({ tableGate: "off", preferNativeMarkdown: false, probeEngine: "python", nativeOcr: "scripts", labelerModel: DEFAULT_LABELER_MODEL, modelPricesPath: null });
  });

  it("reads DISABLE_NON_FREE_SOFTWARE: default false, 1/true on, typo false", () => {
    expect(readRoutingFlags({}).disableNonFreeSoftware).toBe(false);
    expect(readRoutingFlags({ DISABLE_NON_FREE_SOFTWARE: "true" }).disableNonFreeSoftware).toBe(true);
    expect(readRoutingFlags({ DISABLE_NON_FREE_SOFTWARE: "1" }).disableNonFreeSoftware).toBe(true);
    expect(readRoutingFlags({ DISABLE_NON_FREE_SOFTWARE: "false" }).disableNonFreeSoftware).toBe(false);
    expect(readRoutingFlags({ DISABLE_NON_FREE_SOFTWARE: "tru" }).disableNonFreeSoftware).toBe(false);
  });
});
