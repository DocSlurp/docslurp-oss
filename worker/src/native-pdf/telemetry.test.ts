import { afterEach, describe, expect, it, vi } from "vitest";

import { assertNativePdfEngineAtStartup, nativePdfEngineRequired, setNativePdfEngineForTesting } from "./loader.js";
import { reportExtractionDecision, summarizeNativePdfShadow, type NativePdfStageStats } from "./telemetry.js";
import { logNativePdfFallback, NativePdfError } from "./types.js";

afterEach(() => {
  setNativePdfEngineForTesting(null);
  vi.restoreAllMocks();
});

const baseStats = (overrides: Partial<NativePdfStageStats> = {}): NativePdfStageStats => ({
  mode: "shadow",
  engine: "loaded",
  engineSource: "vendor:test",
  engineVersion: "0.13.0+abc",
  engineUnavailableReason: null,
  shadow: { status: "ran", reason: null, agreement: 0.98, nativeMs: 12 },
  parserPayload: { status: "native", reason: null },
  ...overrides,
});

describe("nativePdfEngineRequired", () => {
  it("requires the engine when the image ships it or a mode uses it", () => {
    expect(nativePdfEngineRequired({ DOCSLURP_NATIVE_PDF_INSTALLED: "1" })).toBe(true);
    expect(nativePdfEngineRequired({ DOCSLURP_PDF_ENGINE: "shadow" })).toBe(true);
    expect(nativePdfEngineRequired({ DOCSLURP_PDF_ENGINE: "native-pdf" })).toBe(true);
    expect(nativePdfEngineRequired({})).toBe(false);
    expect(nativePdfEngineRequired({ DOCSLURP_PDF_ENGINE: "off" })).toBe(false);
  });
});

describe("assertNativePdfEngineAtStartup", () => {
  it("fails startup when a required engine is missing", async () => {
    setNativePdfEngineForTesting("binding not found");
    await expect(assertNativePdfEngineAtStartup({ DOCSLURP_NATIVE_PDF_INSTALLED: "1" })).rejects.toThrow(/required.*binding not found/);
  });

  it("starts without the engine when nothing asks for it", async () => {
    setNativePdfEngineForTesting("binding not found");
    await expect(assertNativePdfEngineAtStartup({})).resolves.toMatchObject({ ok: false });
  });
});

describe("summarizeNativePdfShadow", () => {
  it("reads agreement and timing from the document row", () => {
    expect(summarizeNativePdfShadow([
      { scope: "page", stageName: "extract-markdown", metric: "native-pdf-shadow", value: 0.5, unit: "agreement", tags: [], pageNumber: 1 },
      { scope: "document", stageName: "extract-markdown", metric: "native-pdf-shadow", value: 0.97, unit: "agreement", tags: [], metadata: { nativeMs: 40 } },
    ])).toEqual({ status: "ran", reason: null, agreement: 0.97, nativeMs: 40 });
  });

  it("reports a failed shadow with its code", () => {
    expect(summarizeNativePdfShadow([
      { scope: "document", stageName: "extract-markdown", metric: "native-pdf-shadow", value: 0, unit: "error", tags: [], metadata: { code: "NATIVE_PDF_LIMIT", reason: "too big" } },
    ])).toMatchObject({ status: "failed", reason: "NATIVE_PDF_LIMIT: too big" });
  });

  it("never reports an empty shadow as success", () => {
    expect(summarizeNativePdfShadow([]).status).toBe("failed");
  });
});

describe("reportExtractionDecision", () => {
  const decision = {
    documentId: "doc-1",
    format: "pdf",
    extractor: "kreuzberg",
    strategy: "kreuzberg-solo",
    extractorOrder: ["kreuzberg", "native-pdf", "poppler-text"],
    attempted: ["kreuzberg"],
    unavailable: [],
  };

  it("logs the decision at info when native-pdf took part", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    reportExtractionDecision({ ...decision, nativePdf: baseStats() });
    expect(warn).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toMatch(/extractor=kreuzberg .*nativePdf=loaded@0\.13\.0\+abc mode=shadow shadow=ran/);
  });

  it("warns when native-pdf was expected but neither served nor shadowed the document", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    reportExtractionDecision({
      ...decision,
      nativePdf: baseStats({ engine: "unavailable", engineVersion: null, shadow: { status: "skipped", reason: "engine unavailable", agreement: null, nativeMs: null } }),
    });
    expect(warn.mock.calls[0]![0]).toMatch(/shadow=skipped\(engine unavailable\)/);
  });
});

describe("logNativePdfFallback", () => {
  it("names the next step instead of assuming kreuzberg", () => {
    const error = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logNativePdfFallback("extract", new NativePdfError("NATIVE_PDF_EMPTY", "no text"));
    const line = [...error.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join("\n");
    expect(line).toMatch(/extract fell back code=NATIVE_PDF_EMPTY .*next=next-in-order/);
  });
});

describe("untrusted error text", () => {
  const hostile = "PDF_ERROR bad object\n[extract] document=forged extractor=native-pdf\r\u001b[31m\u2028tail";

  it("stdout stays one physical line", async () => {
    const { oneLine } = await import("./telemetry.js");
    expect(oneLine(hostile)).not.toMatch(/[\n\r\u001b\u2028]/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    reportExtractionDecision({
      documentId: "doc-1", format: "pdf", extractor: "kreuzberg", strategy: "kreuzberg-solo",
      extractorOrder: ["kreuzberg"], attempted: ["kreuzberg"], unavailable: [],
      nativePdf: baseStats({ shadow: { status: "failed", reason: hostile, agreement: null, nativeMs: null } }),
    });
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/[\n\r\u001b\u2028]/);
  });

  it("keeps the raw text for operators in stage stats", () => {
    const summary = summarizeNativePdfShadow([
      { scope: "document", stageName: "extract-markdown", metric: "native-pdf-shadow", value: 0, unit: "error", tags: [], metadata: { code: "NATIVE_PDF_FAILED", reason: hostile } },
    ]);
    expect(summary.reason).toBe(`NATIVE_PDF_FAILED: ${hostile}`);
  });

  it("never reaches end users through public diagnostics", async () => {
    const { publicDiagnostics } = await import("@docslurp/shared");
    const stats = {
      strategy: "kreuzberg-solo",
      error: hostile,
      nativePdf: baseStats({ shadow: { status: "failed", reason: hostile, agreement: null, nativeMs: null } }),
    };
    expect(JSON.stringify(publicDiagnostics(stats))).not.toContain("bad object");
  });

  it("telemetry never throws into the pipeline", () => {
    vi.spyOn(console, "log").mockImplementation(() => { throw new Error("stdout closed"); });
    expect(() => reportExtractionDecision({
      documentId: "doc-1", format: "pdf", extractor: "kreuzberg", strategy: "kreuzberg-solo",
      extractorOrder: [], attempted: [], unavailable: [], nativePdf: baseStats(),
    })).not.toThrow();
  });
});
