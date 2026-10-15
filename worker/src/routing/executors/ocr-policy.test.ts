import { describe, expect, it } from "vitest";

import { applyNativePdfEngineEnv } from "../../native-pdf/loader.js";
import { withNativeOcrSlot } from "./deps.js";
import { nativeOcrDropout, otherScriptShare, wordLikeShare } from "./ocr-policy.js";

describe("ocr policy helpers", () => {
  it("measures other-script letters", () => {
    expect(otherScriptShare("hello world")).toBe(0);
    expect(otherScriptShare("契約書 contract")).toBeCloseTo(3 / 11, 5);
    expect(otherScriptShare("12 34 --")).toBe(0);
  });

  it("scores word-shaped tokens and abstains on short text", () => {
    expect(wordLikeShare("too short")).toBe(1);
    expect(wordLikeShare(Array(30).fill("Revenue grew strongly").join(" "))).toBe(1);
    expect(wordLikeShare(Array(30).fill("RZBEFEEZNE ZHIMRAT").join(" "))).toBe(0);
  });

  it("guards against dropout by layer, cross-check and density", () => {
    const text = (n: number) => "x".repeat(n);
    expect(nativeOcrDropout({ output: text(100), layerChars: 400, pageAreaIn2: null, crossCheckChars: null })).toEqual({ ok: false, reason: "below-text-layer" });
    expect(nativeOcrDropout({ output: text(100), layerChars: 0, pageAreaIn2: 93.5, crossCheckChars: 3000 })).toEqual({ ok: false, reason: "below-cross-check" });
    expect(nativeOcrDropout({ output: text(400), layerChars: 0, pageAreaIn2: 93.5, crossCheckChars: null })).toMatchObject({ ok: false, reason: "low-density" });
    expect(nativeOcrDropout({ output: text(2000), layerChars: 0, pageAreaIn2: 93.5, crossCheckChars: null })).toEqual({ ok: true });
    expect(nativeOcrDropout({ output: "契".repeat(500), layerChars: 0, pageAreaIn2: 93.5, crossCheckChars: null })).toEqual({ ok: true });
    expect(nativeOcrDropout({ output: text(30), layerChars: 40, pageAreaIn2: null, crossCheckChars: null })).toEqual({ ok: true });
  });

  it("bounds engine OCR concurrency to one per process by default", async () => {
    let active = 0;
    let peak = 0;
    const job = () => withNativeOcrSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    await Promise.all([job(), job(), job(), job()]);
    expect(peak).toBe(1);
  });

  it("defaults the engine's OCR concurrency to 1", () => {
    const target: NodeJS.ProcessEnv = {};
    applyNativePdfEngineEnv({}, target);
    expect(target.PDFUST_OCR_MAX_CONCURRENT).toBe("1");
  });
});
