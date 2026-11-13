import { describe, expect, it, vi } from "vitest";
import { boundedRasterDpi, boundedRasterEdge, longEdgeCappedDpi, longEdgeCappedEdge } from "./raster-bounds.js";
import { renderPagesNative } from "../native-pdf/render.js";
describe("pixel allocation bounds", () => {
  it.each([[612,792], [100000,100000], [100000,1200], [1200,100000], [50000,60000]])("bounds a %s × %s point page before allocation", (w,h) => {
    const dpi = boundedRasterDpi(w,h,300);
    const width = Math.ceil(w*dpi/72), height = Math.ceil(h*dpi/72);
    expect(Math.max(width,height)).toBeLessThanOrEqual(4096);
    expect(width*height).toBeLessThanOrEqual(16000000);
    expect(dpi).toBeLessThanOrEqual(300);
  });
  it("preserves requested reader and export DPI for normal pages", () => {
    expect(boundedRasterDpi(612,792,200)).toBe(200);
    expect(boundedRasterDpi(612,792,300)).toBe(300);
  });
  it.each([0,-1,NaN,Infinity])("rejects invalid dimensions %s", value => {
    expect(() => boundedRasterDpi(value,792,300)).toThrow("Invalid");
  });
  it("caps the renderer independently of aspect ratio or size/render disagreement", () => {
    expect(boundedRasterEdge(100000, 1200, 300)).toBe(4000);
    expect(boundedRasterEdge(100, 100, 300)).toBe(417);
    expect(boundedRasterEdge(612, 792, 300)).toBe(3300);
  });
  it("passes the bounded DPI to the native engine before its render call", async () => {
    const render = vi.fn(async () => Buffer.from("png"));
    const close = vi.fn();
    const engine = { openPath: async () => ({ close, page: () => ({ size: async () => ({ widthPt: 100000, heightPt: 100000 }), render }) }) };
    await renderPagesNative(engine as never,"huge.pdf",[3],{dpi:300});
    expect(render).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dpi: boundedRasterDpi(100000,100000,300), maxEdgePx: boundedRasterEdge(100000,100000,300), format: "png" }));
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("long-edge cap for profiled vision models", () => {
  it("lowers the DPI so a page's longest edge renders at most the cap, and never raises it", () => {
    const dpi = longEdgeCappedDpi(612, 792, 300, 2_048);
    expect(Math.ceil(792 * dpi / 72)).toBeLessThanOrEqual(2_048);
    expect(longEdgeCappedEdge(612, 792, dpi, 2_048)).toBe(2_048);
    expect(longEdgeCappedDpi(612, 792, 150, 2_048)).toBe(150);
    expect(longEdgeCappedDpi(1_224, 792, 300, 1_540)).toBeCloseTo(1_540 * 72 / 1_224, 9);
    expect(longEdgeCappedDpi(612, 792, 300)).toBe(boundedRasterDpi(612, 792, 300));
  });
  it("keeps the pixel bounds on huge pages and refuses a non-integer cap", () => {
    expect(longEdgeCappedDpi(100000, 100000, 300, 2_048)).toBeLessThanOrEqual(boundedRasterDpi(100000, 100000, 300));
    expect(() => longEdgeCappedDpi(612, 792, 300, 0)).toThrow("maxLongEdgePx");
    expect(() => longEdgeCappedDpi(612, 792, 300, 1.5)).toThrow("maxLongEdgePx");
  });
  it("renders native pages at the capped DPI and reports it for area billing", async () => {
    const render = vi.fn(async () => Buffer.from("png"));
    const engine = { openPath: async () => ({ close: vi.fn(), page: () => ({ size: async () => ({ widthPt: 612, heightPt: 792 }), render }) }) };
    const out = await renderPagesNative(engine as never, "a.pdf", [1], { dpi: 300, maxLongEdgePx: 2_048 });
    const dpi = longEdgeCappedDpi(612, 792, 300, 2_048);
    expect(render).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dpi, maxEdgePx: 2_048 }));
    expect(out.get(1)!.dpi).toBe(dpi);
  });
});
